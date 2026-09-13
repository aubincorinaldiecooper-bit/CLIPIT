import { mapWithConcurrency } from '../../lib/concurrency.js';
import { errorMessage } from '../../lib/errors.js';
import { listTranscriptSegments } from '../../db/repositories/transcripts.js';
import { verifyWithVideoChat3 } from '../videochat3/client.js';
import { MISSING_TRANSCRIPT_REASON, attachTranscripts, passesEvidenceGate } from './mixedEvidence.js';
import type { NewClipMatch } from '../../db/repositories/clipRequests.js';
import type { TranscriptSegment, VideoChunk } from '../../domain/types.js';

/**
 * Speech proposes too.
 *
 * Under a `both` question whose evidence requirement is `any`, either source
 * may establish a moment — but VideoChat3's watch has no sound and SimpleMem
 * remembers frames, so on their own only the picture ever proposes. A phrase
 * spoken over an unchanging shot would never be found. This module is the
 * transcript's side of the proposal: it names stretches of the timestamped
 * transcript that may answer the question, and every one of them is then
 * re-opened by VideoChat3 with its footage and its aligned transcript before
 * it can be evidence. Nothing here is evidence by itself.
 *
 * Two ways speech proposes:
 *   - a quoted phrase in the question is looked up in the transcript
 *     directly (no model, no cost);
 *   - an undetermined question runs the retained transcript-only per-chunk
 *     search, which sends transcript text and never video bytes, and takes
 *     the intervals it names as proposals.
 */

export interface SpokenProposal {
  id: string;
  startSeconds: number;
  endSeconds: number;
  /** The words that made this a proposal. */
  text: string;
  /** The text search's confidence; null for a direct phrase hit. */
  confidence: number | null;
  origin: 'quoted_phrase' | 'text_search';
}

export interface SpokenMoment {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  description: string;
  source: 'multimodal';
  quote: string;
  provider: string;
  model: string;
}

export interface SpokenFailure {
  /**
   * 'unsearched': speech never named anything here (the text search could not
   * read the chunk, or the whole lane failed). 'unverified': speech named this
   * stretch and the footage verdict could not be obtained.
   */
  kind: 'unsearched' | 'unverified';
  startSeconds: number;
  endSeconds: number;
  reason: string;
}

export interface SpokenProposals {
  proposals: SpokenProposal[];
  /** Proposals VideoChat3 confirmed with footage and transcript together, gated. */
  moments: SpokenMoment[];
  /** Stretches speech proposed that could not be judged: recorded as unexamined. */
  failures: SpokenFailure[];
  metrics: Record<string, unknown>;
}

/** The most proposals speech may hand to the verifier for one question. */
export const MAX_SPOKEN_PROPOSALS = 20;
/** Seconds added either side of a phrase, so the clip shows the line being said. */
export const PHRASE_PADDING_SECONDS = 1.5;
/** A proposal shorter than this is widened around its middle: a two-word clip proves nothing. */
export const MIN_PROPOSAL_SECONDS = 3;

