import { describe, expect, it } from 'vitest';
import { planReframe, reframeWindow } from '../src/services/media/reframe.js';

/**
 * One crop calculation. The export's filter and the API's composition block
 * both come from reframeWindow, so the window and the filter must agree
 * exactly — otherwise the card would position from one crop and the file
 * would carry another.
 */

describe('reframeWindow', () => {
  it('is the same window the export filter is built from', () => {
    const source = { width: 1920, height: 1080 };
    const format = { aspect: '9:16' as const, focusPct: 75 };
    const window = reframeWindow(format, source)!;
    expect(planReframe(format, source).filter).toBe(`crop=${window.width}:${window.height}:${window.x}:${window.y}`);
  });

  it('keeps the full height of a landscape frame and slides along x', () => {
    const window = reframeWindow({ aspect: '9:16', focusPct: 75 }, { width: 1920, height: 1080 })!;
    expect(window.height).toBe(1080);
    // 1080 * 9/16 = 607.5, floored to the even 606 that H.264 can encode.
    expect(window.width).toBe(606);
    expect(window.y).toBe(0);
    // Centre at 75% of 1920 = 1440, less half the window.
    expect(window.x).toBe(1137);
  });

  it('never leaves the frame at either extreme', () => {
    const left = reframeWindow({ aspect: '9:16', focusPct: 0 }, { width: 1920, height: 1080 })!;
    const right = reframeWindow({ aspect: '9:16', focusPct: 100 }, { width: 1920, height: 1080 })!;
    expect(left.x).toBe(0);
    expect(right.x + right.width).toBe(1920);
  });

  it('is null when nothing is cut', () => {
    expect(reframeWindow({ aspect: '9:16', focusPct: 50 }, { width: 1080, height: 1920 })).toBeNull();
    expect(reframeWindow({ aspect: 'source' }, { width: 1920, height: 1080 })).toBeNull();
    expect(reframeWindow({ aspect: '9:16', focusPct: 50 }, { width: 0, height: 0 })).toBeNull();
  });
});
