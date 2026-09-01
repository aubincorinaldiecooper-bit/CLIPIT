import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { isSupportedYoutubeUrl } from '../../services/media/ytdlp.js';
import { getStorage } from '../../services/storage/s3.js';
import { expireVideoFootage } from '../../services/retention.js';
import { originalKey, sanitizeFilename } from '../../services/storage/types.js';
import {
  createVideo,
  getVideo,
  getVideoWithReadProgress,
  listChunks,
  listVideosForPrincipal,
  setVideoStatus,
  updateVideoMedia,
} from '../../db/repositories/videos.js';
import {
  createClipRequest,
  listClipRequestsForVideo,
  listMatches,
} from '../../db/repositories/clipRequests.js';
import { listClipsForRequest } from '../../db/repositories/clips.js';
import { enqueueClipSearch, enqueueIngestion } from '../../queues/index.js';
import { warmMiniCpm } from '../../services/search/minicpmVideo.js';
import { assertOwnership, ownerScope, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import {
  creatorVisibleMatches,
  serializeClipRequest,
  serializeVideo,
  serializeVideoWithPlayback,
  videoPosterUrl,
} from '../serializers.js';
import type { Clip } from '../../domain/types.js';
import { parse } from '../validation.js';

const uuidSchema = z.string().uuid('must be a UUID');

/**
 * One presigned PUT tops out at 5GB — S3's own ceiling for a single request —
 * so anything bigger is uploaded in parts. The threshold sits under the
 * ceiling to keep a margin, and the part size keeps the part count small
 * enough to presign in one response.
 */
const SINGLE_PUT_MAX_BYTES = 4.5 * 1024 * 1024 * 1024;
const PART_SIZE_BYTES = 512 * 1024 * 1024;
/** Six hours of high-bitrate footage with room to spare. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024 * 1024;

const createVideoSchema = z.discriminatedUnion('sourceType', [
  z.object({
    sourceType: z.literal('youtube'),
    url: z.string().trim().min(1, 'url is required'),
  }),
  z.object({
    sourceType: z.literal('upload'),
    filename: z.string().trim().min(1, 'filename is required').max(255),
    contentType: z.string().trim().max(120).optional(),
    /** Announced so the server can decide single-PUT versus part-by-part. */
    sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),
  }),
]);

const partUrlSchema = z.object({
  uploadId: z.string().trim().min(1).max(2048),
  partNumber: z.number().int().min(1).max(10000),
  /** The exact bytes of this slice; signed into the URL, never larger than a slice. */
  contentLength: z.number().int().positive().max(PART_SIZE_BYTES),
});

