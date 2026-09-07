import { describe, expect, it } from 'vitest';
import { clipMediaContract, creatorVisibleVerticalRows, type ClipMediaRow } from '../src/api/mediaContract.js';

/**
 * One place decides what media a client sees, and it never lies about which
 * file it is handing over. The substitution these tests exist to prevent —
 * a landscape clip quietly taking the playback slot a 9:16 derivative was
 * promised — is the kind that happens in a serializer without anyone
 * deciding to do it.
 */

const row = (over: Partial<ClipMediaRow> = {}): ClipMediaRow => ({
  canonicalUrl: 'https://cdn/canonical.mp4',
  canonicalDownloadUrl: 'https://cdn/canonical.mp4?download=1',
  derivativeUrl: 'https://cdn/vertical.mp4',
  derivativeDownloadUrl: 'https://cdn/vertical.mp4?download=1',
  derivativeStorageKey: 'clips/v/c-vertical.mp4',
  derivativeStatus: 'ready',
  posterUrl: 'https://cdn/poster.jpg',
  posterStorageKey: 'posters/v/c.jpg',
  posterTimestampSeconds: 5,
  sourceWidth: 1920,
  sourceHeight: 1080,
  outputWidth: 1080,
  outputHeight: 1920,
  compositionMode: 'smart_crop',
  focalX: 0.75,
  focalY: 0.5,
  ...over,
});

describe('clipMediaContract — vertical', () => {
  it('plays the derivative and reports the real geometry', () => {
    const media = clipMediaContract(row(), true);
    expect(media.url).toBe('https://cdn/vertical.mp4');
    expect(media.canonicalUrl).toBe('https://cdn/canonical.mp4');
    expect(media.sourceAspectRatio).toBe('16:9');
    expect(media.outputAspectRatio).toBe('9:16');
    expect(media.compositionMode).toBe('smart_crop');
    expect(media.derivativeStatus).toBe('ready');
  });

  it('offers the same file to save as it offers to play', () => {
    expect(clipMediaContract(row(), true).downloadUrl).toBe('https://cdn/vertical.mp4?download=1');
    expect(clipMediaContract(row(), false).downloadUrl).toBe('https://cdn/canonical.mp4?download=1');
    // A vertical moment whose 9:16 file has not landed has nothing to save —
    // not the landscape cut, which is not what was kept.
    expect(
      clipMediaContract(row({ derivativeStatus: 'pending', derivativeStorageKey: null, derivativeUrl: null, derivativeDownloadUrl: null }), true).downloadUrl,
    ).toBeNull();
  });

  it('keeps canonicalUrl as the original excerpt, never overwritten', () => {
    // A client that deliberately wants source framing can still have it.
    expect(clipMediaContract(row(), true).canonicalUrl).toBe('https://cdn/canonical.mp4');
  });

  it('does NOT put the landscape file in the playback slot when the render failed', () => {
    const media = clipMediaContract(
      row({ derivativeStatus: 'failed', derivativeStorageKey: null, derivativeUrl: null }),
      true,
    );
    // This row should never reach a creator at all — but if it does, it must
    // not claim to be the vertical asset that was promised.
    expect(media.url).not.toBe('https://cdn/vertical.mp4');
    expect(media.compositionMode).toBe('original');
    expect(media.derivativeStatus).toBe('failed');
  });

  it('reports composition as original when the derivative is still pending', () => {
    const media = clipMediaContract(
      row({ derivativeStatus: 'pending', derivativeStorageKey: null, derivativeUrl: null }),
      true,
    );
    // Never the mode that was ATTEMPTED — that would describe a file that
    // does not exist yet.
    expect(media.compositionMode).toBe('original');
    expect(media.outputAspectRatio).toBe('16:9');
  });

  /**
   * This test used to assert `url` was the canonical clip — it pinned the
   * exact substitution the contract forbids, because it was written to match
   * the code rather than the rule. A vertical moment with no finished
   * derivative has nothing to play, and that is what it must say.
   */
  it('distrusts a ready label with no file behind it', () => {
    const media = clipMediaContract(row({ derivativeStorageKey: null }), true);
    expect(media.url).toBeNull();
    // Still reachable deliberately, by name, for a caller that wants it.
    expect(media.canonicalUrl).toBe('https://cdn/canonical.mp4');
    expect(media.compositionMode).toBe('original');
  });
});

describe('clipMediaContract — non-vertical requests are untouched', () => {
  it('plays the canonical clip and reports source framing', () => {
    const media = clipMediaContract(row(), false);
    expect(media.url).toBe('https://cdn/canonical.mp4');
    expect(media.outputAspectRatio).toBe('16:9');
    expect(media.compositionMode).toBe('original');
    // No derivative was owed, so there is no status to report.
    expect(media.derivativeStatus).toBeNull();
  });
});

describe('creatorVisibleVerticalRows — the backend is authoritative', () => {
  const withId = (id: string, over: Partial<ClipMediaRow> = {}) => ({
    ...row(over), matchId: id, confidence: 0.9,
  });

  it('emits only rows whose media is genuinely finished', () => {
    const rows = [
      withId('ready'),
      withId('pending', { derivativeStatus: 'pending', derivativeStorageKey: null }),
      withId('failed', { derivativeStatus: 'failed', derivativeStorageKey: null }),
      withId('noposter', { posterStorageKey: null }),
    ];
    expect(creatorVisibleVerticalRows(rows).map((r) => r.matchId)).toEqual(['ready']);
  });

  it('a client that forgets to filter still cannot leak a half-made moment', () => {
    const rows = [withId('pending', { derivativeStatus: 'pending', derivativeStorageKey: null })];
    // Nothing leaves here to be leaked.
    expect(creatorVisibleVerticalRows(rows)).toEqual([]);
  });
});

describe('clipMediaContract — composition, the one framing everything derives from', () => {
  it('recomputes the export window from the stored focal point', () => {
    const media = clipMediaContract(row(), true);
    expect(media.composition.aspectRatio).toBe('9:16');
    expect(media.composition.mode).toBe('smart_crop');
    expect(media.composition.focusPct).toBe(75);
    // 606 of 1920 wide, starting at 1137: the window reframeWindow gives a
    // 1920x1080 source at focus 75, normalised.
    expect(media.composition.crop).toEqual({ x: 0.5922, y: 0, width: 0.3156, height: 1 });
  });

  it('is centred and uncut for the safe composition', () => {
    const media = clipMediaContract(row({ compositionMode: 'blurred_background' }), true);
    expect(media.composition.mode).toBe('blurred_background');
    expect(media.composition.focusPct).toBe(50);
    expect(media.composition.crop).toBeNull();
  });

  it('is centred while the derivative is still pending, but already 9:16', () => {
    const media = clipMediaContract(row({ derivativeStatus: 'pending', derivativeUrl: null }), true);
    expect(media.composition.aspectRatio).toBe('9:16');
    expect(media.composition.mode).toBe('original');
    expect(media.composition.crop).toBeNull();
  });

  it('keeps the source shape for a moment that was never vertical', () => {
    const media = clipMediaContract(row(), false);
    expect(media.composition.aspectRatio).toBe('16:9');
    expect(media.composition.mode).toBe('original');
    expect(media.composition.crop).toBeNull();
  });
});