const DOUBLE_QUOTED = /["“]([^"”]{2,200})["”]/g;
const SINGLE_QUOTED = /(?<![\p{L}\p{N}])['‘]([^'’]{2,200})['’](?![\p{L}\p{N}])/gu;

/** The phrases a question quotes, in order, without the quotes. */
export function quotedPhrases(instruction: string): string[] {
  const phrases: string[] = [];
  for (const pattern of [DOUBLE_QUOTED, SINGLE_QUOTED]) {
    for (const match of instruction.matchAll(pattern)) {
      const phrase = match[1]?.trim();
      if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  return phrases;
}

/** Words as the ear hears them: case, punctuation and typographic quotes set aside. */
export function speechTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter((token) => token.length > 0);
}

export interface PhraseWindow {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Every place the transcript says the phrase, as a window on the video's
 * own clock. A phrase may run across segment boundaries; the window spans
 * every segment it touches, plus a little room either side.
 */
export function findPhraseWindows(
  segments: readonly TranscriptSegment[],
  phrase: string,
  durationSeconds: number | null,
): PhraseWindow[] {
  const wanted = speechTokens(phrase);
  if (wanted.length === 0) return [];
  const stream: Array<{ token: string; segment: number }> = [];
  segments.forEach((segment, index) => {
    for (const token of speechTokens(segment.text)) stream.push({ token, segment: index });
  });
  const windows: PhraseWindow[] = [];
  for (let start = 0; start + wanted.length <= stream.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (stream[start + offset]!.token !== wanted[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = segments[stream[start]!.segment]!;
    const last = segments[stream[start + wanted.length - 1]!.segment]!;
    windows.push(widen({
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      text: segments.slice(stream[start]!.segment, stream[start + wanted.length - 1]!.segment + 1)
        .map((segment) => segment.text.trim())
        .join(' '),
    }, durationSeconds));
    start += wanted.length - 1;
  }
  return mergeWindows(windows);
}

function widen(window: PhraseWindow, durationSeconds: number | null): PhraseWindow {
  const limit = durationSeconds !== null && Number.isFinite(durationSeconds) ? durationSeconds : Number.POSITIVE_INFINITY;
  let start = Math.max(0, window.startSeconds - PHRASE_PADDING_SECONDS);
  let end = Math.min(limit, window.endSeconds + PHRASE_PADDING_SECONDS);
  if (end - start < MIN_PROPOSAL_SECONDS) {
    // Too short to judge: grow around the middle, and where an edge of the video stops that, grow the other way.
    const middle = (start + end) / 2;
    end = Math.min(limit, Math.max(end, middle + MIN_PROPOSAL_SECONDS / 2));
    start = Math.max(0, end - MIN_PROPOSAL_SECONDS);
    end = Math.min(limit, start + MIN_PROPOSAL_SECONDS);
  }
  return { ...window, startSeconds: Number(start.toFixed(3)), endSeconds: Number(end.toFixed(3)) };
}

function mergeWindows(windows: readonly PhraseWindow[]): PhraseWindow[] {
  const sorted = [...windows].sort((left, right) => left.startSeconds - right.startSeconds);
  const merged: PhraseWindow[] = [];
  for (const window of sorted) {
    const last = merged.at(-1);
    if (last && window.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, window.endSeconds);
      if (!last.text.includes(window.text)) last.text = `${last.text} ${window.text}`;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/** What the retained text-only per-chunk search named, as proposals. */
export function proposalsFromTextSearch(matches: readonly NewClipMatch[]): SpokenProposal[] {
  return matches
    .filter((match) => match.globalEndSeconds > match.globalStartSeconds)
    .map((match, index) => ({
      id: `spoken-text-${index}`,
      startSeconds: match.globalStartSeconds,
      endSeconds: match.globalEndSeconds,
      text: (match.quote ?? match.description ?? '').trim(),
      confidence: match.confidence,
      origin: 'text_search' as const,
    }));
}

/** Strongest first, quoted hits ahead of model guesses, no more than the verifier should be asked for. */
export function rankProposals(proposals: readonly SpokenProposal[]): SpokenProposal[] {
  return [...proposals]
    .sort((left, right) => {
      if (left.origin !== right.origin) return left.origin === 'quoted_phrase' ? -1 : 1;
      return (right.confidence ?? 1) - (left.confidence ?? 1);
    })
    .slice(0, MAX_SPOKEN_PROPOSALS);
}

/** The coverage record's sentence for a stretch speech could not establish. */
export function describeSpokenFailure(failure: SpokenFailure): string {
  return failure.kind === 'unsearched'
    ? `Speech was not searched here: ${failure.reason}`
    : `Speech proposed this stretch, but it could not be verified against the footage: ${failure.reason}`;
}

/**
 * The whole speech lane failed before it could name anything. Under `any`
 * the footage still answers; the stretch speech never searched is recorded,
 * never presumed empty.
 */
export function speechUnsearched(error: unknown, endSeconds: number): SpokenProposals {
  const reason = errorMessage(error);
  return {
    proposals: [],
    moments: [],
    failures: endSeconds > 0 ? [{ kind: 'unsearched', startSeconds: 0, endSeconds, reason }] : [],
    metrics: { failed: true, reason },
  };
}

export async function proposeSpokenMoments(input: {
  videoId: string;
  instruction: string;
  chunks: readonly VideoChunk[];
  durationSeconds: number | null;
  videoUrl: string;
  expectedBytes?: number;
  /** The retained transcript-only per-chunk search: transcript text in, intervals out, no video bytes. */
  textSearch: (chunk: VideoChunk) => Promise<NewClipMatch[]>;
  concurrency: number;
}): Promise<SpokenProposals> {
  const failures: SpokenFailure[] = [];
  let proposals: SpokenProposal[] = [];
  const phrases = quotedPhrases(input.instruction);
  const segments = await listTranscriptSegments(input.videoId);
  // A chunk in which nobody speaks has nothing for speech to propose, so no
  // model is asked about it. The footage there is still the watcher's.
  const spokenChunks = input.chunks.filter((chunk) =>
    segments.some((segment) => segment.endSeconds > chunk.globalStartSeconds && segment.startSeconds < chunk.globalEndSeconds));

  if (phrases.length > 0) {
    proposals = phrases.flatMap((phrase) => findPhraseWindows(segments, phrase, input.durationSeconds))
      .map((window, index) => ({
        id: `spoken-phrase-${index}`,
        startSeconds: window.startSeconds,
        endSeconds: window.endSeconds,
        text: window.text,
        confidence: null,
        origin: 'quoted_phrase' as const,
      }));
  } else {
    const results = await mapWithConcurrency(spokenChunks, input.concurrency, (chunk) => input.textSearch(chunk));
    const matches: NewClipMatch[] = [];
    results.forEach((result, index) => {
      const chunk = spokenChunks[index]!;
      if (result.status === 'fulfilled') {
        matches.push(...result.value);
      } else {
        failures.push({
          kind: 'unsearched',
          startSeconds: chunk.globalStartSeconds,
          endSeconds: chunk.globalEndSeconds,
          reason: `transcript search failed: ${errorMessage(result.reason)}`,
        });
      }
    });
    proposals = proposalsFromTextSearch(matches);
  }

  proposals = rankProposals(proposals);
  const metrics: Record<string, unknown> = {
    origin: phrases.length > 0 ? 'quoted_phrase' : 'text_search',
    phrases: phrases.length,
    chunks: input.chunks.length,
    silentChunks: input.chunks.length - spokenChunks.length,
    proposals: proposals.length,
    searchFailures: failures.length,
  };
  if (proposals.length === 0) return { proposals, moments: [], failures, metrics };

  // Every proposal is judged with its footage and its aligned transcript,
  // through the same gate as every other verification.
  const { verifiable, missing } = await attachTranscripts(
    input.videoId,
    proposals.map((proposal) => ({ id: proposal.id, start: proposal.startSeconds, end: proposal.endSeconds })),
  );
  for (const candidate of missing) {
    failures.push({ kind: 'unverified', startSeconds: candidate.start, endSeconds: candidate.end, reason: MISSING_TRANSCRIPT_REASON });
  }
  if (verifiable.length === 0) return { proposals, moments: [], failures, metrics: { ...metrics, verified: 0 } };

  const verdicts = await verifyWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.instruction,
    expectedBytes: input.expectedBytes,
    candidates: verifiable,
  });
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const moments: SpokenMoment[] = [];
  let rejected = 0;
  for (const result of verdicts.results) {
    const proposal = byId.get(result.id);
    if (!proposal) continue;
    if (!passesEvidenceGate(result)) {
      rejected += 1;
      continue;
    }
    moments.push({
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      confidence: result.confidence,
      description: result.description || proposal.text,
      source: 'multimodal',
      quote: proposal.text,
      provider: 'modal',
      model: verdicts.model,
    });
  }
  for (const failure of verdicts.failed) {
    const proposal = byId.get(failure.id);
    if (!proposal) continue;
    failures.push({
      kind: 'unverified',
      startSeconds: proposal.startSeconds,
      endSeconds: proposal.endSeconds,
      reason: `VideoChat3 verification failed: ${failure.reason}`,
    });
  }
  moments.sort((left, right) => right.confidence - left.confidence);
  return {
    proposals,
    moments,
    failures,
    metrics: { ...metrics, verified: moments.length, rejected, verify: verdicts.metrics },
  };
}
