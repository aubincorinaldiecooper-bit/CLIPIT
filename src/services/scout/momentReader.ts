import type { GanderChunk } from './ganderSession.js';
import { positionFromFrameId } from './ganderSession.js';

/**
 * Turning what Gander says into moments that can be trusted.
 *
 * Gander answers in prose, on its own clock, whether or not it has anything
 * to report. Most of what it says while watching a page is not a moment: it
 * is the model narrating, hedging, or saying nothing has happened yet. So the
 * question asks for one specific shape, and anything that does not arrive in
 * that shape is dropped rather than interpreted. Model output is untrusted
 * input; a loose parser here would put invented moments in front of people.
 *
 * The timestamps are not parsed out of the prose — the model has no reliable
 * idea what time it is, and a number it made up would look exactly like a
 * real one. They come from the frames themselves. Every chunk of text reports
 * which frames went into it, each frame is named for where in the video it
 * was taken, so the span a sentence was produced over is a fact about what
 * the model was looking at, not a claim it made.
 */

/** What the model is asked to say when it finds something. */
const MARKER = 'MOMENT:';

/** A turn that never says the marker is not a finding, however long it is. */
const MAX_DESCRIPTION_CHARS = 400;

export interface MomentReaderOptions {
  /** The question, put to the model as text. */
  query: string;
  /** Longest moment the coordinator will accept, in seconds. */
  maxMomentSeconds?: number;
}

export interface ReadMoment {
  startSeconds: number;
  endSeconds: number;
  description: string;
}

/**
 * The question as the model receives it.
 *
 * It lives next to the parser on purpose: the shape asked for and the shape
 * accepted are one decision, and splitting them across two files is how they
 * drift apart.
 */
export function questionFor(query: string): string {
  return [
    `You are watching a video to answer one question: ${query}`,
    '',
    'Watch quietly. Say nothing at all while nothing relevant is happening.',
    `When you see something that answers the question, say exactly "${MARKER}" `
      + 'followed by one short sentence describing what is happening on screen '
      + 'at that moment. Nothing else.',
    'Do not guess at times. Do not describe the video in general. Do not '
      + 'summarise at the end. If the question is never answered, say nothing.',
  ].join('\n');
}

/**
 * The stretch of video a turn is about: the frames it had just seen.
 *
 * Not every frame consumed since the model last spoke. Asked to stay quiet
 * until something happens, it does — so a first finding ninety seconds in has
 * ninety seconds of silent watching behind it, and taking all of that would
 * make the moment the whole video up to that point. What the model is talking
 * about is what it had just been shown, so the stretch is bounded to the most
 * recent window before it spoke (Codex's finding on #139).
 */
function spanOf(positions: number[], windowMs: number): { startMs: number; endMs: number } | null {
  if (!positions.length) return null;
  const endMs = Math.max(...positions);
  const floor = endMs - windowMs;
  const recent = positions.filter((position) => position >= floor);
  return { startMs: Math.min(...recent), endMs };
}

/** The sentence after the marker, or null when the turn never said it. */
function describedIn(text: string): string | null {
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const said = text.slice(at + MARKER.length).trim();
  if (!said) return null;
  // One sentence. The model was asked for one; taking more would let a turn
  // that kept talking become a description nobody asked for.
  const [first] = said.split(/(?<=[.!?])\s/);
  const description = (first ?? said).trim().slice(0, MAX_DESCRIPTION_CHARS);
  return description || null;
}

/**
 * Collect one page's moments from a session's chunks.
 *
 * A turn is accumulated as it arrives — text and the frames each chunk
 * consumed — and read once the model says the turn is over. A turn that never
 * says the marker contributes nothing, which is the ordinary case and not a
 * failure.
 */
export class MomentReader {
  private text = '';
  /** Where in the video each frame of the current turn came from, in ms. */
  private positions: number[] = [];
  private readonly maxMomentSeconds: number;
  readonly moments: ReadMoment[] = [];
  /** Every frame the model actually consumed, for reporting coverage. */
  readonly consumed = new Set<string>();

  constructor(private readonly options: MomentReaderOptions) {
    this.maxMomentSeconds = options.maxMomentSeconds ?? 60;
  }

  /** Take one chunk. Returns a moment when this chunk completed one. */
  take(chunk: GanderChunk): ReadMoment | null {
    for (const frameId of chunk.consumedFrameIds) {
      this.consumed.add(frameId);
      const position = positionFromFrameId(frameId);
      if (position !== null) this.positions.push(position);
    }
    // A listening step carries frames but no speech: it is part of the span
    // the next thing said was produced over, not a turn of its own.
    if (!chunk.isListen) this.text += chunk.text;
    if (!chunk.endOfTurn) return null;

    const moment = this.finish();
    if (moment) this.moments.push(moment);
    return moment;
  }

  /** Read the accumulated turn, then start the next one. */
  private finish(): ReadMoment | null {
    const text = this.text;
    const positions = this.positions;
    this.text = '';
    this.positions = [];

    const description = describedIn(text);
    if (!description) return null;

    const span = spanOf(positions, this.maxMomentSeconds * 1000);
    // The model claimed a moment while looking at nothing. There is no honest
    // timestamp to give it, so it is not a moment.
    if (!span) return null;

    const startSeconds = span.startMs / 1000;
    // A span of one frame is a point, not a stretch. Give it the length of the
    // frame it was seen in rather than a zero-length moment the coordinator
    // would reject outright.
    const endSeconds = span.endMs > span.startMs ? span.endMs / 1000 : startSeconds + 1;
    // The window above already holds the span inside the maximum. This stands
    // as a floor under that rather than a second rule: a span that got past it
    // is a bug here, and a moment the coordinator would reject anyway.
    if (endSeconds - startSeconds > this.maxMomentSeconds) return null;
    return { startSeconds, endSeconds, description };
  }

  /** The question this reader is reading answers to. */
  get question(): string {
    return questionFor(this.options.query);
  }
}
