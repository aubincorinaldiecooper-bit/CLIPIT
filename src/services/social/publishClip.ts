import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getClip } from '../../db/repositories/clips.js';
import {
  findInFlightPublish,
  insertPublishedPost,
  listSocialAccounts,
  updatePublishedPost,
} from '../../db/repositories/social.js';
import { getVideo } from '../../db/repositories/videos.js';
import { claimVariant } from '../../db/repositories/clipVariants.js';
import { aspectOfSource, groupTargetsByShape } from '../media/platformShapes.js';
import { enqueueClipVariant } from '../../queues/index.js';
import { submitRecordedPost } from './submitPost.js';

/**
 * The act of publishing one clip, complete: resolve the accounts, group them
 * by the file shape each platform wants, write the record, then submit or
 * queue the cut. Moved out of the route unchanged so a scheduled publish is
 * the SAME act run later — not a second implementation that drifts.
 *
 * Failures are thrown as HttpError: the route passes them to the client
 * as-is; the scheduled-fire worker records `.message` on the promise row.
 * Every message here is already written for a person, which is exactly what
 * both callers need.
 *
 * Validation is done HERE, at execution time, even for inputs a scheduler
 * checked hours ago: an account can disconnect and a clip can vanish between
 * a promise and its fire, and posting through a stale snapshot of either
 * would act on someone's real audience with yesterday's permissions.
 */

/**
 * How long a 'submitting' record blocks a re-publish of the same clip. Long
 * enough to absorb a double-click or an automatic retry after a dropped
 * response; short enough that a genuinely stuck submission doesn't lock the
 * clip out of publishing forever.
 */
export const PUBLISH_RETRY_GUARD_SECONDS = 2 * 60;

export interface PublishedPostSummary {
  id: string;
  clipId: string;
  status: string;
  targets: Array<{ platform: string; accountId: string }>;
  aspect: string;
  createdAt: string;
}

export async function executeClipPublish(input: {
  userId: string;
  workspaceId: string;
  clipId: string;
  caption: string;
  accountIds?: string[] | null;
}): Promise<PublishedPostSummary[]> {
  const { userId, workspaceId, clipId } = input;

  // Publishing acts inside one room: the clip and the accounts it goes to
  // must both belong to the workspace the caller is working in.
  const clip = await getClip(clipId);
  if (!clip || clip.workspaceId !== workspaceId) throw HttpError.notFound('Clip not found');
  if (clip.status !== 'ready' || !clip.storageKey) {
    throw HttpError.conflict('This clip is not ready yet — publish it once it has finished cutting');
  }

  const stored = (await listSocialAccounts(workspaceId)).filter((account) => account.status === 'connected');
  if (stored.length === 0) {
    throw HttpError.unprocessable('No connected accounts. Connect one on the Publishing page first.');
  }

  let targets = stored;
  if (input.accountIds?.length) {
    const wanted = new Set(input.accountIds);
    targets = stored.filter((account) => wanted.has(account.id));
    if (targets.length !== wanted.size) {
      throw HttpError.badRequest('Some accountIds are not your connected accounts');
    }
  }

  // The record is written BEFORE the external call, so a post Zernio
  // accepts can never be one CLIPIT has no memory of. A retry that arrives
  // while a submission for this clip is still in flight (or whose outcome
  // was lost) is refused instead of duplicated on every account.
  const inFlight = await findInFlightPublish(userId, clipId, PUBLISH_RETRY_GUARD_SECONDS);
  if (inFlight) {
    throw HttpError.conflict(
      'This clip was already submitted moments ago. Check your accounts before publishing it again.',
    );
  }

  // Each platform gets the SHAPE it wants — a 16:9 concert clip goes to
  // TikTok as a 9:16 cut, to a YouTube upload as itself — and the person
  // pressing Publish never has to know that. The publishing service takes
  // one file per post, so targets wanting different shapes become separate
  // posts, each carrying its own correctly-cut file.
  const video = await getVideo(clip.videoId);
  const sourceAspect = aspectOfSource(video?.width ?? null, video?.height ?? null);
  const targetList = targets.map((account) => ({ platform: account.platform, accountId: account.id }));
  const groups = groupTargetsByShape(targetList, sourceAspect);

  const posts: PublishedPostSummary[] = [];

  for (const group of groups) {
    // A shaped group claims its render BEFORE the record is written, so
    // the record can carry which render it waits on — that link is what
    // lets a second publish racing onto the same render still be
    // submitted when the one render finishes.
    const claimed = group.aspect === null ? null : await claimVariant(clipId, group.aspect, clip.focusPct);

    const post = await insertPublishedPost({
      userId,
      workspaceId,
      clipId,
      zernioPostId: null,
      caption: input.caption,
      targets: group.targets,
      status: 'submitting',
      variantId: claimed?.variant.id ?? null,
    });

    if (group.aspect === null) {
      // The clip as shot is the right file — submit it now.
      const { status } = await submitRecordedPost({
        postId: post.id,
        caption: input.caption,
        targets: group.targets,
        storageKey: clip.storageKey,
      });
      posts.push({
        id: post.id,
        clipId,
        status,
        targets: group.targets,
        aspect: 'source',
        createdAt: post.created_at.toISOString(),
      });
      continue;
    }

    // This shape needs a cut. If a file for exactly this shape and framing
    // already exists, post it now; otherwise mark the post as waiting and
    // queue the render — the worker submits every waiting post the moment
    // the file is ready. Pressing Publish stays ONE act either way.
    const variant = claimed!.variant;
    if (variant.status === 'ready' && variant.storageKey) {
      const { status } = await submitRecordedPost({
        postId: post.id,
        caption: input.caption,
        targets: group.targets,
        storageKey: variant.storageKey,
      });
      posts.push({
        id: post.id,
        clipId,
        status,
        targets: group.targets,
        aspect: group.aspect,
        createdAt: post.created_at.toISOString(),
      });
      continue;
    }

    await updatePublishedPost(post.id, { zernioPostId: null, status: 'rendering' });
    await enqueueClipVariant({
      clipId,
      variantId: variant.id,
      aspect: group.aspect,
      focusPct: clip.focusPct,
      postId: post.id,
    });
    logger.info('clip publish waiting on reframe', {
      clipId,
      aspect: group.aspect,
      variantId: variant.id,
      claimedFresh: claimed!.created,
    });
    posts.push({
      id: post.id,
      clipId,
      status: 'rendering',
      targets: group.targets,
      aspect: group.aspect,
      createdAt: post.created_at.toISOString(),
    });
  }

  logger.info('clip publish submitted', { clipId, targets: targets.length, posts: posts.length });
  return posts;
}
