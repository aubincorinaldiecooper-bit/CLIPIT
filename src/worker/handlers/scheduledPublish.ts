import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { ScheduledPublishJob } from '../../queues/index.js';
import {
  CLAIM_QUARANTINE_MS,
  claimScheduledPost,
  getScheduledPost,
  markScheduledPostFailed,
  markScheduledPostFired,
} from '../../db/repositories/scheduledPosts.js';
import { enqueueScheduledPublish } from '../../queues/index.js';
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
  // another worker holds all fail it.
  const claimed = await claimScheduledPost(scheduledPostId);
  if (!claimed) {
    // A row still inside its quarantine is the one case where "not
    // claimable" does not mean "nothing to do". BullMQ retries a stalled
    // job well before the quarantine expires (its lock is minutes, the
    // quarantine is ten), so THIS run is the retry — and if it just
    // returned, no later run would exist and a promise whose worker died
    // mid-fire would sit in 'firing' forever. Re-arm the alarm for when
    // the quarantine lifts, and the claim will succeed then.
    const existing = await getScheduledPost(scheduledPostId);
    if (existing?.status === 'firing') {
      const readyAt = new Date((existing.claimed_at?.getTime() ?? Date.now()) + CLAIM_QUARANTINE_MS + 1000);
      await enqueueScheduledPublish({ scheduledPostId }, readyAt).catch((cause) =>
        logger.error('could not re-arm a quarantined scheduled publish', { scheduledPostId, err: cause }),
      );
      logger.info('scheduled publish re-armed past quarantine', {
        scheduledPostId,
        readyAt: readyAt.toISOString(),
      });
      return;
    }
    logger.info('scheduled publish skipped — not claimable', { scheduledPostId, status: existing?.status });
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
    // The post rows ride along: a shape still being cut can still fail,
    // and the listing reads THEM rather than trusting 'fired' as success.
    await markScheduledPostFired(scheduledPostId, posts.map((post) => post.id));
    logger.info('scheduled publish fired', { scheduledPostId, clipId: claimed.clip_id, posts: posts.length });
  } catch (cause) {
    const message = cause instanceof Error && cause.message ? cause.message : 'The publish could not be submitted.';
    await markScheduledPostFailed(scheduledPostId, message);
    logger.error('scheduled publish failed', { scheduledPostId, clipId: claimed.clip_id, err: cause });
  }
}
