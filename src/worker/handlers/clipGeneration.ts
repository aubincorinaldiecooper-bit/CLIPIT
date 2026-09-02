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
import { withTransaction } from '../../db/pool.js';
import { getClip, setClipStatus, restoreClipBoundaries } from '../../db/repositories/clips.js';
import { commitRender } from '../../db/repositories/verticalMedia.js';
import { discardUploadedObjects } from '../../services/media/verticalPipeline.js';
import { releaseObjects, renderDeliveredMedia } from '../../services/media/rerender.js';
import { discardVariants } from '../../db/repositories/clipVariants.js';
import { getVideo } from '../../db/repositories/videos.js';
import type { ClipGenerationJob } from '../../queues/index.js';

/** Every storage key the clip's row names right now. */
async function keysNamedByRow(clipId: string): Promise<Set<string>> {
  const current = await getClip(clipId);
  return new Set(
    [current?.storageKey, current?.posterStorageKey, current?.derivativeStorageKey]
      .filter((key): key is string => typeof key === 'string' && key.length > 0),
  );
}

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
      // Everything this render uploaded: on a failure, whatever the row does
      // not name goes, and the previous cut and media stay exactly as they
      // were. A first render's plain key is in the list too — a cut whose
      // row never came to name it would otherwise sit in storage for good.
      const fresh = [key, ...(delivered?.freshKeys ?? [])];
      const context = { videoId: video.id, clipId };
      // Platform shapes cut from the master this render replaces. Their rows
      // go inside the transaction; their files, after it.
      let staleVariantKeys: string[] = [];
      try {
        await getStorage().uploadFile(key, outputPath, 'video/mp4');

        // ONE transaction. The row takes the new cut and the media made
        // from it — a Replace's spec included — the platform shapes cut from
        // the OLD master go (posting one would send footage the person just
        // replaced), and a Re-clip's next version is recorded with its
        // pending state cleared: together, or not at all. As separate writes
        // a failure after the first left a row naming a new cut whose
        // history still said the re-cut had failed.
        await withTransaction(async (client) => {
          const wrote = await commitRender(clipId, {
            storageKey: key,
            durationSeconds: Number(result.durationSeconds.toFixed(3)),
            sizeBytes: result.sizeBytes,
            captions: job.data.captions,
            media: delivered?.media ?? { kind: 'none' },
          }, client);
          if (!wrote) {
            throw new Error(`Clip ${clipId} no longer exists — its render has nowhere to be recorded`);
          }
          if (job.data.captions !== undefined || job.data.reclip !== undefined) {
            staleVariantKeys = (await discardVariants(clipId, client)) ?? [];
          }
          if (job.data.reclip) {
            const { matchId, startSeconds, endSeconds, provider, model, promptVersion } = job.data.reclip;
            await appendReclipVersion({ matchId, startSeconds, endSeconds, provider, model, promptVersion }, client);
            await clearReclipPending(matchId, client);
          }
        });
      } catch (error) {
        // The write's outcome may be unknown: a connection can drop after
        // COMMIT, and then the row names every fresh key while this promise
        // rejected. So the row is asked before anything is deleted, and what
        // it names, this render keeps.
        const named = await keysNamedByRow(clipId).catch((readError: unknown) => {
          log.error('the render\'s write failed and the row could not be read; keeping this render\'s objects', {
            ...context, keys: fresh, err: readError,
          });
          return null;
        });
        if (named === null) throw error;
        // The row naming this render's key proves the write landed only when
        // the key is NEW to the row: a first render at the plain key, on a
        // row that already named that key from an earlier attempt, proves
        // nothing either way — so that is treated as the failure it reported,
        // and the object the row still names is kept.
        const landed = named.has(key) && clip.storageKey !== key;
        if (landed) {
          // It landed; only the reply was lost. Carry on as committed.
          log.warn('the render\'s write landed although its reply did not; carrying on as committed', { ...context, err: error });
        } else {
          await discardUploadedObjects(fresh.filter((freshKey) => !named.has(freshKey)), { ...context, reason: 'render_commit_failed' });
          throw error;
        }
      }

      // Committed. The previous objects go only now — after everything that
      // could still fail has succeeded — so a failure anywhere above leaves
      // the old cut and its media where the row can still name them.
      await releaseObjects(
        [render ? clip.storageKey : null, ...(delivered?.oldKeys ?? []), ...staleVariantKeys],
        [key, ...(delivered?.freshKeys ?? [])],
        context,
        log,
      );
      if (job.data.reclip) {
        const { matchId, startSeconds, endSeconds } = job.data.reclip;
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
