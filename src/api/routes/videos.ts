import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isSupportedYoutubeUrl } from '../../services/media/ytdlp.js';
import { getStorage } from '../../services/storage/s3.js';
import { originalKey, sanitizeFilename } from '../../services/storage/types.js';
import { createVideo, getVideo, listChunks, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';
import { createClipRequest } from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, enqueueIngestion } from '../../queues/index.js';
import { assertOwnership, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import { serializeClipRequest, serializeVideo } from '../serializers.js';
import { parse } from '../validation.js';

const uuidSchema = z.string().uuid('must be a UUID');

const createVideoSchema = z.discriminatedUnion('sourceType', [
  z.object({
    sourceType: z.literal('youtube'),
    url: z.string().trim().min(1, 'url is required'),
  }),
  z.object({
    sourceType: z.literal('upload'),
    filename: z.string().trim().min(1, 'filename is required').max(255),
    contentType: z.string().trim().max(120).optional(),
  }),
]);

const uploadUrlSchema = z.object({
  filename: z.string().trim().min(1, 'filename is required').max(255),
  contentType: z.string().trim().max(120).optional(),
  /** Reissue an upload URL for a video that was already created. */
  videoId: uuidSchema.optional(),
});

const clipRequestSchema = z.object({
  instruction: z
    .string()
    .trim()
    .min(3, 'instruction must be at least 3 characters')
    .max(2000, 'instruction must be at most 2000 characters'),
  mode: z.enum(['auto', 'visual', 'transcript', 'both']).optional(),
});

function resolveContentType(filename: string, provided?: string): string {
  if (provided) return provided;
  const extension = filename.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    m4v: 'video/x-m4v',
  };
  return map[extension] ?? 'video/mp4';
}

async function issueUploadUrl(videoId: string, filename: string, contentType: string) {
  const key = originalKey(videoId, filename);
  const url = await getStorage().createUploadUrl(key, contentType);
  return {
    method: 'PUT' as const,
    url,
    storageKey: key,
    headers: { 'Content-Type': contentType },
    expiresInSeconds: env.UPLOAD_URL_EXPIRY_SECONDS,
    instructions: `PUT the file to this URL with the Content-Type header above, then call POST /api/videos/${videoId}/uploaded`,
  };
}