const completeMultipartSchema = z.object({
  uploadId: z.string().trim().min(1).max(2048),
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10000),
        etag: z.string().trim().min(1).max(256),
      }),
    )
    .min(1)
    .max(10000),
});

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
      if (!env.YOUTUBE_INGESTION_ENABLED) {
        throw HttpError.badRequest('YouTube links are not accepted right now — upload the video file instead');
      }
      if (!isSupportedYoutubeUrl(body.url)) {
        throw HttpError.badRequest('url must be a public YouTube video URL');
      }

      const video = await createVideo({
        sessionId,
        userId: request.principal?.userId ?? null,
        // Uploads land in the person's own library, always. A shared room
      // holds clips people send it, never videos.
        workspaceId: request.principal?.ownWorkspaceId ?? null,
        sourceType: 'youtube',
        sourceUrl: body.url,
        status: 'queued',
      });

      await enqueueIngestion({ videoId: video.id });
      // Not awaited: the GPU takes tens of seconds to come back from zero,
      // and that wait belongs to the download, not to this response.
      void warmMiniCpm('youtube-queued');
      logger.info('youtube video queued', { videoId: video.id });

      return reply.code(201).send({ video: serializeVideo(video) });
    }

    const filename = sanitizeFilename(body.filename);
    const contentType = resolveContentType(filename, body.contentType);

    const video = await createVideo({
      sessionId,
      userId: request.principal?.userId ?? null,
      // Uploads land in the person's own library, always. A shared room
      // holds clips people send it, never videos.
      workspaceId: request.principal?.ownWorkspaceId ?? null,
      sourceType: 'upload',
      originalFilename: filename,
      title: filename,
      status: 'pending_upload',
    });

    const key = originalKey(video.id, filename);
    await updateVideoMedia(video.id, { originalStorageKey: key });

    // The earliest honest signal that someone is about to need the GPU: the
    // upload target exists, and not one byte has been sent yet. On a large
    // file that is minutes of runway, which is more than the cold start
    // needs. Not awaited — reserving an upload must never wait on Modal.
    void warmMiniCpm('upload-reserved');

    // Big files go in pieces: a single presigned PUT cannot carry more than
    // 5GB, and six hours of real footage is far past that.
    if (body.sizeBytes && body.sizeBytes > SINGLE_PUT_MAX_BYTES) {
      const storage = getStorage();
      const uploadId = await storage.createMultipartUpload(key, contentType);
      const partCount = Math.ceil(body.sizeBytes / PART_SIZE_BYTES);
      logger.info('multipart upload reserved', { videoId: video.id, key, partCount });
      return reply.code(201).send({
        video: serializeVideo({ ...video, originalStorageKey: key }),
        upload: {
          method: 'PUT' as const,
          // No URLs here: each part's URL is asked for just before it is
          // sent (POST /:videoId/part-url). Presigning the whole set up
          // front gave every URL the same clock, and any upload slower than
          // that expiry was stranded mid-file with no way to refresh.
          multipart: {
            uploadId,
            partSizeBytes: PART_SIZE_BYTES,
            partCount,
          },
          storageKey: key,
          headers: {},
          expiresInSeconds: env.UPLOAD_URL_EXPIRY_SECONDS,
          instructions: `For each ${PART_SIZE_BYTES}-byte slice, POST /api/videos/${video.id}/part-url for a fresh URL, PUT the slice, collect the ETag; then POST /api/videos/${video.id}/complete-multipart before /uploaded`,
        },
      });
    }

    const upload = await issueUploadUrl(video.id, filename, contentType);
    logger.info('upload reserved', { videoId: video.id, key });

    return reply.code(201).send({
      video: serializeVideo({ ...video, originalStorageKey: key }),
      upload,
    });
  });

  /**
   * A fresh URL for one numbered part, signed the moment it is needed. The
   * part's exact byte length is signed in, so storage refuses any other size
   * — the ceiling cannot be stretched a part at a time.
   */
  app.post('/api/videos/:videoId/part-url', { preHandler: requireSession }, async (request, reply) => {
    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');
    const body = parse(partUrlSchema, request.body);

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');
    if (video.sourceType !== 'upload') throw HttpError.conflict('This video was not created as an upload');
    if (!video.originalStorageKey) throw HttpError.conflict('This video has no reserved upload location');

    const url = await getStorage().createPartUploadUrl(
      video.originalStorageKey,
      body.uploadId,
      body.partNumber,
      body.contentLength,
    );
    return reply.send({ url });
  });

  /**
   * Walks away from a part-by-part upload cleanly. Parts already in storage
   * are stored and billed until aborted — DeleteObject cannot reach them —
   * so the browser calls this when an upload fails or is abandoned, and a
   * bucket lifecycle rule sweeps whatever nobody aborted.
   */
  app.post('/api/videos/:videoId/abort-multipart', { preHandler: requireSession }, async (request, reply) => {
    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');
    const body = parse(z.object({ uploadId: z.string().trim().min(1).max(2048) }), request.body);

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');
    if (!video.originalStorageKey) throw HttpError.conflict('This video has no reserved upload location');

    await getStorage().abortMultipartUpload(video.originalStorageKey, body.uploadId);
    logger.info('multipart upload aborted', { videoId });
    return reply.send({ ok: true });
  });

  /**
   * Seals a part-by-part upload: storage stitches the numbered pieces into
   * one object. Only then is POST /:videoId/uploaded meaningful.
   */
  app.post('/api/videos/:videoId/complete-multipart', { preHandler: requireSession }, async (request, reply) => {
    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');
    const body = parse(completeMultipartSchema, request.body);

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');
    if (video.sourceType !== 'upload') throw HttpError.conflict('This video was not created as an upload');
    if (!video.originalStorageKey) throw HttpError.conflict('This video has no reserved upload location');

    await getStorage().completeMultipartUpload(video.originalStorageKey, body.uploadId, body.parts);
    logger.info('multipart upload completed', { videoId, parts: body.parts.length });
    return reply.send({ ok: true });
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
      // The new key's object does not exist until the client PUTs it, so the
      // byte-confirmation marker is cleared — playback stays null until the
      // replacement upload is confirmed.
      await updateVideoMedia(existing.id, { originalStorageKey: key, originalFilename: filename, sizeBytes: null });

      return reply.send({
        video: serializeVideo({ ...existing, originalStorageKey: key, originalFilename: filename, sizeBytes: null }),
        upload: await issueUploadUrl(existing.id, filename, contentType),
      });
    }

    const video = await createVideo({
      sessionId,
      userId: request.principal?.userId ?? null,
      // Uploads land in the person's own library, always. A shared room
      // holds clips people send it, never videos.
      workspaceId: request.principal?.ownWorkspaceId ?? null,
      sourceType: 'upload',
      originalFilename: filename,
      title: filename,
      status: 'pending_upload',
    });

    const key = originalKey(video.id, filename);
    await updateVideoMedia(video.id, { originalStorageKey: key });

    // The earliest honest signal that someone is about to need the GPU: the
    // upload target exists, and not one byte has been sent yet. On a large
    // file that is minutes of runway, which is more than the cold start
    // needs. Not awaited — reserving an upload must never wait on Modal.
    void warmMiniCpm('upload-reserved');

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

    // The ceiling, enforced against what storage actually holds — the one
    // measurement a client cannot shape. An announced size only chooses the
    // upload path; an object past the limit is removed, not ingested.
    if (object.sizeBytes > MAX_UPLOAD_BYTES) {
      await getStorage().remove(video.originalStorageKey).catch(() => {});
      await setVideoStatus(videoId, 'failed', 'The uploaded file is larger than the 64GB limit.');
      throw HttpError.conflict('The uploaded file is larger than the 64GB limit.');
    }

    await updateVideoMedia(videoId, { sizeBytes: object.sizeBytes });
    await setVideoStatus(videoId, 'queued');
    await enqueueIngestion({ videoId });
    logger.info('upload completed, ingestion queued', { videoId, sizeBytes: object.sizeBytes });

    const updated = await getVideo(videoId);
    return reply.send({ video: serializeVideo(updated!) });
  });

  /**
   * Removes a video's footage on request.
   *
   * The same removal the hourly sweep performs when a session goes quiet, done
   * now because someone asked. Deliberately not a row delete: the question they
   * asked, the moments found and their thumbs up or down are kept, because
   * those are how we learn whether our reading of a video is any good. The
   * bytes — original, small copy, segments, clips, stills, notes and transcript
   * — are gone.
   */
  app.delete('/api/videos/:videoId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');

    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    const result = await expireVideoFootage(videoId, logger.child({ route: 'delete-video', videoId }));

    return reply.send({
      videoId,
      removed: true,
      objectsDeleted: result.objectsDeleted,
      // Named rather than hidden: a file we could not delete is one the person
      // was told was gone.
      objectsFailed: result.objectsFailed,
    });
  });

  /**
   * The caller's videos, newest first.
   *
   * For a signed-in person this spans every session they have ever had, which
   * is the point of signing in: close the browser, come back tomorrow, and the
   * videos are still theirs. For a guest it is only what this tab uploaded.
   * Footage already removed is excluded — a library of unplayable entries is
   * a list of disappointments.
   */
  app.get('/api/videos', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const videos = await listVideosForPrincipal(ownerScope(request));

    // Each row carries its own poster frame, so the library shows the footage
    // rather than a list of filenames.
    return reply.send({
      videos: await Promise.all(
        videos.map(async (video) => ({
          ...serializeVideo(video),
          posterUrl: await videoPosterUrl(video),
        })),
      ),
    });
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
    //
    // Read with the note progress: this is the route the client polls, and how
    // far the notes reach is the one honest thing it can show while a video is
    // being read.
    const video = await getVideoWithReadProgress(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    const chunks = video.status === 'ready' ? await listChunks(videoId) : [];
    return reply.send({ video: await serializeVideoWithPlayback(video, chunks) });
  });

  /**
   * Restores the conversation for a video, including found moments and any
   * clips already cut from them. The database is the source of truth: leaving
   * the page no longer means the browser has to remember every request id in
   * order to put the chat back together.
   */
  app.get('/api/videos/:videoId/clip-requests', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { videoId } = parse(z.object({ videoId: uuidSchema }), request.params, 'path parameters');
    const video = await getVideo(videoId);
    if (!video) throw HttpError.notFound('Video not found');
    assertOwnership(request, video, 'Video');

    const history = await listClipRequestsForVideo(videoId);
    const clipRequests = await Promise.all(
      history.map(async (clipRequest) => {
        const [allMatches, allClips] = await Promise.all([
          listMatches(clipRequest.id),
          listClipsForRequest(clipRequest.id),
        ]);
        const clipsByMatchId = new Map<string, Clip>(allClips.map((clip) => [clip.clipMatchId, clip]));
        // Same gate as the request route. History is still a creator-facing
        // view, and an unfinished moment must not reappear in it just
        // because it is being read from a different page.
        const { matches } = creatorVisibleMatches(allMatches, clipsByMatchId);
        return serializeClipRequest(clipRequest, matches, clipsByMatchId);
      }),
    );

    return reply.send({ clipRequests });
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
      userId: request.principal?.userId ?? null,
      instruction: body.instruction,
      mode: body.mode ?? env.CLIP_SEARCH_MODE,
    });

    await enqueueClipSearch({ clipRequestId: clipRequest.id });
    logger.info('clip search queued', { clipRequestId: clipRequest.id, videoId });

    return reply.code(202).send({ clipRequest: await serializeClipRequest(clipRequest, []) });
  });
}
