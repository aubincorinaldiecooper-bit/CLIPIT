import { describe, expect, it } from 'vitest';
import { cleanCueText, mergeCues, parseTimestamp, parseVttCues, parseVttToSegments } from '../src/services/transcription/vtt.js';

describe('parseTimestamp', () => {
  it('parses hh:mm:ss.mmm', () => {
    expect(parseTimestamp('01:02:03.500')).toBeCloseTo(3723.5, 6);
  });

  it('parses mm:ss.mmm', () => {
    expect(parseTimestamp('02:03.250')).toBeCloseTo(123.25, 6);
  });

  it('accepts a comma decimal separator', () => {
    expect(parseTimestamp('00:00:01,500')).toBeCloseTo(1.5, 6);
  });

  it('returns null for junk', () => {
    expect(parseTimestamp('not a timestamp')).toBeNull();
  });
});

describe('cleanCueText', () => {
  it('strips inline timing tags', () => {
    expect(cleanCueText('hello<00:00:00.539><c> everyone</c>')).toBe('hello everyone');
  });

  it('decodes HTML entities', () => {
    expect(cleanCueText('rock &amp; roll &quot;live&quot;')).toBe('rock & roll "live"');
  });
});

describe('parseVttCues', () => {
  it('parses cues and ignores headers', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:01.000 --> 00:00:04.000',
      'first line',
      '',
      '00:00:04.000 --> 00:00:08.000',
      'second line',
      '',
    ].join('\n');

    expect(parseVttCues(vtt)).toEqual([
      { startSeconds: 1, endSeconds: 4, text: 'first line' },
      { startSeconds: 4, endSeconds: 8, text: 'second line' },
    ]);
  });

  it('ignores cue positioning settings', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000 align:start position:0%\nhello\n';

    expect(parseVttCues(vtt)).toEqual([{ startSeconds: 1, endSeconds: 4, text: 'hello' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseVttCues('WEBVTT\n\n')).toEqual([]);
  });
});

describe('parseVttToSegments', () => {
  it('collapses the repetition in YouTube rolling auto-captions', () => {
    // Shape produced by `yt-dlp --write-auto-subs`: each cue repeats the
    // previous text and appends a few new words.
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.030 --> 00:00:02.879',
      'so the reason I left',
      '',
      '00:00:02.879 --> 00:00:05.520',
      'so the reason I left',
      'was pretty simple',
      '',
      '00:00:05.520 --> 00:00:08.000',
      'was pretty simple',
      'I wanted to build my own thing',
      '',
    ].join('\n');

    const segments = parseVttToSegments(vtt);
    const text = segments.map((segment) => segment.text).join(' ');

    expect(text).toBe('so the reason I left was pretty simple I wanted to build my own thing');
    expect(text).not.toMatch(/reason I left.*reason I left/);
  });

  it('keeps timestamps spanning the original cues', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:10.000 --> 00:00:13.000',
      'alpha',
      '',
      '00:00:13.000 --> 00:00:16.000',
      'beta',
      '',
    ].join('\n');

    const segments = parseVttToSegments(vtt);

    expect(segments[0]?.startSeconds).toBe(10);
    expect(segments.at(-1)?.endSeconds).toBe(16);
  });

  it('drops the word-by-word duplicates of a rolling caption', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.000',
      'hello',
      '',
      '00:00:01.000 --> 00:00:02.000',
      'hello everyone',
      '',
      '00:00:02.000 --> 00:00:03.000',
      'hello everyone welcome',
      '',
    ].join('\n');

    expect(parseVttToSegments(vtt).map((segment) => segment.text)).toEqual(['hello everyone welcome']);
  });

  it('returns nothing for a caption file with no text', () => {
    expect(parseVttToSegments('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n')).toEqual([]);
  });
});

describe('mergeCues', () => {
  it('merges short cues up to the duration budget', () => {
    const merged = mergeCues(
      [
        { startSeconds: 0, endSeconds: 2, text: 'one' },
        { startSeconds: 2, endSeconds: 4, text: 'two' },
        { startSeconds: 4, endSeconds: 6, text: 'three' },
      ],
      { maxSegmentSeconds: 12 },
    );

    expect(merged).toEqual([{ startSeconds: 0, endSeconds: 6, text: 'one two three' }]);
  });

  it('starts a new segment once the budget is exceeded', () => {
    const merged = mergeCues(
      [
        { startSeconds: 0, endSeconds: 5, text: 'one' },
        { startSeconds: 5, endSeconds: 10, text: 'two' },
        { startSeconds: 10, endSeconds: 15, text: 'three' },
      ],
      { maxSegmentSeconds: 10 },
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]?.endSeconds).toBe(10);
  });

  it('splits on the character budget', () => {
    const merged = mergeCues(
      [
        { startSeconds: 0, endSeconds: 1, text: 'a'.repeat(200) },
        { startSeconds: 1, endSeconds: 2, text: 'b'.repeat(200) },
      ],
      { maxSegmentChars: 240 },
    );

    expect(merged).toHaveLength(2);
  });
});
