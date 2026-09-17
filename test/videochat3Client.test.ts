import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeModal = vi.fn();

vi.mock('../src/services/modal/invoke.js', () => ({
  invokeModal,
}));

const { watchWithVideoChat3, verifyWithVideoChat3 } = await import('../src/services/videochat3/client.js');

describe('VideoChat3 Modal client contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries how sure the watcher said it was, and only when it is usable', async () => {
    invokeModal.mockResolvedValue({
      ok: true,
      model: 'MCG-NJU/VideoChat3-4B',
      revision: '37fa901',
      duration_seconds: 60,
      events: [
        { start: 1, end: 2, description: 'said so', confidence: 0.8 },
        { start: 3, end: 4, description: 'said nothing' },
        { start: 5, end: 6, description: 'said something silly', confidence: 4.2 },
        { start: 7, end: 8, description: 'said a word', confidence: 'very' },
        { start: 9, end: 10, description: 'said the floor', confidence: 0 },
      ],
      metrics: {},
    });

    const watched = await watchWithVideoChat3({ videoUrl: 'https://example.test/v.mp4', query: 'anything' });

    // Out of range and not-a-number are dropped rather than squeezed into
    // shape: a number that arrived wrong is not evidence of anything.
    expect(watched.events.map((event) => event.confidence)).toEqual([0.8, undefined, undefined, undefined, 0]);
    // Zero is a real answer and survives; saying nothing is absent, not zero.
    expect('confidence' in watched.events[1]!).toBe(false);
    expect(watched.events[4]!.confidence).toBe(0);
  });

  it('sends expected_bytes to watch, matching the deployed Python method', async () => {
    invokeModal.mockResolvedValue({
      ok: true,
      model: 'MCG-NJU/VideoChat3-4B',
      revision: '37fa901',
      duration_seconds: 3,
      events: [],
      metrics: {},
    });

    await watchWithVideoChat3({
      videoUrl: 'https://media.example/video.mp4',
      query: 'what happens?',
      expectedBytes: 1234,
    });

    expect(invokeModal).toHaveBeenCalledOnce();
    const kwargs = invokeModal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(kwargs.expected_bytes).toBe(1234);
    expect(kwargs).not.toHaveProperty('expect_bytes');
  });

  it('sends expected_bytes to verify_intervals, matching the deployed Python method', async () => {
    invokeModal.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: '37fa901',
      results: [],
      failed: [{ id: 'candidate-1', reason: 'fixture failure' }],
      metrics: {},
    });

    await verifyWithVideoChat3({
      videoUrl: 'https://media.example/video.mp4',
      query: 'find the sign',
      expectedBytes: 5678,
      candidates: [{ id: 'candidate-1', start: 1, end: 2 }],
    });

    expect(invokeModal).toHaveBeenCalledOnce();
    const kwargs = invokeModal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(kwargs.expected_bytes).toBe(5678);
    expect(kwargs).not.toHaveProperty('expect_bytes');
  });
});
