import type { VideoStatus } from '../../domain/types.js';

/**
 * When a question may be asked, and what the answer has to wait for.
 *
 * These were once one thing: the video's `ready` status, set only after
 * preprocessing had stored every derived media artifact. The send button
 * therefore waited for preparation even though the user's question already
 * existed and could safely be queued.
 *
 * The two are separated. A question is ACCEPTED the moment the video's bytes
 * have landed. The ANSWER waits inside the search job for what it genuinely
 * needs: preparation, retrieval availability, and — for a spoken question —
 * the transcript.
 *
 * Pure, and the only place either rule lives, so the API gate and the worker
 * cannot disagree about it.
 */

export type QuestionAcceptance =
  /** There is a video to ask about. The answer may still have to wait. */
  | 'accept'
  /** No bytes yet: nothing exists to ask about. */
  | 'uploading'
  /** The video will never be answerable; say why rather than parking the question. */
  | 'failed';

export function questionAcceptance(status: VideoStatus): QuestionAcceptance {
  if (status === 'failed') return 'failed';
  if (status === 'pending_upload') return 'uploading';
  return 'accept';
}

export function acceptsQuestions(status: VideoStatus): boolean {
  return questionAcceptance(status) === 'accept';
}

export type PreparationWait =
  /** The analysis the answer needs is still being made: park the question and look again shortly. */
  | 'wait'
  /** Prepared (or failed, which the caller reports): carry on. */
  | 'proceed'
  /** Still not prepared after the whole allowance: the question cannot be answered now. */
  | 'timed_out';

/** Is this video still on its way to being answerable? */
export function isBeingPrepared(status: VideoStatus): boolean {
  return status === 'pending_upload' || status === 'queued' || status === 'ingesting' || status === 'preprocessing';
}

export function preparationWait(status: VideoStatus, waitedMs: number, timeoutMs: number): PreparationWait {
  if (!isBeingPrepared(status)) return 'proceed';
  return waitedMs < timeoutMs ? 'wait' : 'timed_out';
}

/** What a person is told when the wait ran out. */
export const PREPARATION_TIMED_OUT_MESSAGE =
  'Your video is still being prepared and it is taking longer than expected — ask again in a minute.';
