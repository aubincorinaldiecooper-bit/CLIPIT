import { DEFAULT_WATCH_MAX_EVENTS, analyzeInternetVideo, type InternetVideoAnalysis } from './internetVideo.js';
import { classifyInstruction } from '../search/instructionMode.js';
import { getVideo } from '../../db/repositories/videos.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import { verifyWithVideoChat3 } from '../videochat3/client.js';
import type { NewClipMatch } from '../../db/repositories/clipRequests.js';
import type { VideoChunk } from '../../domain/types.js';

export const WATCH_MAX_EVENTS = DEFAULT_WATCH_MAX_EVENTS;

export interface UnwatchedTail {
  startSeconds: number;
  endSeconds: number;
}

export interface UploadedVideoAnalysis extends InternetVideoAnalysis {
  unwatched: UnwatchedTail | null;
}

export function unwatchedTail(input: {
  watchedThroughSeconds: number;
  durationSeconds: number;
}): UnwatchedTail | null {
  const start = Math.max(0, input.watchedThroughSeconds);
  if (!Number.isFinite(input.durationSeconds) || start + 0.001 >= input.durationSeconds) return null;
  return { startSeconds: start, endSeconds: input.durationSeconds };
}

function uploadedVideoId(videoKey: string): string | null {
  const match = /^proxies\/([^/]+)\/proxy\.mp4$/.exec(videoKey);
  return match?.[1] ?? null;
}

async function transcriptForInterval(videoId: string, start: number, end: number): Promise<string> {
  const rows = await listTranscriptSegmentsInRange(videoId, Math.max(0, start - 1.5), end + 1.5);
  return rows
    .map((row) => `[${row.startSeconds.toFixed(1)}-${row.endSeconds.toFixed(1)}] ${row.text.trim()}`)
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(0, 12_000);
}

/**
 * A mixed visual+spoken question gets one more exact-interval verification
 * after visual retrieval. The verifier sees the clip and only the transcript
 * aligned to that clip, so spoken conditions cannot be silently dropped.
 *
 * The request-level resolver deliberately downgrades `both` to `visual` when
 * no usable transcript exists. This helper mirrors that fact from the stored
 * video row, rather than re-classifying an ambiguous sentence and demanding a
 * transcript the request already established was unavailable.
 */
async function verifyMixedEvidence(input: {
  analysis: InternetVideoAnalysis;
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
}): Promise<InternetVideoAnalysis> {
  if (classifyInstruction(input.query).mode !== 'both' || input.analysis.verified.length === 0) {
    return input.analysis;
  }

  const videoId = uploadedVideoId(input.videoKey);
  // Only Clipit's canonical proxy keys can be joined to a stored transcript.
  if (!videoId) return input.analysis;

  const video = await getVideo(videoId);
  if (!video || video.transcriptStatus !== 'ready' || video.transcriptSegmentCount <= 0) {
    return input.analysis;
  }

  const candidates = await Promise.all(input.analysis.verified.map(async (moment, index) => ({
    id: `mixed-${index}`,
    start: moment.startSeconds,
    end: moment.endSeconds,
    transcript: await transcriptForInterval(videoId, moment.startSeconds, moment.endSeconds),
  })));

  const missingTranscript = candidates.filter((candidate) => candidate.transcript.trim().length === 0);
  const verifiable = candidates.filter((candidate) => candidate.transcript.trim().length > 0);
  if (verifiable.length === 0) {
    return {
      ...input.analysis,
      verified: [],
      failures: [
        ...input.analysis.failures,
        ...missingTranscript.map((candidate) => ({
          id: candidate.id,
          reason: 'mixed question requires transcript evidence, but this interval has no transcript',
          startSeconds: candidate.start,
          endSeconds: candidate.end,
        })),
      ],
    };
  }

  const verdicts = await verifyWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.query,
    expectedBytes: input.expectedBytes,
    candidates: verifiable,
  });
  const original = new Map(candidates.map((candidate, index) => [candidate.id, input.analysis.verified[index]!]));
  const verified = verdicts.results
    .filter((result) => result.match)
    .map((result) => ({
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      confidence: result.confidence,
      description: result.description || original.get(result.id)?.description || '',
    }));
  const failureById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  return {
    ...input.analysis,
    model: verdicts.model,
    revision: verdicts.revision,
    verified,
    failures: [
      ...input.analysis.failures,
      ...missingTranscript.map((candidate) => ({
        id: candidate.id,
        reason: 'mixed question requires transcript evidence, but this interval has no transcript',
        startSeconds: candidate.start,
        endSeconds: candidate.end,
      })),
      ...verdicts.failed.map((failure) => {
        const candidate = failureById.get(failure.id);
        return {
          id: failure.id,
          reason: `mixed verification failed: ${failure.reason}`,
          ...(candidate ? { startSeconds: candidate.start, endSeconds: candidate.end } : {}),
        };
      }),
    ],
    metrics: { ...input.analysis.metrics, mixedVerification: verdicts.metrics },
  };
}

