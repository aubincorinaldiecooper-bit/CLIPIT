import { env } from '../config/env.js';
import { getStorage } from '../services/storage/s3.js';
import { formatTimecode } from '../services/timestamps.js';
import type { ChunkFailureCode, Clip, ClipMatch, ClipRequest, Video, VideoChunk } from '../domain/types.js';

/** Shapes rows into the public API representation. Storage keys never leak. */

export interface VideoProgress {
  stage: string;
  percent: number;
  message: string;
}

function videoProgress(video: Video): VideoProgress {
  switch (video.status) {
    case 'pending_upload':
      return { stage: 'pending_upload', percent: 0, message: 'Waiting for the upload to complete' };
    case 'queued':
      return { stage: 'queued', percent: 5, message: 'Queued for ingestion' };
    case 'ingesting':
      return { stage: 'ingesting', percent: 20, message: 'Fetching the source media' };
    case 'preprocessing':
      return { stage: 'preprocessing', percent: 60, message: 'Building the analysis proxy and chunks' };
    case 'ready':
      return { stage: 'ready', percent: 100, message: 'Ready for clip searches' };
    case 'failed':
      return { stage: 'failed', percent: 0, message: video.errorMessage ?? 'Processing failed' };
    default:
      return { stage: video.status, percent: 0, message: '' };
  }
}

export function serializeVideo(video: Video, chunks?: VideoChunk[]) {
  return {
    id: video.id,
    sourceType: video.sourceType,
    sourceUrl: video.sourceUrl,
    title: video.title,
    originalFilename: video.originalFilename,
    status: video.status,
    error: video.errorMessage,
    progress: videoProgress(video),
    durationSeconds: video.durationSeconds,
    durationTimecode: video.durationSeconds !== null ? formatTimecode(video.durationSeconds) : null,
    sizeBytes: video.sizeBytes,
    width: video.width,
    height: video.height,
    fps: video.fps,
    videoCodec: video.videoCodec,
    audioCodec: video.audioCodec,
    hasAudio: video.hasAudio,
    chunkSeconds: video.chunkSeconds,
    chunkCount: video.chunkCount,
    readyForSearch: video.status === 'ready',
    transcript: {
      status: video.transcriptStatus,
      source: video.transcriptSource,
      segmentCount: video.transcriptSegmentCount,
      error: video.transcriptError,
    },
    index: {
      status: video.indexStatus,
      sceneCount: video.sceneCount,
      error: video.indexError,
    },
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
    ...(chunks
      ? {
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            index: chunk.chunkIndex,
            globalStartSeconds: chunk.globalStartSeconds,
            globalEndSeconds: chunk.globalEndSeconds,
            durationSeconds: chunk.durationSeconds,
          })),
        }
      : {}),
  };
}

export function serializeMatch(match: ClipMatch, clip?: Clip | null) {
  return {
    id: match.id,
    chunkId: match.chunkId,
    startSeconds: match.globalStartSeconds,
    endSeconds: match.globalEndSeconds,
    startTimecode: formatTimecode(match.globalStartSeconds),
    endTimecode: formatTimecode(match.globalEndSeconds),
    durationSeconds: Number((match.globalEndSeconds - match.globalStartSeconds).toFixed(3)),
    localStartSeconds: match.localStartSeconds,
    localEndSeconds: match.localEndSeconds,
    description: match.description,
    confidence: match.confidence,
    source: match.source,
    quote: match.quote,
    clip: clip ? { id: clip.id, status: clip.status } : null,
  };
}

export interface ClipRequestProgress {
  stage: string;
  percent: number;
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  message: string;
}

/**
 * Which parts of the video were never examined, and why.
 *
 * A chunk the provider refused is not a failed search — the search completes
 * and returns what the other chunks found. But it means a window of the video
 * was never looked at, and a user asking about a moment inside that window is
 * told "nothing matches", which is indistinguishable from the moment being
 * absent. Naming the seconds is what makes that answer honest.
 */
export interface SearchCoverage {
  complete: boolean;
  unsearchedSeconds: number;
  gaps: Array<{
    startSeconds: number;
    endSeconds: number;
    startTimecode: string;
    endTimecode: string;
    reason: ChunkFailureCode;
  }>;
}

