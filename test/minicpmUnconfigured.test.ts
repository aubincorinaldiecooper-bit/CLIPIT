import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The one state the other MiniCPM file cannot test: no Modal credentials at
 * all. Vitest gives each file its own module registry, so leaving the token
 * unset here cannot leak into the configured suite — and the provider must
 * refuse before it ever constructs a client.
 */
const previousEnv = {
  videoProvider: process.env.VIDEO_PROVIDER,
  tokenId: process.env.MODAL_TOKEN_ID,
  tokenSecret: process.env.MODAL_TOKEN_SECRET,
};

process.env.VIDEO_PROVIDER = 'minicpm';
delete process.env.MODAL_TOKEN_ID;
delete process.env.MODAL_TOKEN_SECRET;

const constructed = vi.fn();
vi.mock('modal', () => {
  class InternalFailure extends Error {}
  class FunctionTimeoutError extends Error {}
  class NotFoundError extends Error {}
  class ExecutionError extends Error {}
  class RemoteError extends Error {}
  class InvalidError extends Error {}
  class ModalClient {
    constructor() {
      constructed();
    }
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

describe('MiniCPM without credentials', () => {
  it('refuses loudly and never mints an anonymous Modal client', async () => {
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
    ).rejects.toThrow(/not configured/);
    expect(constructed).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  restoreEnv('VIDEO_PROVIDER', previousEnv.videoProvider);
  restoreEnv('MODAL_TOKEN_ID', previousEnv.tokenId);
  restoreEnv('MODAL_TOKEN_SECRET', previousEnv.tokenSecret);
  vi.resetModules();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
