import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { clipKey } from '../../services/storage/types.js';
import { cutClip, ffprobe } from '../../services/media/ffmpeg.js';
import { appendReclipVersion, clearReclipPending, markReclipFailed } from '../../db/repositories/reclips.js';
import { captionsSchema, prepareCaptionFilters } from '../../services/media/captions.js';
import { applyClipPadding } from '../../services/timestamps.js';
import { getClip, setClipStatus, restoreClipBoundaries } from '../../db/repositories/clips.js';
import { commitRender } from '../../db/repositories/verticalMedia.js';
import { discardUploadedObjects } from '../../services/media/verticalPipeline.js';
import { releaseObjects, renderDeliveredMedia } from '../../services/media/rerender.js';
import { discardVariants } from '../../db/repositories/clipVariants.js';
import { getVideo } from '../../db/repositories/videos.js';
import type { ClipGenerationJob } from '../../queues/index.js';

/**
 * Cuts a match out of the ORIGINAL source (never the analysis proxy) and stores
 * the result as MP4 / H.264 / AAC.
 */
export async function handleClipGeneration(job: Job<ClipGenerationJob>): Promise<void> {
  const { clipId } = job.data;
  const log = logger.child({ job: 'clip-generation', clipId });

  const clip = await getClip(clipId);
  if (!clip) {
    log.warn('clip no longer exists, dropping job');
    return;
  }
  // Re-render jobs (a Replace, or a Re-clip applying new boundaries) carry
  // their intent in the job and must run even against a finished clip; only
  // a plain generation of an already-finished clip is a duplicate worth
  // skipping.
  if (clip.status === 'ready' && clip.storageKey && job.data.captions === undefined && job.data.reclip === undefined) {
    log.info('clip already generated, skipping');
    return;
  }

  const video = await getVideo(clip.videoId);
  if (!video?.originalStorageKey) {
    await setClipStatus(clipId, 'failed', { errorMessage: 'Source video is no longer available' });
    return;
  }

  await setClipStatus(clipId, 'generating');
  await job.updateProgress({ stage: 'generating', percent: 10 });

  try {
    // Widen the match slightly so the moment is not clipped off at either edge.
    const padded = applyClipPadding(
      { startSeconds: clip.startSeconds, endSeconds: clip.endSeconds },
      {
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        videoDurationSeconds: video.durationSeconds ?? Number.POSITIVE_INFINITY,
        minDurationSeconds: env.MIN_CLIP_SECONDS,
        maxDurationSeconds: env.MAX_CLIP_SECONDS,
      },
    );

    await withWorkDir(`clip-${clipId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await getStorage().downloadToFile(video.originalStorageKey!, sourcePath);
      await job.updateProgress({ stage: 'cutting', percent: 40 });

      // Captions are burned during the cut, sized against the real frame.
      // A Replace carries its spec in the job (the row keeps the old one
      // until this render succeeds); everything else renders the row's. The
      // spec is re-validated here so a hand-edited row cannot smuggle text
      // into a shell command.
      let videoFilters: string[] | undefined;
      const spec = captionsSchema.safeParse(job.data.captions ?? clip.captions ?? []);
      if (spec.success && spec.data.length > 0) {
        const probe = await ffprobe(sourcePath);
        videoFilters = await prepareCaptionFilters(spec.data, dir, {
          videoWidth: probe.width ?? Math.round(((probe.height ?? 720) * 16) / 9),
          videoHeight: probe.height ?? 720,
        });
      }

      const outputPath = path.join(dir, `${clipId}.mp4`);
      const result = await cutClip({
        inputPath: sourcePath,
        outputPath,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        hasAudio: video.hasAudio ?? true,
        ...(videoFilters ? { videoFilters } : {}),
      });

      // A re-render puts a different file under the same clip id. Its bytes
      // go to a FRESH key beside the old ones, so the working clip is never
      // overwritten before the row accepts the new one; a first render keeps
      // the plain key it always had.
      const rerender = clip.storageKey !== null && (job.data.captions !== undefined || job.data.reclip !== undefined);
      const render = rerender ? randomUUID().slice(0, 8) : undefined;

      // The card's picture — and for a vertical moment the 9:16 file — were
      // made from the cut, so they are made again from THIS one, first, at
      // fresh keys too. If any of it fails, nothing has been replaced yet and
      // the failure below rolls this render back like any other.
      const delivered = await renderDeliveredMedia({
        clip,
        videoId: video.id,
        canonicalPath: outputPath,
        workDir: dir,
        hasAudio: video.hasAudio ?? true,
        cut: result,
        render,
        log,
      });

      await job.updateProgress({ stage: 'uploading', percent: 80 });

      const key = clipKey(video.id, clipId, render);
      // Everything this render made and nothing else: on a failure these go
      // and the previous cut and media stay exactly as they were.
      const fresh = [...(render ? [key] : []), ...(delivered?.freshKeys ?? [])];
      try {
        await getStorage().uploadFile(key, outputPath, 'video/mp4');

        // ONE row write: the cut and the media made from it become the row's
        // truth together — a Replace's spec included — or not at all.
        const wrote = await commitRender(clipId, {
          storageKey: key,
          durationSeconds: Number(result.durationSeconds.toFixed(3)),
          sizeBytes: result.sizeBytes,
          captions: job.data.captions,
          media: delivered?.media ?? { kind: 'none' },
        });
        if (!wrote) {
          throw new Error(`Clip ${clipId} no longer exists — its render has nowhere to be recorded`);
        }
      } catch (error) {
        await discardUploadedObjects(fresh, { videoId: video.id, clipId, reason: 'render_commit_failed' });
        throw error;
      }

      // The row names the new cut and its media; the previous objects go.
      await releaseObjects(
        [render ? clip.storageKey : null, ...(delivered?.oldKeys ?? [])],
        [key, ...(delivered?.freshKeys ?? [])],
        { videoId: video.id, clipId },
        log,
      );

      // The master changed, so every platform shape cut from the OLD master
      // is stale — posting one would send footage the user just replaced.
      // They re-render on the next publish that needs them. True for a
      // caption Replace and for a Re-clip alike: both put a different
      // master under the same clip id.
      if (job.data.captions !== undefined || job.data.reclip !== undefined) {
        await discardVariants(clipId);
      }

      // A Re-clip becomes true only here, with the file that carries its
      // boundaries stored: the moment's next version is recorded and the
      // pending state clears. Doing this earlier would let a failed render
      // leave the history claiming boundaries no file ever had.
      if (job.data.reclip) {
        const { matchId, startSeconds, endSeconds, provider, model, promptVersion } = job.data.reclip;
        await appendReclipVersion({ matchId, startSeconds, endSeconds, provider, model, promptVersion });
        await clearReclipPending(matchId);
        log.info('reclip applied', { matchId, startSeconds, endSeconds });
      }

      log.info('clip generated', {
        key,
        // Both ranges make boundary problems diagnosable from one log line.
        // With the default zero padding they are identical; an intentional
        // deployment override remains visible instead of silently changing
        // what the timestamps on screen mean.
        requestedStartSeconds: clip.startSeconds,
        requestedEndSeconds: clip.endSeconds,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        requestedDurationSeconds: Number((clip.endSeconds - clip.startSeconds).toFixed(3)),
        renderedDurationSeconds: Number(result.durationSeconds.toFixed(3)),
        sizeBytes: result.sizeBytes,
      });
      await job.updateProgress({ stage: 'ready', percent: 100 });
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('clip generation failed', { err: error });

    // A Re-clip render that has spent its last attempt rolls the WHOLE
    // re-evaluation back: the clip returns to exactly the boundaries, edit
    // mark and status the person could see, no version is recorded, and the
    // failure lands where they can read it. Intermediate attempts change
    // nothing — the retry runs with the new boundaries still in place.
    if (job.data.reclip) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) {
        const previous = job.data.reclip.previous;
        await restoreClipBoundaries(clipId, {
          startSeconds: previous.startSeconds,
          endSeconds: previous.endSeconds,
          boundariesEditedAt: previous.boundariesEditedAt ? new Date(previous.boundariesEditedAt) : null,
          status: previous.status,
        });
        await markReclipFailed(
          job.data.reclip.matchId,
          'The re-cut could not be rendered. The original clip is untouched — try again.',
        );
      }
      throw error;
    }

    if (clip.storageKey) {
      // A re-render failed, but the clip it was replacing still exists and
      // still plays. Marking it 'failed' would delete a working clip from
      // the library and every room it was shared into — so it goes back to
      // 'ready', file, spec and all, with the failure recorded on it for
      // the editor to report.
      await setClipStatus(clipId, 'ready', { errorMessage: message });
    } else {
      await setClipStatus(clipId, 'failed', { errorMessage: message });
    }
    throw error;
  }
}