export function searchCoverage(request: ClipRequest): SearchCoverage {
  const gaps = request.chunkErrors
    // Rows written before failures carried a source window cannot describe
    // one; they still count as failures, they just cannot be located.
    .filter((error) => typeof error.globalStartSeconds === 'number' && typeof error.globalEndSeconds === 'number')
    .map((error) => ({
      startSeconds: error.globalStartSeconds,
      endSeconds: error.globalEndSeconds,
      startTimecode: formatTimecode(error.globalStartSeconds),
      endTimecode: formatTimecode(error.globalEndSeconds),
      reason: error.code ?? ('unknown' as ChunkFailureCode),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  return {
    complete: request.chunksFailed === 0,
    unsearchedSeconds: Number(gaps.reduce((sum, gap) => sum + (gap.endSeconds - gap.startSeconds), 0).toFixed(3)),
    gaps,
  };
}

function clipRequestProgress(request: ClipRequest): ClipRequestProgress {
  const total = request.chunksTotal;
  const done = request.chunksCompleted + request.chunksFailed;
  const percent = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : request.status === 'completed' ? 100 : 0;

  const message =
    request.status === 'pending'
      ? 'Queued'
      : request.status === 'searching'
        ? `Searched ${done} of ${total} segments`
        : request.status === 'completed'
          ? // Never claim a whole video was searched when part of it was not.
            // "Search complete (10 segments)" after searching nine is the line
            // that turns a coverage gap into an apparent absence.
            request.chunksFailed > 0
            ? `Searched ${request.chunksCompleted} of ${total} segments — ${request.chunksFailed} could not be examined`
            : `Search complete (${total} segments)`
          : (request.errorMessage ?? 'Search failed');

  return {
    stage: request.status,
    percent: request.status === 'completed' ? 100 : percent,
    chunksTotal: total,
    chunksCompleted: request.chunksCompleted,
    chunksFailed: request.chunksFailed,
    message,
  };
}

export function serializeClipRequest(
  request: ClipRequest,
  matches?: ClipMatch[],
  clipsByMatchId?: Map<string, Clip>,
) {
  return {
    id: request.id,
    videoId: request.videoId,
    instruction: request.instruction,
    mode: request.mode,
    resolvedMode: request.resolvedMode,
    status: request.status,
    error: request.errorMessage,
    progress: clipRequestProgress(request),
    // Surfaced so a partially failed search is visible rather than silent.
    failedChunks: request.chunkErrors.slice(0, 20),
    // The same facts as failedChunks, expressed as what the user actually
    // needs to know: which seconds of their video went unexamined.
    coverage: searchCoverage(request),
    matchCount: matches?.length ?? undefined,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    ...(matches
      ? { matches: matches.map((match) => serializeMatch(match, clipsByMatchId?.get(match.id) ?? null)) }
      : {}),
  };
}

/**
 * The detail view adds a signed playback URL for the source, so the client
 * can seat the video in a player and seek straight to matched moments. Reads
 * stay side-effect free — this only signs a URL for bytes already in storage.
 */
export async function serializeVideoWithPlayback(video: Video, chunks?: VideoChunk[]) {
  const base = serializeVideo(video, chunks);

  // The original is playable exactly when bytes were confirmed for the
  // CURRENT key. Both ingestion paths set sizeBytes at that moment — the
  // upload HEAD-confirm and the YouTube download — and reserving a retry URL
  // clears it, because the new key's object has not been PUT yet. Status is
  // deliberately not consulted: a video that failed AFTER its source landed
  // (say, in preprocessing) still has a perfectly playable original.
  const playable = video.originalStorageKey !== null && video.sizeBytes !== null;
  if (!playable) return { ...base, playback: null };

  const url = await getStorage().createDownloadUrl(video.originalStorageKey!);
  return {
    ...base,
    playback: {
      url,
      expiresAt: new Date(Date.now() + env.SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString(),
    },
  };
}

export async function serializeClip(clip: Clip, includeUrl = true) {
  let url: string | null = null;
  let urlExpiresAt: string | null = null;

  if (includeUrl && clip.status === 'ready' && clip.storageKey) {
    url = await getStorage().createDownloadUrl(clip.storageKey);
    urlExpiresAt = new Date(Date.now() + env.SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
  }

  return {
    id: clip.id,
    videoId: clip.videoId,
    clipMatchId: clip.clipMatchId,
    status: clip.status,
    error: clip.errorMessage,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    startTimecode: formatTimecode(clip.startSeconds),
    endTimecode: formatTimecode(clip.endSeconds),
    durationSeconds: clip.durationSeconds,
    sizeBytes: clip.sizeBytes,
    url,
    urlExpiresAt,
    createdAt: clip.createdAt.toISOString(),
    updatedAt: clip.updatedAt.toISOString(),
  };
}
