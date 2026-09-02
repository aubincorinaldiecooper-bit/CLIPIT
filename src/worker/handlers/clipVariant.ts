import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { cutClip, ffprobe } from '../../services/media/ffmpeg.js';
import { captionsSchema, prepareCaptionFilters } from '../../services/media/captions.js';
import { planReframe } from '../../services/media/reframe.js';
import { applyClipPadding } from '../../services/timestamps.js';
import { getClip } from '../../db/repositories/clips.js';
import { setVariantStatus } from '../../db/repositories/clipVariants.js';
import { getVideo } from '../../db/repositories/videos.js';
import type { ClipVariantJob } from '../../queues/index.js';
import { listPostsWaitingOnVariant, updatePublishedPost } from '../../db/repositories/social.js';
import { submitRecordedPost } from '../../services/social/submitPost.js';
import { ZernioApiError } from '../../services/zernio/client.js';

/**
 * Cuts one clip to one platform's shape.
 *
 * Like every other render in CLIPIT this starts from the PRISTINE ORIGINAL,
 * never from the clip's own file: cropping an already-cropped, already-
 * captioned MP4 would compound the encode and could not put the captions
 * where they belong on the new frame. The order inside the filter chain is
 * what makes that work — crop first, then draw the text, so a caption at
 * 85% of the height is 85% of the frame that will actually be posted.
 */
export async function handleClipVariant(job: Job<ClipVariantJob>): Promise<void> {
  const { clipId, variantId, aspect, focusPct } = job.data;
  const log = logger.child({ job: 'clip-variant', clipId, variantId, aspect });

  /**
   * A render that cannot happen must say so to every post waiting on it.
   * Leaving one 'rendering' forever would be progress reported for work
   * that stopped — the exact absence-as-progress this codebase forbids.
   */
  const failWaitingPosts = async () => {
    for (const post of await listPostsWaitingOnVariant(variantId)) {
      await updatePublishedPost(post.id, { zernioPostId: null, status: 'failed' });
    }
  };

  const clip = await getClip(clipId);
  if (!clip) {
    log.warn('clip no longer exists, dropping job');
    await setVariantStatus(variantId, 'failed', { errorMessage: 'The clip no longer exists' });
    await failWaitingPosts();
    return;
  }

  const video = await getVideo(clip.videoId);
  if (!video?.originalStorageKey) {
    // The footage this shape would be cut from is gone. Say which one thing
    // is missing rather than letting a publish fail with nothing to read.
    await setVariantStatus(variantId, 'failed', {
      errorMessage: 'The source footage for this clip has been removed, so it cannot be reframed',
    });
    await failWaitingPosts();
    return;
  }

  await setVariantStatus(variantId, 'rendering');
  await job.updateProgress({ stage: 'rendering', percent: 10 });

  try {
    const padded = applyClipPadding(
      { startSeconds: clip.startSeconds, endSeconds: clip.endSeconds },
      {
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        videoDurationSeconds: video.durationSeconds ?? Number.POSITIVE_INFINITY,
        minDurationSeconds: env.MIN_CLIP_SECONDS,
        maxDurationSeconds: env.MAX_CLIP_SECONDS,
      },
    );

    await withWorkDir(`variant-${variantId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await getStorage().downloadToFile(video.originalStorageKey!, sourcePath);
      await job.updateProgress({ stage: 'cutting', percent: 40 });

      const probe = await ffprobe(sourcePath);
      const plan = planReframe(
        { aspect, focusPct },
        {
          width: probe.width ?? 0,
          height: probe.height ?? 0,
        },
      );

      const videoFilters: string[] = [];
      if (plan.filter) videoFilters.push(plan.filter);

      // Captions are sized and placed against the CROPPED frame — the one
      // the viewer will see — which is why the crop is already in the chain.
      const spec = captionsSchema.safeParse(clip.captions ?? []);
      if (spec.success && spec.data.length > 0) {
        const captionFilters = await prepareCaptionFilters(spec.data, dir, {
          videoWidth: plan.outputWidth,
          videoHeight: plan.outputHeight,
        });
        videoFilters.push(...captionFilters);
      }

      const outputPath = path.join(dir, `${variantId}.mp4`);
      const result = await cutClip({
        inputPath: sourcePath,
        outputPath,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        hasAudio: video.hasAudio ?? true,
        ...(videoFilters.length > 0 ? { videoFilters } : {}),
      });

      await job.updateProgress({ stage: 'uploading', percent: 80 });
      // The key carries this ROW's id. A shape discarded by a re-render and
      // asked for again is a new row; when its key was only the shape and
      // framing, the new file landed exactly where the discarded one had
      // been — and the discarded one's queued release then took the new
      // file with it. A retry of this same row keeps its own key.
      const key = `clips/${clip.videoId}/${clipId}/${aspect.replace(':', 'x')}-${Math.round(focusPct)}-${variantId.slice(0, 8)}.mp4`;
      await getStorage().uploadFile(key, outputPath, 'video/mp4');

      // The FILE's dimensions, not the plan's. The cut caps the shorter side
      // at CLIP_MAX_SHORT_SIDE after the crop, so a 9:16 region of a 4K
      // source is planned at 1215x2160 and delivered at 1080x1920; storing
      // the plan would hand every consumer a size the object does not have.
      await setVariantStatus(variantId, 'ready', {
        storageKey: key,
        width: result.width,
        height: result.height,
        sizeBytes: result.sizeBytes,
      });

      log.info('clip variant rendered', {
        key,
        width: result.width,
        height: result.height,
        plannedWidth: plan.outputWidth,
        plannedHeight: plan.outputHeight,
        sizeBytes: result.sizeBytes,
      });
      await job.updateProgress({ stage: 'ready', percent: 100 });

      // Publishes queued this render mid-act: finish the act, for EVERY post
      // that pointed itself at this render — not just the one whose request
      // happened to queue the job. Two publishes racing onto the same shape
      // render once between them, and both still go out.
      for (const post of await listPostsWaitingOnVariant(variantId)) {
        try {
          const targets = Array.isArray(post.targets)
            ? (post.targets as Array<{ platform: string; accountId: string }>)
            : [];
          await submitRecordedPost({
            postId: post.id,
            caption: post.caption,
            targets,
            storageKey: key,
          });
        } catch (error) {
          // submitRecordedPost already marked a DEFINITE rejection failed.
          // Anything else is ambiguous — the service may have accepted the
          // post and lost the response — so the row keeps its guarded state
          // rather than being marked failed and retried into a public
          // duplicate. The guard ages out on its own.
          if (!(error instanceof ZernioApiError)) {
            log.error('post submission after reframe is ambiguous', { postId: post.id, err: error });
          } else {
            log.error('post submission after reframe failed', { postId: post.id, err: error });
          }
        }
      }
    });
  } catch (error) {
    // The variant is its own row, so a failed reframe never touches the clip
    // itself: the original is still there, still postable as it was shot.
    await setVariantStatus(variantId, 'failed', { errorMessage: errorMessage(error) });
    // Only when the queue is done retrying: a post failed on attempt one
    // would refuse its own submission when attempt two succeeds. And a post
    // left 'rendering' forever would be progress reported for work that
    // stopped — the failure has to reach the record someone will look at.
    const attemptsAllowed = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attemptsAllowed) {
      await failWaitingPosts();
    }
    log.error('clip variant failed', { err: error });
    throw error;
  }
}
