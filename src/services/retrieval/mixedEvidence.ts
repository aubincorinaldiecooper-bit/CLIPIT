import { env } from '../../config/env.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import type { EvidenceRequirement, ResolvedSearchMode } from '../../domain/types.js';
import type { VideoChat3Candidate, VideoChat3Verified } from '../videochat3/client.js';

/**
 * The evidence contract, in one place.
 *
 * A request's ResolvedSearchMode is decided once, in handleClipSearch, from
 * what was asked, how it was worded, and whether the video has a usable
 * transcript. Everything downstream — a memory candidate, a whole-video
 * candidate, the exact-interval verifier — obeys that decision; nothing
 * re-reads the question to decide what evidence it needs.
 *
 *   visual      footage required; transcript not consulted
 *   transcript  transcript evidence required; the per-chunk speech search
 *   both, all   footage AND the timestamp-aligned transcript, judged together
 *   both, any   both sources searched; a candidate with speech in its
 *               interval is judged with it, one without is judged on the
 *               footage, and each is labelled by what established it
 *
 * The resolver alone says whether a `both` is 'all' (the question mixes
 * spoken and visual conditions, or the caller asked for both by name) or
 * 'any' (an undetermined question, or a quoted phrase that may be spoken
 * or on screen). Under 'all', a candidate whose interval has no transcript
 * is not verified visually instead: it is rejected with a reason that
 * reaches the coverage record. A verdict is evidence only when it says
 * match AND clears the one canonical confidence floor.
 */

/** Seconds of transcript context kept either side of a candidate interval. */
export const TRANSCRIPT_PADDING_SECONDS = 1.5;
/** The verifier's own ceiling on transcript text (modal/videochat3.py). */
export const TRANSCRIPT_MAX_CHARS = 12_000;
export const MISSING_TRANSCRIPT_REASON = 'mixed question requires transcript evidence, but this interval has no transcript';

export type TranscriptPolicy =
  /** Footage only; the transcript is not consulted. */
  | 'none'
  /** Every candidate needs its aligned transcript; a silent one is rejected. */
  | 'required'
  /** A candidate with speech is judged with it; a silent one on the footage alone. */
  | 'when_present';

export function transcriptPolicy(mode: ResolvedSearchMode, evidence: EvidenceRequirement): TranscriptPolicy {
  if (mode !== 'both') return 'none';
  return evidence === 'all' ? 'required' : 'when_present';
}

/**
 * The one gate every evidence-producing verification passes through.
 * MIN_MATCH_CONFIDENCE is the canonical floor; no path may keep a weaker one.
 */
export function passesEvidenceGate(verdict: Pick<VideoChat3Verified, 'match' | 'confidence'>): boolean {
  return verdict.match === true && verdict.confidence >= env.MIN_MATCH_CONFIDENCE;
}

/** The transcript aligned to one interval, as lines stamped with the video's own seconds. */
export async function transcriptForInterval(videoId: string, startSeconds: number, endSeconds: number): Promise<string> {
  const rows = await listTranscriptSegmentsInRange(
    videoId,
    Math.max(0, startSeconds - TRANSCRIPT_PADDING_SECONDS),
    endSeconds + TRANSCRIPT_PADDING_SECONDS,
  );
  return rows
    .map((row) => `[${row.startSeconds.toFixed(1)}-${row.endSeconds.toFixed(1)}] ${row.text.trim()}`)
    .filter((line) => !/\]\s*$/.test(line))
    .join('\n')
    .slice(0, TRANSCRIPT_MAX_CHARS);
}

export interface MixedCandidate {
  id: string;
  start: number;
  end: number;
}

export interface AttachedTranscripts {
  /** Candidates that carry their aligned transcript and may be verified. */
  verifiable: VideoChat3Candidate[];
  /** Candidates with no speech in their interval; rejected, never verified visually instead. */
  missing: MixedCandidate[];
}

/**
 * Pair each candidate with the transcript of its own interval, and set aside
 * the ones that have none. The verifier is then asked to judge footage and
 * speech together for exactly the candidates that can satisfy both.
 */
export async function attachTranscripts(videoId: string, candidates: readonly MixedCandidate[]): Promise<AttachedTranscripts> {
  const verifiable: VideoChat3Candidate[] = [];
  const missing: MixedCandidate[] = [];
  for (const candidate of candidates) {
    const transcript = await transcriptForInterval(videoId, candidate.start, candidate.end);
    if (transcript.trim().length === 0) {
      missing.push({ id: candidate.id, start: candidate.start, end: candidate.end });
    } else {
      verifiable.push({ id: candidate.id, start: candidate.start, end: candidate.end, transcript });
    }
  }
  return { verifiable, missing };
}
