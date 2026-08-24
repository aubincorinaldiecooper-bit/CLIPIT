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
  const mediaUrl = await getStorage().createDownloadUrl(input.storageKey);

  let created;
  try {
    created = await zernio.createPost({
      content: input.caption,
      platforms: input.targets,
      mediaUrls: [mediaUrl],
      publishNow: true,
    });
  } catch (cause) {
    // A definite rejection frees the clip for another try. Anything
    // ambiguous (timeout, dropped response) leaves the row as it was, so
    // the in-flight guard holds until it ages out — the service may have
    // posted it.
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
