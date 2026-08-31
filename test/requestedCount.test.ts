import { describe, expect, it } from 'vitest';
import { parseRequestedMomentCount, resolvePlatformIntent } from '../src/services/search/platformIntent.js';

/**
 * How many moments the creator asked for.
 *
 * The number IS the request. Asking for three and receiving one is a wrong
 * answer; asking for one and receiving three renders clips nobody agreed to
 * pay for. Both directions are worth pinning.
 */
describe('parseRequestedMomentCount', () => {
  it('reads the number the creator actually wrote', () => {
    expect(parseRequestedMomentCount('Find me 3 moments I can post on TikTok')).toBe(3);
    expect(parseRequestedMomentCount('find me three moments for tiktok')).toBe(3);
    expect(parseRequestedMomentCount('i want 4 highlights')).toBe(4);
  });

  it('reads a number through a couple of describing words', () => {
    expect(parseRequestedMomentCount('find me 3 really funny moments for tiktok')).toBe(3);
    expect(parseRequestedMomentCount('get me a couple of clips for shorts')).toBe(2);
    expect(parseRequestedMomentCount('find me a few moments')).toBe(3);
  });

  /**
   * The expensive misread. "a 30 second clip" is one clip of thirty seconds,
   * and reading it as thirty clips would render thirty files for a request
   * that asked for one.
   */
  it('never mistakes a duration for a count', () => {
    expect(parseRequestedMomentCount('make it a 30 second clip for tiktok')).toBe(1);
    expect(parseRequestedMomentCount('make me a 45 second reel')).toBe(1);
    expect(parseRequestedMomentCount('find me 30 second clips for tiktok')).toBeNull();
  });

  /** Singular is a count, even with no digit in it. */
  it('reads a singular ask as one', () => {
    expect(parseRequestedMomentCount('find the best moment')).toBe(1);
    expect(parseRequestedMomentCount('give me a moment for reels')).toBe(1);
  });

  it('says nothing when the creator did not', () => {
    expect(parseRequestedMomentCount('find moments I can post')).toBeNull();
    expect(parseRequestedMomentCount('what happens in this video')).toBeNull();
  });
});

describe('resolvePlatformIntent requestedCount', () => {
  it('falls back to the default when unstated', () => {
    expect(resolvePlatformIntent('find moments for tiktok', 60).requestedCount).toBe(3);
    expect(resolvePlatformIntent('find moments for tiktok', 60, { defaultCount: 5 }).requestedCount).toBe(5);
  });

  /**
   * A creator can ask for forty. The pipeline will not render forty — each
   * one is a real GPU call and a real encode, and the ceiling is the bound
   * that stops one sentence from spending the afternoon.
   */
  it('never exceeds the render ceiling', () => {
    expect(resolvePlatformIntent('find me 40 moments for tiktok', 60, { maxCount: 8 }).requestedCount).toBe(8);
  });

  it('never drops below one', () => {
    expect(resolvePlatformIntent('find me 0 moments for tiktok', 60).requestedCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * The whole request read as one thing: a TikTok ask for three moments is
   * vertical, capped at 60 seconds, and owes three cards.
   */
  it('reads the target sentence completely', () => {
    const intent = resolvePlatformIntent('Find me 3 moments I can post on TikTok', 90);
    expect(intent.platform).toBe('tiktok');
    expect(intent.presentationTarget).toBe('vertical');
    expect(intent.requestedCount).toBe(3);
    expect(intent.hardMaxSeconds).toBe(60);
  });
});
