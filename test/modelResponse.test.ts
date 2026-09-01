import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseModelMatches } from '../src/services/search/modelResponse.js';

/** Model output is untrusted input; nothing reaches the database unvalidated. */

describe('extractJsonObject', () => {
  it('returns a bare JSON object unchanged', () => {
    expect(extractJsonObject('{"matches":[]}')).toBe('{"matches":[]}');
  });

  it('unwraps a fenced code block', () => {
    expect(extractJsonObject('```json\n{"matches":[]}\n```')).toBe('{"matches":[]}');
  });

  it('finds an object buried in prose', () => {
    const text = 'Sure! Here is what I found:\n{"matches":[{"start_seconds":1,"end_seconds":2}]}\nHope that helps.';
    expect(extractJsonObject(text)).toBe('{"matches":[{"start_seconds":1,"end_seconds":2}]}');
  });

  it('handles braces inside strings', () => {
    const text = '{"matches":[{"description":"he says {hello}","start_seconds":1,"end_seconds":2}]}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('I could not find anything')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  it('returns null for an unterminated object', () => {
    expect(extractJsonObject('{"matches":[{"start_seconds":1')).toBeNull();
  });
});

describe('parseModelMatches', () => {
  it('parses the documented response shape', () => {
    const result = parseModelMatches(
      JSON.stringify({
        matches: [
          {
            start_seconds: 42.5,
            end_seconds: 78.2,
            description: 'The requested event occurs here.',
            confidence: 0.91,
          },
        ],
      }),
    );

    expect(result.matches).toEqual([
      {
        startSeconds: 42.5,
        endSeconds: 78.2,
        description: 'The requested event occurs here.',
        confidence: 0.91,
        quote: null,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('parses an empty match list', () => {
    expect(parseModelMatches('{"matches":[]}').matches).toEqual([]);
  });

  it('treats a null matches field as no matches', () => {
    expect(parseModelMatches('{"matches":null}').matches).toEqual([]);
  });

  it('accepts a prose "no matches" answer without warning noise', () => {
    const result = parseModelMatches('There are no matching moments in this segment.');

    expect(result.matches).toEqual([]);
    expect(result.warnings[0]).toContain('prose');
  });

  it('never throws on unparseable output', () => {
    for (const input of ['', 'null', '<html>502 Bad Gateway</html>', '{"matches":[{']) {
      expect(() => parseModelMatches(input)).not.toThrow();
      expect(parseModelMatches(input).matches).toEqual([]);
    }
  });

  it('coerces numeric strings', () => {
    const result = parseModelMatches('{"matches":[{"start_seconds":"12.5","end_seconds":"30"}]}');

    expect(result.matches[0]).toMatchObject({ startSeconds: 12.5, endSeconds: 30 });
  });

  it('rescales a percentage confidence to 0-1', () => {
    const result = parseModelMatches('{"matches":[{"start_seconds":1,"end_seconds":2,"confidence":85}]}');

    expect(result.matches[0]?.confidence).toBe(0.85);
  });

  it('clamps an out-of-range confidence', () => {
    const result = parseModelMatches('{"matches":[{"start_seconds":1,"end_seconds":2,"confidence":-4}]}');

    expect(result.matches[0]?.confidence).toBe(0);
  });

  it('defaults a missing confidence and description', () => {
    const result = parseModelMatches('{"matches":[{"start_seconds":1,"end_seconds":2}]}');

    expect(result.matches[0]).toMatchObject({ confidence: 0.5, description: '' });
  });

  it('drops malformed entries but keeps the valid ones', () => {
    const result = parseModelMatches(
      JSON.stringify({
        matches: [
          { start_seconds: 1, end_seconds: 5, description: 'good' },
          { start_seconds: 'not a number', end_seconds: 9 },
          { end_seconds: 12 },
          { start_seconds: 20, end_seconds: 25, description: 'also good' },
        ],
      }),
    );

    expect(result.matches.map((match) => match.description)).toEqual(['good', 'also good']);
    expect(result.warnings).toHaveLength(2);
  });

  it('keeps a transcript quote when the model supplies one', () => {
    const result = parseModelMatches(
      '{"matches":[{"start_seconds":1,"end_seconds":2,"quote":"that is why I left"}]}',
    );

    expect(result.matches[0]?.quote).toBe('that is why I left');
  });

  it('truncates an overlong description', () => {
    const result = parseModelMatches(
      JSON.stringify({ matches: [{ start_seconds: 1, end_seconds: 2, description: 'x'.repeat(900) }] }),
    );

    expect(result.matches[0]?.description).toHaveLength(500);
  });

  it('rejects a response without a matches array', () => {
    const result = parseModelMatches('{"result":"ok"}');

    expect(result.matches).toEqual([]);
    expect(result.warnings[0]).toContain('matches');
  });
});

describe('parseReclipBoundaries', () => {
  it('accepts a clean answer and rounds to milliseconds', async () => {
    const { parseReclipBoundaries } = await import('../src/services/search/modelResponse.js');
    expect(parseReclipBoundaries('{"start_seconds":6.5,"end_seconds":41.0}', 55)).toEqual({
      startSeconds: 6.5,
      endSeconds: 41,
    });
  });

  it('digs the JSON out of a chatty or fenced reply', async () => {
    const { parseReclipBoundaries } = await import('../src/services/search/modelResponse.js');
    expect(
      parseReclipBoundaries('Here you go:\n```json\n{"start_seconds":2,"end_seconds":10}\n```', 55),
    ).toEqual({ startSeconds: 2, endSeconds: 10 });
  });

  it('clamps into the segment instead of trusting timestamps past its end', async () => {
    const { parseReclipBoundaries } = await import('../src/services/search/modelResponse.js');
    expect(parseReclipBoundaries('{"start_seconds":-3,"end_seconds":99}', 40)).toEqual({
      startSeconds: 0,
      endSeconds: 40,
    });
  });

  it('returns null — never invented boundaries — for prose, bad numbers, or an empty span', async () => {
    const { parseReclipBoundaries } = await import('../src/services/search/modelResponse.js');
    expect(parseReclipBoundaries('the clip looks good to me', 40)).toBeNull();
    expect(parseReclipBoundaries('{"start_seconds":"soon","end_seconds":10}', 40)).toBeNull();
    expect(parseReclipBoundaries('{"start_seconds":30,"end_seconds":12}', 40)).toBeNull();
    // Both boundaries clamp to the same edge: nothing left of the moment.
    expect(parseReclipBoundaries('{"start_seconds":50,"end_seconds":60}', 40)).toBeNull();
  });
});

describe('search matches survive the fullwidth-colon malformation too', () => {
  /**
   * Same parser seam, same production malformation (2026-09-01, indexing
   * chunks) — pinned here because a search answer travels through the same
   * shared parse, and a moment lost to punctuation at search time would be
   * reported to a person as "nothing matched".
   */
  it('recovers matches from a repaired response, and says it repaired', () => {
    const raw =
      '{"matches":[{"start_seconds":12,"end_seconds":30,"description："A dunk over two defenders brings the bench to its feet.","confidence":0.9}]}';
    expect(() => JSON.parse(raw)).toThrow();

    const result = parseModelMatches(raw);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.description).toContain('dunk');
    expect(result.warnings).toContain('response JSON repaired: fullwidth colon after a key name');
  });
});
