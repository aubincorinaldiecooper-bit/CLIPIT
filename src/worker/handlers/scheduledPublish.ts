import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { ScheduledPublishJob } from '../../queues/index.js';
import {
  claimScheduledPost,
  markScheduledPostFailed,
  markScheduledPostFired,
} from '../../db/repositories/scheduledPosts.js';
import { executeClipPublish } from '../../services/social/publishClip.js';
import { zernioConfigured } from '../../services/zernio/client.js';

/**
 * The chosen minute has arrived: keep the promise.
 *
 * Everything about the publish is re-read from the row and re-validated by
 * executeClipPublish — the same act an immediate publish runs, hours later.
 * Every outcome lands back on the row: 'fired' when the submission went out,
 * 'failed' with a human-readable reason when it could not. The handler never
 * throws upward on a publish failure, because this queue runs single-attempt
 * on purpose (a blind retry could double-post to a real audience) and the
 * row, not the job, is the record the person will read.
 */
export async function handleScheduledPublish(job: Job<ScheduledPublishJob>): Promise<void> {
  const { scheduledPostId } = job.data;

  // The claim is the gate: a canceled promise, one already kept, or one
  // another worker holds all fail it, and the alarm rings into a no-op.
  const claimed = await claimScheduledPost(scheduledPostId);
  if (!claimed) {
    logger.info('scheduled publish skipped — not claimable', { scheduledPostId });
    return;
  }

  if (!zernioConfigured()) {
    await markScheduledPostFailed(scheduledPostId, 'Publishing is not configured on this deployment.');
    logger.error('scheduled publish failed — zernio unconfigured', { scheduledPostId });
    return;
  }

  try {
    const posts = await executeClipPublish({
      userId: claimed.user_id,
      workspaceId: claimed.workspace_id,
      clipId: claimed.clip_id,
      caption: claimed.caption,
      accountIds: claimed.account_ids.length > 0 ? claimed.account_ids : null,
    });
    await markScheduledPostFired(scheduledPostId);
    logger.info('scheduled publish fired', { scheduledPostId, clipId: claimed.clip_id, posts: posts.length });
  } catch (cause) {
    const message = cause instanceof Error && cause.message ? cause.message : 'The publish could not be submitted.';
    await markScheduledPostFailed(scheduledPostId, message);
    logger.error('scheduled publish failed', { scheduledPostId, clipId: claimed.clip_id, err: cause });
  }
}
