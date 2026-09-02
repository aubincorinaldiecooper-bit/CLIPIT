import { describe, expect, it } from 'vitest';
import { interpretProbe, probeRotation } from '../src/services/media/ffmpeg.js';

/**
 * A phone held upright records 1920x1080 and marks the stream "turn me".
 * Players honour the mark; so does ffmpeg when it decodes. The CODED size
 * still says landscape, and reading it raw plans a landscape crop for a
 * portrait video. The probe reports DISPLAY dimensions, from either way the
 * mark has been written.
 */

const stream = (over: Record<string, unknown> = {}) => ({
  codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', ...over,
});

describe('probeRotation', () => {
  it('reads a display matrix (the modern form, counter-clockwise degrees)', () => {
    expect(probeRotation(stream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }))).toBe(270);
    expect(probeRotation(stream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }))).toBe(90);
    expect(probeRotation(stream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -180 }] }))).toBe(180);
  });

  it('reads the legacy rotate tag (a string of clockwise degrees)', () => {
    expect(probeRotation(stream({ tags: { rotate: '90' } }))).toBe(90);
    expect(probeRotation(stream({ tags: { rotate: '270' } }))).toBe(270);
  });

  it('prefers the matrix when both are present, and is 0 with neither', () => {
    expect(probeRotation(stream({ tags: { rotate: '90' }, side_data_list: [{ rotation: 0 }] }))).toBe(0);
    expect(probeRotation(stream())).toBe(0);
    expect(probeRotation(undefined)).toBe(0);
  });
});

describe('interpretProbe', () => {
  it('swaps to display dimensions for a turned file', () => {
    const probe = interpretProbe({
      streams: [stream({ side_data_list: [{ rotation: -90 }] })],
      format: { duration: '12.5', size: '100' },
    } as never);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.rotation).toBe(270);
  });

  it('leaves an upright file alone', () => {
    const probe = interpretProbe({ streams: [stream()], format: { duration: '12.5' } } as never);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.rotation).toBe(0);
  });

  it('does not swap for a half turn', () => {
    const probe = interpretProbe({ streams: [stream({ tags: { rotate: '180' } })], format: {} } as never);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    expect(probe.rotation).toBe(180);
  });
});
