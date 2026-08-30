import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Set before any src module loads: `env` is read once at import, and this
 * file tests the MiniCPM side of the provider seam. Vitest gives each test
 * file its own module registry, so switching the provider here cannot leak
 * into the OpenRouter tests.
 */
process.env.VIDEO_PROVIDER = 'minicpm';
process.env.MODAL_TOKEN_ID = 'test-token-id';
process.env.MODAL_TOKEN_SECRET = 'test-token-secret';
process.env.MINICPM_MAX_RETRIES = '1';

/**
 * The Modal SDK is mocked at the module boundary: these tests are about
 * Clipit's provider — routing, classification, refusal rules, accounting —
 * not about Modal's transport. The mock mirrors the real call chain
 * (cls.fromName → instance → method → remote) and the real error classes.
 */
const remoteMock = vi.fn();

vi.mock('modal', () => {
  class InternalFailure extends Error {}
  class FunctionTimeoutError extends Error {}
  class NotFoundError extends Error {}
  class ExecutionError extends Error {}
  class RemoteError extends Error {}
  class InvalidError extends Error {}
  class ModalClient {
    cls = {
      fromName: vi.fn().mockResolvedValue({
        instance: vi.fn().mockResolvedValue({
          method: vi.fn().mockReturnValue({ remote: remoteMock }),
        }),
      }),
    };
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

beforeEach(async () => {
  remoteMock.mockReset();
  const { resetMiniCpmClient } = await import('../src/services/search/minicpmVideo.js');
  resetMiniCpmClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MiniCPM provider seam', () => {
  it('routes a video call through the Modal SDK and hands the result to the existing parser', async () => {
    remoteMock.mockResolvedValue({
      model: 'openbmb/MiniCPM-V-4.6',
      result: '{"matches":[{"start_seconds":10,"end_seconds":14,"description":"a drift","confidence":0.8}]}',
      metrics: { gpu: 'L4' },
    });

    const { searchVideoChunk } = await import('../src/services/search/openrouterVideo.js');
    const usage: unknown[] = [];
    const result = await searchVideoChunk({
      instruction: 'find the drift',
      mode: 'visual',
      chunkIndex: 2,
      chunkCount: 5,
      chunkDurationSeconds: 120,
      videoStorageKey: 'chunks/video-1/2.mp4',
      transcript: [],
      onUsage: (u) => usage.push(u),
    });

    // The answer flowed through the existing parser untouched.
    expect(result.matches[0]).toMatchObject({ startSeconds: 10, endSeconds: 14 });

    expect(remoteMock).toHaveBeenCalledTimes(1);
    const [args, kwargs] = remoteMock.mock.calls[0] as [unknown[], { video_url: string; prompt: string }];
    expect(args).toEqual([]);
    // A signed URL to the chunk — not base64 bytes, and not the bare key.
    expect(kwargs.video_url).toContain('chunks/video-1/2.mp4');
    expect(kwargs.video_url).toMatch(/^https:\/\//);
    expect(kwargs.prompt).toContain('find the drift');

    // The call is accounted even though MiniCPM reports no tokens.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ totalTokens: 0, costUsd: null, provider: 'modal' });
  });

  it('refuses to run a video call that carries no storage key rather than falling back silently', async () => {
    const { askVideoModel } = await import('../src/services/search/openrouterVideo.js');

    await expect(
      askVideoModel({
        chunkIndex: 0,
        chunkDurationSeconds: 120,
        systemPrompt: 'sys',
        parts: [{ type: 'text', text: 'anything' }],
        videoBytes: 0,
        purpose: 'search',
      }),
    ).rejects.toThrow(/storage key/);
    expect(remoteMock).not.toHaveBeenCalled();
  });

  it('does not retry a function timeout — the same chunk would overrun the same way at full GPU price', async () => {
    const modal = await import('modal');
    remoteMock.mockRejectedValue(new modal.FunctionTimeoutError('function timed out'));
    const { askMiniCpmVideo } = await import('../src/services/search/minicpmVideo.js');

    await expect(
      askMiniCpmVideo({
        chunkIndex: 0,
        chunkDurationSeconds: 120,
        systemPrompt: 'sys',
        parts: [{ type: 'text', text: 'find it' }],
        videoBytes: 0,
        purpose: 'search',
        videoStorageKey: 'chunks/video-1/0.mp4',
      }),
    ).rejects.toThrow(/Modal timeout/);
    expect(remoteMock).toHaveBeenCalledTimes(1);
  });

  it('retries an InternalFailure — the one class Modal documents as safe to retry — then succeeds', async () => {
    const modal = await import('modal');
    remoteMock
      .mockRejectedValueOnce(new modal.InternalFailure('worker preempted'))
      .mockResolvedValueOnce({ model: 'openbmb/MiniCPM-V-4.6', result: 'described' });
    const { askMiniCpmVideo } = await import('../src/services/search/minicpmVideo.js');

    const answer = await askMiniCpmVideo({
      chunkIndex: 1,
      chunkDurationSeconds: 120,
      systemPrompt: 'sys',
      parts: [{ type: 'text', text: 'describe it' }],
      videoBytes: 0,
      purpose: 'index',
      videoStorageKey: 'chunks/video-1/1.mp4',
    });
    expect(answer.content).toBe('described');
    expect(remoteMock).toHaveBeenCalledTimes(2);
  });

  it('re-looks-up a stale handle once when Modal answers not-found, without burning a retry', async () => {
    const modal = await import('modal');
    remoteMock
      .mockRejectedValueOnce(new modal.NotFoundError('function gone — app was redeployed'))
      .mockResolvedValueOnce({ model: 'openbmb/MiniCPM-V-4.6', result: 'described after re-lookup' });
    const { askMiniCpmVideo } = await import('../src/services/search/minicpmVideo.js');

    const answer = await askMiniCpmVideo({
      chunkIndex: 3,
      chunkDurationSeconds: 120,
      systemPrompt: 'sys',
      parts: [{ type: 'text', text: 'describe it' }],
      videoBytes: 0,
      purpose: 'index',
      videoStorageKey: 'chunks/video-1/3.mp4',
    });
    expect(answer.content).toBe('described after re-lookup');
    expect(remoteMock).toHaveBeenCalledTimes(2);
  });

  it('treats an empty result as a failure, never as "no moments here"', async () => {
    remoteMock.mockResolvedValue({ model: 'openbmb/MiniCPM-V-4.6', result: '' });
    const { askMiniCpmVideo } = await import('../src/services/search/minicpmVideo.js');

    await expect(
      askMiniCpmVideo({
        chunkIndex: 0,
        chunkDurationSeconds: 120,
        systemPrompt: 'sys',
        parts: [{ type: 'text', text: 'find it' }],
        videoBytes: 0,
        purpose: 'search',
        videoStorageKey: 'chunks/video-1/0.mp4',
      }),
    ).rejects.toThrow(/empty result/);
    // Empty is a contract problem, not a transient — one call, no retry.
    expect(remoteMock).toHaveBeenCalledTimes(1);
  });
});
