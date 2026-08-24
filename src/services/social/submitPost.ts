import { logger } from '../../lib/logger.js';
import { getStorage } from '../storage/s3.js';
import { zernio, ZernioApiError } from '../zernio/client.js';
import { updatePublishedPost } from '../../db/repositories/social.js';

/**
 * Hand one recorded post to the publishing service.
 *
 * Shared by the publish route (when the file already exists) and the
 * reframe worker (when the file had to be cut first): however long the
 * middle takes, the record was written before anything external happened,
 * so a post the service accepts is never one CLIPIT has no memory of.
 */
export async function submitRecordedPost(input: {
  postId: string;
  caption: string;
  targets: Array<{ platform: string; accountId: string }>;
  storageKey: string;
}): Promise<{ status: string }> {
  // A fresh signed URL minted at submission time: the publishing service
  // downloads the file server-side, so the API never proxies the bytes.
  //
  // A failure HERE is definite: nothing has been sent, so there is no post
  // out in the world to be ambiguous about. Marking it failed is honest and
  // — since the render job completes either way — it is the only chance to
  // say so. Leaving it 'rendering' would be endless progress for work that
  // never started.
  let mediaUrl: string;
  try {
    mediaUrl = await getStorage().createDownloadUrl(input.storageKey);
  } catch (cause) {
    await updatePublishedPost(input.postId, { zernioPostId: null, status: 'failed' });
    throw cause;
  }

  let created;
  try {
    created = await zernio.createPost({
      content: input.caption,
      platforms: input.targets,
      mediaUrls: [mediaUrl],
      publishNow: true,
    });
  } catch (cause) {
    // From here the outcome is genuinely uncertain. A definite rejection
    // (the service answered "no") frees the clip for another try; anything
    // else — a timeout, a dropped response — leaves the row as it was, so
    // the in-flight guard holds until it ages out. The service may have
    // accepted the post and lost the answer, and a retry would put a
    // duplicate in front of someone's audience.
    if (cause instanceof ZernioApiError) {
      await updatePublishedPost(input.postId, { zernioPostId: null, status: 'failed' });
    }
    throw cause;
  }

  const updated = await updatePublishedPost(input.postId, {
    zernioPostId:
      (typeof created.id === 'string' && created.id) ||
      (typeof created.postId === 'string' && created.postId) ||
      null,
    status: typeof created.status === 'string' ? created.status : 'submitted',
  });

  logger.info('post submitted', { postId: input.postId, targets: input.targets.length });
  return { status: updated?.status ?? 'submitted' };
}
