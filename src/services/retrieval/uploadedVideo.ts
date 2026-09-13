import {
  DEFAULT_WATCH_MAX_EVENTS,
  analyzeInternetVideo,
  type InternetVideoAnalysis,
  type InternetVideoMoment,
} from './internetVideo.js';
import { MISSING_TRANSCRIPT_REASON, attachTranscripts, passesEvidenceGate, transcriptPolicy } from './mixedEvidence.js';
import { verifyWithVideoChat3 } from '../videochat3/client.js';
import type { NewClipMatch } from '../../db/repositories/clipRequests.js';
import type { EvidenceRequirement, ResolvedSearchMode, VideoChunk } from '../../domain/types.js';

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

/**
 * A mixed visual+spoken question gets one more exact-interval verification
 * after visual retrieval. The verifier sees the clip and only the transcript
 * aligned to that clip, so a spoken condition cannot be satisfied by the
 * picture alone.
 *
 * Which questions are mixed, and what a mixed one demands, is not decided
 * here. The request's resolved mode and evidence requirement arrive from
 * handleClipSearch, which already weighed the explicit mode, the wording,
 * and whether the video has a usable transcript: a `both` downgraded to
 * `visual` upstream arrives as `visual` and gets no transcript work; an
 * explicit `both` stays `both` however visual its wording. Under 'all', a
 * candidate whose interval has no transcript is rejected with a reason,
 * never verified visually instead. Under 'any', it keeps its visual verdict
 * and is labelled visual, while a candidate with speech is judged again
 * with it and labelled multimodal. Every verdict is evidence only through
 * the same gate as every other verification (passesEvidenceGate).
 */
