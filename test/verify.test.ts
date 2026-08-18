import { describe, expect, it } from 'vitest';
import { parseVerifyResponse, VERIFY_SYSTEM_PROMPT } from '../src/services/search/verify.js';

/**
 * Verification stands between a proposed moment and the user; its parser must
 * neither invent confirmations nor lose matches to formatting noise.
 */

describe('parseVerifyResponse', () => {
  it('parses a confirmation with a refined range', () => {
    expect(parseVerifyResponse('{"confirmed":true,"start_seconds":612,"end_seconds":631.5,"confidence":0.9}')).toEqual({
      confirmed: true,
      startSeconds: 612,
      endSeconds: 631.5,
      confidence: 0.9,
    });
  });

  it('parses a rejection', () => {
    expect(parseVerifyResponse('{"confirmed":false}')).toEqual({
      confirmed: false,
      startSeconds: null,
      endSeconds: null,
      confidence: null,
    });
  });

  it('tolerates fences, prose, string booleans and string numbers', () => {
    const verdict = parseVerifyResponse(
      'Looking at the frames:\n```json\n{"confirmed":"true","start_seconds":"10.5","end_seconds":"14","confidence":"85"}\n```',
    );
    expect(verdict).toEqual({ confirmed: true, startSeconds: 10.5, endSeconds: 14, confidence: 0.85 });
  });

  it('drops an inverted or missing range but keeps the verdict', () => {
    expect(parseVerifyResponse('{"confirmed":true,"start_seconds":30,"end_seconds":20}')).toEqual({
      confirmed: true,
      startSeconds: null,
      endSeconds: null,
      confidence: null,
    });
  });

  it('returns null on garbage so the caller keeps the unverified match', () => {
    expect(parseVerifyResponse('')).toBeNull();
    expect(parseVerifyResponse('the truck is definitely there')).toBeNull();
    expect(parseVerifyResponse('{"unrelated":1}')).toBeNull();
  });
});

describe('VERIFY_SYSTEM_PROMPT', () => {
  it('demands scepticism and the JSON contract', () => {
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/benefit of the doubt/i);
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/"confirmed"/);
    expect(VERIFY_SYSTEM_PROMPT).toMatch(/same clock as the frame labels/i);
  });
});
