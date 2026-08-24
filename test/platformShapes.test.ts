import { describe, expect, it } from 'vitest';
import { aspectOfSource, groupTargetsByShape, shapeForPlatform } from '../src/services/media/platformShapes.js';

/**
 * The promise here is that a person never has to think about aspect ratios.
 * These tests hold the two halves of that: every platform gets the shape it
 * wants, and nothing is cropped that does not need to be.
 */

describe('shapeForPlatform', () => {
  it('knows where vertical is expected', () => {
    expect(shapeForPlatform('tiktok')).toBe('9:16');
    expect(shapeForPlatform('instagram')).toBe('9:16');
    expect(shapeForPlatform('youtube')).toBe('16:9');
  });

  it('has no opinion about a platform it does not know', () => {
    // Better to post the clip as shot than to crop it on a guess.
    expect(shapeForPlatform('mastodon')).toBeNull();
  });
});

describe('aspectOfSource', () => {
  it('recognises the shapes it cuts to', () => {
    expect(aspectOfSource(1920, 1080)).toBe('16:9');
    expect(aspectOfSource(1080, 1920)).toBe('9:16');
    expect(aspectOfSource(1080, 1080)).toBe('1:1');
    expect(aspectOfSource(1080, 1350)).toBe('4:5');
  });

  it('tolerates a frame that is a hair off', () => {
    expect(aspectOfSource(1078, 1918)).toBe('9:16');
  });

  it('says nothing about an unusual shape or an unknown frame', () => {
    expect(aspectOfSource(2560, 1080)).toBeNull();
    expect(aspectOfSource(null, null)).toBeNull();
    expect(aspectOfSource(0, 0)).toBeNull();
  });
});

describe('groupTargetsByShape', () => {
  const tiktok = { platform: 'tiktok', accountId: 'a' };
  const instagram = { platform: 'instagram', accountId: 'b' };
  const youtube = { platform: 'youtube', accountId: 'c' };

  it('sends one file when everything wants the same shape', () => {
    const groups = groupTargetsByShape([tiktok, instagram], '16:9');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.aspect).toBe('9:16');
    expect(groups[0]!.targets).toHaveLength(2);
  });

  it('splits platforms that want different shapes into separate posts', () => {
    // The publishing API takes one file per post, so this HAS to become two.
    const groups = groupTargetsByShape([tiktok, youtube], '16:9');
    expect(groups).toHaveLength(2);
    const vertical = groups.find((group) => group.aspect === '9:16');
    const asShot = groups.find((group) => group.aspect === null);
    expect(vertical!.targets).toEqual([tiktok]);
    // YouTube wants 16:9 and the clip already IS 16:9 — no crop, no re-render.
    expect(asShot!.targets).toEqual([youtube]);
  });

  it('never crops a clip that is already the right shape', () => {
    const groups = groupTargetsByShape([tiktok, instagram], '9:16');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.aspect).toBeNull();
  });

  it('posts an unknown platform exactly as the clip was shot', () => {
    const groups = groupTargetsByShape([{ platform: 'mastodon' }], '16:9');
    expect(groups[0]!.aspect).toBeNull();
  });

  it('handles a source whose shape is unknown by cutting to what is asked', () => {
    const groups = groupTargetsByShape([tiktok], null);
    expect(groups[0]!.aspect).toBe('9:16');
  });
});