async function verifyMixedEvidence(input: {
  analysis: InternetVideoAnalysis;
  query: string;
  videoId: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  mode: ResolvedSearchMode;
  evidence: EvidenceRequirement;
}): Promise<InternetVideoAnalysis> {
  const policy = transcriptPolicy(input.mode, input.evidence);
  if (policy === 'none' || input.analysis.verified.length === 0) return input.analysis;

  const moments = input.analysis.verified;
  const momentById = new Map(moments.map((moment, index) => [`mixed-${index}`, moment]));
  const intervals = moments.map((moment, index) => ({ id: `mixed-${index}`, start: moment.startSeconds, end: moment.endSeconds }));

  // The watch and its footage verdicts stand whatever happens below. A
  // candidate whose transcript-assisted verdict could not be obtained is
  // named as unverified over its own seconds: not kept on the picture alone,
  // not dropped as if judged, and never allowed to turn a finished watch into
  // an unread video.
  const unjudged = (
    candidates: ReadonlyArray<{ id: string; start: number; end: number }>,
    kept: InternetVideoMoment[],
    namedFailures: InternetVideoAnalysis['failures'],
    detail: Record<string, unknown>,
    error: unknown,
  ): InternetVideoAnalysis => {
    const reason = errorReason(error);
    return {
      ...input.analysis,
      verified: kept,
      failures: [
        ...input.analysis.failures,
        ...namedFailures,
        ...candidates.map((candidate) => ({
          id: candidate.id,
          reason: `mixed verification failed: ${reason}`,
          startSeconds: candidate.start,
          endSeconds: candidate.end,
        })),
      ],
      metrics: {
        ...input.analysis.metrics,
        mixedVerification: { policy, ...detail, verified: kept.length, rejected: 0, failed: true, reason },
      },
    };
  };

  let attached: Awaited<ReturnType<typeof attachTranscripts>>;
  try {
    attached = await attachTranscripts(input.videoId, intervals);
  } catch (error) {
    if (policy === 'when_present') {
      // Either source may establish a moment, and the footage already has.
      // What the transcript would have added (a joint verdict for the spoken
      // candidates, and their label) is not available, so every moment stands
      // on its footage verdict and says so; the outage is on record in the
      // metrics, and the speech lane records the stretch it could not search.
      const reason = errorReason(error);
      return {
        ...input.analysis,
        verified: moments.map((moment) => ({ ...moment, source: 'visual' as const })),
        metrics: {
          ...input.analysis.metrics,
          mixedVerification: {
            policy, candidates: intervals.length, withoutTranscript: null, verified: moments.length, rejected: 0, failed: true, reason,
          },
        },
      };
    }
    // Both sources are required and one cannot be read: nothing is verified,
    // and every candidate is named over its own seconds.
    return unjudged(intervals, [], [], { candidates: intervals.length, withoutTranscript: null }, error);
  }
  const { verifiable, missing } = attached;
  const missingFailures = policy === 'required'
    ? missing.map((candidate) => ({
      id: candidate.id,
      reason: MISSING_TRANSCRIPT_REASON,
      startSeconds: candidate.start,
      endSeconds: candidate.end,
    }))
    : [];
  // Under 'any', a silent stretch already passed the visual verification
  // and the gate; it stays, and says it was established by footage alone.
  const keptOnFootage: InternetVideoMoment[] = policy === 'when_present'
    ? missing.flatMap((candidate) => {
      const moment = momentById.get(candidate.id);
      return moment ? [{ ...moment, source: 'visual' as const }] : [];
    })
    : [];
  if (verifiable.length === 0) {
    return {
      ...input.analysis,
      verified: keptOnFootage,
      failures: [...input.analysis.failures, ...missingFailures],
      metrics: {
        ...input.analysis.metrics,
        mixedVerification: {
          policy, candidates: 0, withoutTranscript: missing.length, verified: keptOnFootage.length, rejected: 0,
        },
      },
    };
  }

  let verdicts: Awaited<ReturnType<typeof verifyWithVideoChat3>>;
  try {
    verdicts = await verifyWithVideoChat3({
      videoUrl: input.videoUrl,
      query: input.query,
      expectedBytes: input.expectedBytes,
      candidates: verifiable,
    });
  } catch (error) {
    return unjudged(
      verifiable,
      keptOnFootage,
      missingFailures,
      { candidates: verifiable.length, withoutTranscript: missing.length },
      error,
    );
  }
  const candidateById = new Map(verifiable.map((candidate) => [candidate.id, candidate]));
  let rejected = 0;
  const verified: InternetVideoMoment[] = [...keptOnFootage];
  for (const result of verdicts.results) {
    if (!passesEvidenceGate(result)) {
      rejected += 1;
      continue;
    }
    verified.push({
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      confidence: result.confidence,
      description: result.description || momentById.get(result.id)?.description || '',
      // Footage judged together with its transcript.
      source: 'multimodal',
    });
  }
  verified.sort((left, right) => right.confidence - left.confidence);

  return {
    ...input.analysis,
    model: verdicts.model,
    revision: verdicts.revision,
    verified,
    failures: [
      ...input.analysis.failures,
      ...missingFailures,
      ...verdicts.failed.map((failure) => {
        const candidate = candidateById.get(failure.id);
        return {
          id: failure.id,
          reason: `mixed verification failed: ${failure.reason}`,
          ...(candidate ? { startSeconds: candidate.start, endSeconds: candidate.end } : {}),
        };
      }),
    ],
    metrics: {
      ...input.analysis.metrics,
      mixedVerification: {
        ...verdicts.metrics,
        policy,
        candidates: verifiable.length,
        withoutTranscript: missing.length,
        verified: verified.length,
        rejected,
      },
    },
  };
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : 'whole-video analysis failed';
}

/**
 * Read an uploaded video the way an internet video is read, then hold the
 * result to the request's evidence contract. `mode` and `evidence` are the
 * request-level decision from handleClipSearch; they are passed down, never
 * re-derived.
 */
export async function analyzeUploadedVideo(input: {
  query: string;
  videoId: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  durationSeconds: number | null;
  mode: ResolvedSearchMode;
  evidence: EvidenceRequirement;
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
      videoId: input.videoId,
      videoUrl: input.videoUrl,
      videoKey: input.videoKey,
      expectedBytes: input.expectedBytes,
      mode: input.mode,
      evidence: input.evidence,
    });
    const durationSeconds = input.durationSeconds ?? analysis.durationSeconds;
    return {
      ...analysis,
      unwatched: unwatchedTail({ watchedThroughSeconds: analysis.watchedThroughSeconds, durationSeconds }),
    };
  } catch (error) {
    const durationSeconds = input.durationSeconds ?? 0;
    const reason = errorReason(error);
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
