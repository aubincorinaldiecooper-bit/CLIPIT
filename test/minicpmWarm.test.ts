import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Warming the GPU is a latency-for-money trade, so the rules that keep it
 * from becoming a standing bill are the ones worth pinning:
 *
 *  - warming asks Modal to HOLD a container; it never runs a throwaway
 *    inference, which would burn GPU seconds and file a junk usage row;
 *  - cooling removes the FLOOR but keeps Modal's idle window, because the
 *    minutes right after a read are when questions arrive;
 *  - neither can ever throw at its caller — an upload must not fail because
 *    Modal was unreachable.
 */

const previousEnv = {
  videoProvider: process.env.VIDEO_PROVIDER,
  tokenId: process.env.MODAL_TOKEN_ID,
  tokenSecret: process.env.MODAL_TOKEN_SECRET,
  modalEnvironment: process.env.MODAL_ENVIRONMENT,
  warmIdle: process.env.MINICPM_WARM_IDLE_SECONDS,
};

process.env.VIDEO_PROVIDER = 'minicpm';
process.env.MODAL_TOKEN_ID = 'test-token-id';
process.env.MODAL_TOKEN_SECRET = 'test-token-secret';
process.env.MODAL_ENVIRONMENT = 'main';
process.env.MINICPM_WARM_IDLE_SECONDS = '300';

const updateAutoscalerMock = vi.fn();
const remoteMock = vi.fn();
const fromNameMock = vi.fn();
const instanceMock = vi.fn();
const methodMock = vi.fn();

vi.mock('modal', () => {
  class InternalFailure extends Error {}
  class FunctionTimeoutError extends Error {}
  class NotFoundError extends Error {}
  class ExecutionError extends Error {}
  class RemoteError extends Error {}
  class InvalidError extends Error {}
  class ModalClient {
    cls = { fromName: fromNameMock };
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

beforeEach(async () => {
  updateAutoscalerMock.mockReset().mockResolvedValue({});
  remoteMock.mockReset();
  fromNameMock.mockReset().mockResolvedValue({ instance: instanceMock });
  instanceMock.mockReset().mockResolvedValue({ method: methodMock });
  methodMock.mockReset().mockReturnValue({ remote: remoteMock, updateAutoscaler: updateAutoscalerMock });
  const { resetMiniCpmClient } = await import('../src/services/search/minicpmVideo.js');
  resetMiniCpmClient();
});

afterAll(() => {
  for (const [name, value] of [
    ['VIDEO_PROVIDER', previousEnv.videoProvider],
    ['MODAL_TOKEN_ID', previousEnv.tokenId],
    ['MODAL_TOKEN_SECRET', previousEnv.tokenSecret],
    ['MODAL_ENVIRONMENT', previousEnv.modalEnvironment],
    ['MINICPM_WARM_IDLE_SECONDS', previousEnv.warmIdle],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

describe('warmMiniCpm', () => {
  it('asks Modal to hold one container and never runs a throwaway inference', async () => {
    const { warmMiniCpm } = await import('../src/services/search/minicpmVideo.js');

    await warmMiniCpm('upload-reserved');

    expect(updateAutoscalerMock).toHaveBeenCalledWith({
      minContainers: 1,
      scaledownWindowMs: 300_000,
    });
    // The whole point of using the autoscaler: no GPU seconds are spent on a
    // dummy call, and no junk row reaches the usage table.
    expect(remoteMock).not.toHaveBeenCalled();
  });

  it('never throws at its caller — an upload must not fail because Modal is down', async () => {
    fromNameMock.mockRejectedValue(new Error('modal unreachable'));
    const { warmMiniCpm } = await import('../src/services/search/minicpmVideo.js');

    await expect(warmMiniCpm('upload-reserved')).resolves.toBeUndefined();
  });
});

describe('coolMiniCpm', () => {
  it('releases the floor but keeps the idle window, so a question right after a read stays warm', async () => {
    const { coolMiniCpm } = await import('../src/services/search/minicpmVideo.js');

    await coolMiniCpm('indexing-finished');

    expect(updateAutoscalerMock).toHaveBeenCalledWith({
      minContainers: 0,
      // Not zero: cooling must not kill the container out from under the
      // person who is about to ask something.
      scaledownWindowMs: 300_000,
    });
  });

  it('never throws — a failed read must still be able to stand the GPU down', async () => {
    fromNameMock.mockRejectedValue(new Error('modal unreachable'));
    const { coolMiniCpm } = await import('../src/services/search/minicpmVideo.js');

    await expect(coolMiniCpm('indexing-finished')).resolves.toBeUndefined();
  });
});

describe('under the OpenRouter provider', () => {
  it('does nothing at all — no autoscaler traffic for a lane that has no GPU', async () => {
    vi.resetModules();
    process.env.VIDEO_PROVIDER = 'openrouter';
    const { warmMiniCpm, coolMiniCpm } = await import('../src/services/search/minicpmVideo.js');

    await warmMiniCpm('upload-reserved');
    await coolMiniCpm('indexing-finished');

    expect(updateAutoscalerMock).not.toHaveBeenCalled();
    process.env.VIDEO_PROVIDER = 'minicpm';
    vi.resetModules();
  });
});