export async function registerVideoRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Creates a video from a YouTube URL, or reserves one for a direct upload.
   * Uploads are handed a presigned PUT URL so large files never pass through
   * this server.
   */
  app.post('/api/videos', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'videos',
        perSession: env.RATE_LIMIT_VIDEOS_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_VIDEOS_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const body = parse(createVideoSchema, request.body);
    const sessionId = request.principal?.sessionId ?? null;

    if (body.sourceType === 'youtube') {
      if (!isSupportedYoutubeUrl(body.url)) {
        throw HttpError.badRequest('url must be a public YouTube video URL');
      }

      const video = await createVideo({
        sessionId,
        sourceType: 'youtube',
        sourceUrl: body.url,
        status: 'queued',
      });

      await enqueueIngestion({ videoId: video.id });
      logger.info('youtube video queued', { videoId: video.id });

      return reply.code(201).send({ video: serializeVideo(video) });
    }

    const filename = sanitizeFilename(body.filename);
    const contentType = resolveContentType(filename, body.contentType);

    const video = await createVideo({
      sessionId,
      sourceType: 'upload',
      originalFilename: filename,
      title: filename,
      status: 'pending_upload',
    });

    const key = originalKey(video.id, filename);
    await updateVideoMedia(video.id, { originalStorageKey: key });

    const upload = await issueUploadUrl(video.id, filename, contentType);
    logger.info('upload reserved', { videoId: video.id, key });

    return reply.code(201).send({
      video: serializeVideo({ ...video, originalStorageKey: key }),
      upload,
    });
  });

  /** Issues (or reissues) a presigned upload URL. */
  app.post('/api/videos/upload-url', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'videos',
        perSession: env.RATE_LIMIT_VIDEOS_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_VIDEOS_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const body = parse(uploadUrlSchema, request.body);
    const filename = sanitizeFilename(body.filename);
    const contentType = resolveContentType(filename, body.contentType);
    const sessionId = request.principal?.sessionId ?? null;

    if (body.videoId) {
      const existing = await getVideo(body.videoId);
      if (!existing) throw HttpError.notFound('Video not found');
      assertOwnership(request, existing, 'Video');

      if (existing.sourceType !== 'upload') {
        throw HttpError.conflict('This video was not created as an upload');
      }
      if (existing.status !== 'pending_upload' && existing.status !== 'failed') {
        throw HttpError.conflict(`Video is already ${existing.status}`);
      }

      const key = originalKey(existing.id, filename);
      await updateVideoMedia(existing.id, { originalStorageKey: key, originalFilename: filename });

      return reply.send({
        video: serializeVideo({ ...existing, originalStorageKey: key, originalFilename: filename }),
        upload: await issueUploadUrl(existing.id, filename, contentType),
      });
    }

    const video = await createVideo({
      sessionId,
      sourceType: 'upload',
      originalFilename: filename,
      title: filename,
      status: 'pending_upload',
    });

    const key = originalKey(video.id, filename);
    await updateVideoMedia(video.id, { originalStorageKey: key });

    return reply.code(201).send({
      video: serializeVideo({ ...video, originalStorageKey: key }),
      upload: await issueUploadUrl(video.id, filename, contentType),
    });
  });

  /** Called once the presigned PUT has completed; starts the pipeline. */
  app.post('/api/videos/:videoId/uploaded', { preHandler: requireSession }, async (request, reply) => {
    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    if (video.sourceType !== 'upload') throw HttpError.conflict('This video was not created as an upload');
    if (!video.originalStorageKey) throw HttpError.conflict('This video has no reserved upload location');

    if (video.status !== 'pending_upload' && video.status !== 'failed') {
      // Already moving through the pipeline; report current state instead of re-queueing.
      return reply.send({ video: serializeVideo(video) });
    }

    const object = await getStorage().head(video.originalStorageKey);
    if (!object) {
      throw HttpError.conflict('No uploaded file found at the reserved location — complete the upload first');
    }

    await updateVideoMedia(videoId, { sizeBytes: object.sizeBytes });
    await setVideoStatus(videoId, 'queued');
    await enqueueIngestion({ videoId });
    logger.info('upload completed, ingestion queued', { videoId, sizeBytes: object.sizeBytes });

    const updated = await getVideo(videoId);
    return reply.send({ video: serializeVideo(updated!) });
  });

  /** Status, metadata, and the analysis chunk grid. */
  app.get('/api/videos/:videoId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');

    // This route is a pure read. Ingestion starts only through the explicit
    // POST /api/videos/:videoId/uploaded, so polling for status never has a
    // side effect and there is exactly one path into the pipeline.
    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    const chunks = video.status === 'ready' ? await listChunks(videoId) : [];
    return reply.send({ video: serializeVideo(video, chunks) });
  });

  /**
   * Starts a search. The instruction is free-form natural language and is
   * passed to the model verbatim — there are no predefined clip categories.
   */
  app.post('/api/videos/:videoId/clip-requests', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'search',
        perSession: env.RATE_LIMIT_SEARCH_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_SEARCH_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');
    const body = parse(clipRequestSchema, request.body);

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    if (video.status !== 'ready') {
      throw HttpError.conflict(
        video.status === 'failed'
          ? `Video processing failed: ${video.errorMessage ?? 'unknown error'}`
          : `Video is not ready for search yet (status: ${video.status})`,
      );
    }

    const clipRequest = await createClipRequest({
      videoId,
      sessionId: request.principal?.sessionId ?? null,
      instruction: body.instruction,
      mode: body.mode ?? env.CLIP_SEARCH_MODE,
    });

    await enqueueClipSearch({ clipRequestId: clipRequest.id });
    logger.info('clip search queued', { clipRequestId: clipRequest.id, videoId });

    return reply.code(202).send({ clipRequest: serializeClipRequest(clipRequest, []) });
  });
}
