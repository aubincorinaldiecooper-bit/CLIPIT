import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Set before any src module loads: `env` is read once at import, and this
 * file tests the MiniCPM side of the provider seam. Vitest gives each test
 * file its own module registry, so switching the provider here cannot leak
 * into the OpenRouter tests.
 */
process.env.VIDEO_PROVIDER = 'minicpm';
process.env.MINICPM_VIDEO_URL = 'https://example--minicpm-v46-minicpm-analyze.modal.run';
process.env.MODAL_PROXY_TOKEN_ID = 'test-token-id';
process.env.MODAL_PROXY_TOKEN_SECRET = 'test-token-secret';
process.env.MINICPM_MAX_RETRIES = '1';

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = (payload: unknown) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('MiniCPM provider seam', () => {
  it('routes a video call to Modal with proxy auth and a signed URL, and hands back raw text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ok({ model: 'openbmb/MiniCPM-V-4.6', result: '{"matches":[{"start_seconds":10,"end_seconds":14,"description":"a drift","confidence":0.8}]}' }),
    );
    vi.stubGlobal('fetch', fetchMock);

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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example--minicpm-v46-minicpm-analyze.modal.run');
    const headers = init.headers as Record<string, string>;
    expect(headers['Modal-Key']).toBe('test-token-id');
    expect(headers['Modal-Secret']).toBe('test-token-secret');

    const body = JSON.parse(String(init.body)) as { video_url: string; prompt: string };
    // A signed URL to the chunk — not base64 bytes, and not the bare key.
    expect(body.video_url).toContain('chunks/video-1/2.mp4');
    expect(body.video_url).toMatch(/^https:\/\//);
    expect(body.prompt).toContain('find the drift');

    // The call is accounted even though MiniCPM reports no tokens.
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ totalTokens: 0, costUsd: null, provider: 'modal' });
  });

  it('refuses to run a video call that carries no storage key rather than falling back silently', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a rejected proxy token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
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
    ).rejects.toThrow(/proxy rejected/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on a 429, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(ok({ model: 'openbmb/MiniCPM-V-4.6', result: 'described' }));
    vi.stubGlobal('fetch', fetchMock);
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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an empty result as a failure, never as "no moments here"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ model: 'openbmb/MiniCPM-V-4.6', result: '' }));
    vi.stubGlobal('fetch', fetchMock);
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
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
