/**
 * WebVTT parsing for yt-dlp caption files.
 *
 * YouTube auto-captions are "rolling": each cue repeats the tail of the
 * previous cue plus one new word, and words carry inline timing tags. Parsing
 * them naively produces a transcript where every phrase appears three times, so
 * the cleanup here is the point of this module, not an extra.
 */

export interface Cue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

const TIMESTAMP_LINE = /^(?<start>(?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})\s+-->\s+(?<end>(?:\d+:)?\d{2}:\d{2}[.,]\d{1,3})/;

export function parseTimestamp(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;

  if (![seconds, minutes, hours].every((part) => Number.isFinite(part))) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function cleanCueText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '') // inline karaoke timing tags and <c> spans
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => HTML_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a VTT document into raw cues, ignoring headers, NOTEs and styling. */
export function parseVttCues(content: string): Cue[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const cues: Cue[] = [];

  let current: { start: number; end: number; textLines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanCueText(current.textLines.join('\n'));
    if (text) cues.push({ startSeconds: current.start, endSeconds: current.end, text });
    current = null;
  };

  for (const line of lines) {
    const match = TIMESTAMP_LINE.exec(line.trim());
    if (match?.groups) {
      flush();
      const start = parseTimestamp(match.groups.start!);
      const end = parseTimestamp(match.groups.end!);
      if (start === null || end === null) continue;
      current = { start, end: Math.max(end, start), textLines: [] };
      continue;
    }

    if (!current) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.textLines.push(line);
  }

  flush();
  return cues;
}

/**
 * Longest run of words that is both a suffix of `previous` and a prefix of
 * `current`. This is the repeated overlap a rolling caption carries forward.
 */
function overlapLength(previous: string[], current: string[]): number {
  const max = Math.min(previous.length, current.length);

  for (let length = max; length > 0; length -= 1) {
    let matches = true;
    for (let offset = 0; offset < length; offset += 1) {
      if (previous[previous.length - length + offset]!.toLowerCase() !== current[offset]!.toLowerCase()) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }

  return 0;
}

/**
 * Removes the repeated text that rolling captions carry.
 *
 * Comparison is word-based rather than line-based: by the time a cue reaches
 * here its internal line breaks have been collapsed, and consecutive cues
 * overlap by an arbitrary number of words rather than by whole lines.
 */
export function dedupeRollingCues(cues: Cue[]): Cue[] {
  const output: Cue[] = [];
  let previousWords: string[] = [];

  for (const cue of cues) {
    const words = cue.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;

    const overlap = overlapLength(previousWords, words);
    const remainder = words.slice(overlap);

    // The whole cue was already emitted by an earlier one.
    if (remainder.length === 0) {
      previousWords = words;
      continue;
    }

    output.push({
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      text: remainder.join(' '),
    });
    previousWords = words;
  }

  return output;
}

export interface MergeOptions {
  maxSegmentSeconds?: number;
  maxSegmentChars?: number;
}

/**
 * Joins short cues into sentence-sized segments. One-word cues are useless as
 * search units; ~10 second segments read like transcript lines.
 */
export function mergeCues(cues: Cue[], options: MergeOptions = {}): Cue[] {
  const maxSeconds = options.maxSegmentSeconds ?? 12;
  const maxChars = options.maxSegmentChars ?? 240;
  const merged: Cue[] = [];

  for (const cue of cues) {
    const previous = merged[merged.length - 1];
    const wouldBeTooLong =
      previous !== undefined &&
      (cue.endSeconds - previous.startSeconds > maxSeconds ||
        previous.text.length + cue.text.length + 1 > maxChars);

    if (previous && !wouldBeTooLong) {
      previous.text = `${previous.text} ${cue.text}`.replace(/\s+/g, ' ').trim();
      previous.endSeconds = Math.max(previous.endSeconds, cue.endSeconds);
      continue;
    }

    merged.push({ ...cue });
  }

  return merged;
}

/** Full pipeline: VTT text in, clean timestamped transcript segments out. */
export function parseVttToSegments(content: string, options: MergeOptions = {}): Cue[] {
  return mergeCues(dedupeRollingCues(parseVttCues(content)), options).filter((cue) => cue.text.length > 0);
}
