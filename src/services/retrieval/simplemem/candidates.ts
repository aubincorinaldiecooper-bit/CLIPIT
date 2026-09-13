import type { FallbackReason, ResolvedSearchMode } from '../../../domain/types.js';

/**
 * Turning what Omni-SimpleMem remembers into moments on the video's timeline,
 * and deciding whether that is an answer or a reason to fall back.
 *
 * Everything here is arithmetic over what the sidecar returned. Nothing
 * touches a network or a database, so the rules can be tested exactly and
 * argued about without a sidecar running.
 *
 * Two facts about SimpleMem's memory shape everything below:
 *
 *  - It remembers a video as FRAMES. Each frame it kept is one memory with a
 *    caption, a frame number, and (through the sidecar) the second of the
 *    video it was taken from. A moment is therefore a run of neighbouring
 *    frames, not something SimpleMem hands back as a start and an end.
 *  - Its speech memory is ONE transcript for the whole video, with no
 *    timestamps. It can say the words were spoken; it cannot say when. A
 *    question about speech cannot be placed on the timeline from it.
 */

export type SimpleMemModality = 'text' | 'visual' | 'audio' | 'video' | 'multimodal';

/** One memory the sidecar returned for a question, as the client validated it. */
export interface SimpleMemItem {
  mauId: string;
  modality: SimpleMemModality;
  /** Similarity in SimpleMem's own space. Comparable within one query, not across queries. */
  score: number;
  summary: string;
  /** Present on frame memories only: which extracted frame this was. */
  frameIndex: number | null;
  /** The second of the video the frame was taken from; null for anything that is not a frame. */
  seconds: number | null;
}

export interface Candidate {
  startSeconds: number;
  endSeconds: number;
  /** The best score among the frames folded into this candidate. */
  score: number;
  /** The caption of the best-scoring frame. */
  description: string;
  /** Every frame memory this candidate was built from, for provenance. */
  mauIds: string[];
  frames: number;
  /** What established it after verification: footage alone, or footage with its transcript. */
  source?: 'visual' | 'multimodal';
}

export interface MappingOptions {
  /** Frames per second SimpleMem sampled at; one frame covers 1/fps seconds. */
  fps: number;
  /** Neighbouring frames closer than this are the same moment. */
  groupGapSeconds: number;
  /** Frames scoring under this are ignored. Zero keeps everything. */
  minScore: number;
  /** The video's length, so no candidate claims seconds it does not have. */
  durationSeconds: number | null;
}

