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
