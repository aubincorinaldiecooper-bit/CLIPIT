import { describe, expect, it } from 'vitest';
import { presentationTargetFor, verticalForRework, ALWAYS_VERTICAL } from '../src/services/search/presentationTarget.js';
import { needsVerticalDerivative, resolvePlatformIntent } from '../src/services/search/platformIntent.js';

/**
 * Every clip is vertical. Never landscape. Ever. (Owner, 2026-09-03.)
 *
 * This file exists to make that rule expensive to break by accident. The rule
 * it replaced was read out of the person's words, and the way it went wrong
 * is the case at the top: a search that never said "TikTok" produced a
 * landscape clip, which the 9:16 review card drew as a narrow band in a tall
 * black box. Nothing had failed, and it looked broken.
 *
 * So these are not tests of a function. They are the rule, written where a
 * change of mind has to argue with it.
 */

describe('every clip is vertical, whatever was typed', () => {
  it('the case that made the rule: no platform word anywhere', () => {
    expect(presentationTargetFor('Find the part where they introduce themselves').target).toBe('vertical');
    expect(needsVerticalDerivative(resolvePlatformIntent('find the bit where the dog barks', 90))).toBe(true);
  });

  it('an empty or missing instruction', () => {
    for (const instruction of ['', '   ', null, undefined]) {
      expect(presentationTargetFor(instruction).target).toBe('vertical');
    }
  });

  it('the phrases that used to be the way out', () => {
    // Each of these previously returned the source shape, and the first two
    // beat a platform word in the same sentence. There is no way out now.
    const escapes = [
      'keep the original framing',
      'post to tiktok but keep the original framing',
      "tiktok clips but don't crop them",
      'preserve the original aspect ratio',
      'keep it wide',
      'keep the full frame',
      'no crop',
    ];
    for (const instruction of escapes) {
      expect(presentationTargetFor(instruction).target).toBe('vertical');
      expect(needsVerticalDerivative(resolvePlatformIntent(instruction, 90))).toBe(true);
    }
  });

  it('a request for a platform, which was always vertical and still is', () => {
    expect(needsVerticalDerivative(resolvePlatformIntent('3 moments for tiktok', 90))).toBe(true);
    expect(needsVerticalDerivative(resolvePlatformIntent('reels please', 90))).toBe(true);
  });

  it('re-work of a request stored before the rule', () => {
    // Old rows carry 'source'. Re-cutting one must not hand back the
    // landscape clip the rule exists to stop.
    expect(verticalForRework()).toBe('vertical');
    expect(ALWAYS_VERTICAL).toBe('vertical');
  });

  it('leaves the rest of the intent alone', () => {
    // The shape is settled; nothing else is. Which platform's limits apply,
    // and how long a clip may run, are still read from the words.
    const tiktok = resolvePlatformIntent('post a 30 second clip to tiktok', 90);
    expect(tiktok.platform).toBe('tiktok');
    expect(tiktok.hardMaxSeconds).toBe(30);

    const plain = resolvePlatformIntent('find the bit where the dog barks', 90);
    expect(plain.platform).toBeNull();
  });
});