export async function analyzeUploadedVideo(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  durationSeconds: number | null;
}): Promise<UploadedVideoAnalysis> {
  try {
    const firstAnalysis = await analyzeInternetVideo({
      query: input.query,
      videoUrl: input.videoUrl,
      videoKey: input.videoKey,
      expectedBytes: input.expectedBytes,
      maxEvents: WATCH_MAX_EVENTS,
    });
    const analysis = await verifyMixedEvidence({
      analysis: firstAnalysis,
      query: input.query,
      videoUrl: input.videoUrl,
      videoKey: input.videoKey,
      expectedBytes: input.expectedBytes,
    });
    const durationSeconds = input.durationSeconds ?? analysis.durationSeconds;
    return {
      ...analysis,
      unwatched: unwatchedTail({ watchedThroughSeconds: analysis.watchedThroughSeconds, durationSeconds }),
    };
  } catch (error) {
    const durationSeconds = input.durationSeconds ?? 0;
    const reason = error instanceof Error ? error.message : 'whole-video analysis failed';
    return {
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'unavailable',
      durationSeconds,
      watchedEvents: 0,
      watchedThroughSeconds: 0,
      verified: [],
      failures: durationSeconds > 0
        ? [{ id: 'whole-video-read', reason, startSeconds: 0, endSeconds: durationSeconds }]
        : [{ id: 'whole-video-read', reason }],
      metrics: { failed: true, reason },
      unwatched: durationSeconds > 0 ? { startSeconds: 0, endSeconds: durationSeconds } : null,
    };
  }
}

export interface PlaceableMoment {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  description: string;
  source?: NewClipMatch['source'];
  quote?: string | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
}

/**
 * A chunk is only the stored row's anchor. Global seconds remain the source of
 * truth and may cross the anchor chunk's end. Only the full video's bounds
 * clamp a verified interval.
 */
export function placeMomentsOnChunks(
  moments: readonly PlaceableMoment[],
  chunks: readonly VideoChunk[],
  attribution: { instruction: string; provider: string; model: string; promptVersion?: string | null },
): NewClipMatch[] {
  const first = chunks[0];
  const last = chunks.at(-1);
  if (!first || !last) return [];
  const videoStart = first.globalStartSeconds;
  const videoEnd = last.globalEndSeconds;
  const found: NewClipMatch[] = [];

  for (const moment of moments) {
    const globalStartSeconds = Math.max(videoStart, moment.startSeconds);
    const globalEndSeconds = Math.min(videoEnd, moment.endSeconds);
    if (!Number.isFinite(globalStartSeconds) || !Number.isFinite(globalEndSeconds) || globalEndSeconds <= globalStartSeconds) {
      continue;
    }
    const chunk = chunks.find((item) =>
      globalStartSeconds >= item.globalStartSeconds && globalStartSeconds < item.globalEndSeconds,
    );
    if (!chunk) continue;

    found.push({
      chunkId: chunk.id,
      localStartSeconds: Number((globalStartSeconds - chunk.globalStartSeconds).toFixed(3)),
      localEndSeconds: Number((globalEndSeconds - chunk.globalStartSeconds).toFixed(3)),
      globalStartSeconds: Number(globalStartSeconds.toFixed(3)),
      globalEndSeconds: Number(globalEndSeconds.toFixed(3)),
      description: moment.description || `A moment matching "${attribution.instruction}"`,
      confidence: Math.max(0, Math.min(1, moment.confidence)),
      source: moment.source ?? 'visual',
      ...(moment.quote !== undefined ? { quote: moment.quote } : {}),
      provider: moment.provider ?? attribution.provider,
      model: moment.model ?? attribution.model,
      ...(moment.promptVersion !== undefined || attribution.promptVersion !== undefined
        ? { promptVersion: moment.promptVersion ?? attribution.promptVersion ?? null }
        : {}),
    });
  }
  return found;
}