export interface MappingResult {
  candidates: Candidate[];
  /** What was returned and not used, counted by why — so a silent drop cannot hide. */
  ignored: {
    /** Memories that are not frames: the transcript, the video summary, text. */
    notAFrame: number;
    /** Frames the sidecar returned without a second on the timeline. */
    noTimestamp: number;
    belowScore: number;
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

interface OpenCandidate extends Candidate {
  lastSeconds: number;
}

/**
 * Frames into moments.
 *
 * Only frame memories carry a place on the timeline, so only they become
 * candidates. The rest — the whole-video summary, the untimed transcript,
 * any text — is counted as ignored rather than dropped, because the number
 * of things SimpleMem said that could not be used is part of the comparison.
 *
 * Neighbouring frames are folded into one candidate: SimpleMem keeps a frame
 * only when the picture changed, so two kept frames a few seconds apart are
 * one stretch of footage the question matched, and a card per frame would
 * show a person the same moment three times.
 */
export function mapCandidates(items: readonly SimpleMemItem[], options: MappingOptions): MappingResult {
  const ignored = { notAFrame: 0, noTimestamp: 0, belowScore: 0 };
  const frameSeconds = options.fps > 0 ? 1 / options.fps : 1;

  const frames: SimpleMemItem[] = [];
  for (const item of items) {
    if (item.modality !== 'visual' || item.frameIndex === null) {
      ignored.notAFrame += 1;
      continue;
    }
    if (item.seconds === null || !Number.isFinite(item.seconds) || item.seconds < 0) {
      ignored.noTimestamp += 1;
      continue;
    }
    if (item.score < options.minScore) {
      ignored.belowScore += 1;
      continue;
    }
    frames.push(item);
  }

  frames.sort((a, b) => (a.seconds as number) - (b.seconds as number) || b.score - a.score);

  const open: OpenCandidate[] = [];
  let current: OpenCandidate | null = null;

  for (const frame of frames) {
    const at = frame.seconds as number;
    const end = at + frameSeconds;
    if (current && at - current.lastSeconds <= options.groupGapSeconds) {
      current.endSeconds = Math.max(current.endSeconds, end);
      current.lastSeconds = at;
      current.mauIds.push(frame.mauId);
      current.frames += 1;
      if (frame.score > current.score) {
        current.score = frame.score;
        current.description = frame.summary;
      }
      continue;
    }
    current = {
      startSeconds: at,
      endSeconds: end,
      lastSeconds: at,
      score: frame.score,
      description: frame.summary,
      mauIds: [frame.mauId],
      frames: 1,
    };
    open.push(current);
  }

  // No candidate may claim a second the video does not have. A frame's
  // nominal cover can run a fraction past the end of a video whose length is
  // not a whole number of frames.
  const limit = options.durationSeconds !== null && Number.isFinite(options.durationSeconds) ? options.durationSeconds : null;
  const candidates: Candidate[] = open
    .map(({ lastSeconds: _last, ...candidate }) => ({
      ...candidate,
      startSeconds: round3(candidate.startSeconds),
      endSeconds: round3(limit !== null ? Math.min(candidate.endSeconds, limit) : candidate.endSeconds),
    }))
    .filter((candidate) => candidate.endSeconds > candidate.startSeconds)
    // Best first: the caller shows what it can and a person reads from the top.
    .sort((a, b) => b.score - a.score || a.startSeconds - b.startSeconds);

  return { candidates, ignored };
}

export type SimpleMemIndexState = 'missing' | 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export interface FallbackInput {
  indexState: SimpleMemIndexState;
  mode: ResolvedSearchMode;
  /** True when the question is a correction of an earlier answer. */
  correcting: boolean;
  /** Present once the sidecar was asked. */
  mapping?: MappingResult;
  /** Present when asking the sidecar failed. */
  error?: string;
}

export type FallbackDecision =
  | { use: 'primary' }
  | { use: 'fallback'; reason: FallbackReason; detail: string };

/**
 * Does SimpleMem's answer stand, or does the question go to the fallback?
 *
 * The order is the order the facts become known: a correction is decided
 * before anything is looked up; the index state before the sidecar is
 * asked; the mode before the answer is read; the answer last.
 *
 * "Nothing found" is never an answer from here. SimpleMem's scores are
 * uncalibrated similarities over captions, and its memory is a summary of
 * the frames it chose to keep. Its silence says the memory does not mention
 * it — the same standing the notes have — so the question goes on to the
 * fallback, whose footage read is the only path allowed to report an
 * absence.
 */
export function decideFallback(input: FallbackInput): FallbackDecision {
  if (input.correcting) {
    return { use: 'fallback', reason: 'correction', detail: 'a correction re-reads the footage by rule' };
  }
  switch (input.indexState) {
    case 'missing':
      return { use: 'fallback', reason: 'index_missing', detail: 'the video was never sent to SimpleMem' };
    case 'queued':
    case 'running':
      return { use: 'fallback', reason: 'index_not_ready', detail: `SimpleMem indexing is ${input.indexState}` };
    case 'failed':
    case 'unavailable':
      return { use: 'fallback', reason: 'index_unavailable', detail: `SimpleMem indexing is ${input.indexState}` };
    case 'ready':
      break;
  }
  if (input.mode === 'transcript') {
    return {
      use: 'fallback',
      reason: 'unsupported_mode',
      detail: 'the question is about speech, and SimpleMem keeps one untimed transcript per video',
    };
  }
  if (input.error !== undefined) {
    return { use: 'fallback', reason: 'primary_failed', detail: input.error };
  }
  const mapping = input.mapping;
  if (!mapping) {
    return { use: 'fallback', reason: 'primary_failed', detail: 'the sidecar was never asked' };
  }
  if (mapping.candidates.length > 0) return { use: 'primary' };
  if (mapping.ignored.belowScore > 0) {
    return {
      use: 'fallback',
      reason: 'below_score',
      detail: `${mapping.ignored.belowScore} frame(s) matched under the score floor`,
    };
  }
  return {
    use: 'fallback',
    reason: 'no_candidates',
    detail:
      mapping.ignored.notAFrame + mapping.ignored.noTimestamp > 0
        ? `${mapping.ignored.notAFrame} memories were not frames and ${mapping.ignored.noTimestamp} frames had no timestamp`
        : 'SimpleMem returned nothing',
  };
}
