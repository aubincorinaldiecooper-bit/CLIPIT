import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertVideoInputSupported, resetVideoModelCapabilityCache } from '../src/services/search/modelCapabilities.js';

/** The slug `env.OPENROUTER_VIDEO_MODEL` defaults to in test config. */
const CONFIGURED_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';

/** Verbatim shape of the refusal seen in production. */
const NO_VIDEO_ENDPOINT = JSON.stringify({
  error: { message: 'No endpoints found that support input video', code: 404 },
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetVideoModelCapabilityCache();
});

/**
 * Routes the probe (POST /chat/completions) and the suggestion lookup
 * (GET /models) to separate responses, so a test can say what each returns.
 */
function stubOpenRouter(options: {
  probe: Response | Error;
  candidates?: Array<{ id: string; modalities: string[] }>;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/models')) {
      return new Response(
        JSON.stringify({
          data: (options.candidates ?? []).map((entry) => ({
            id: entry.id,
            architecture: { input_modalities: entry.modalities },
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (options.probe instanceof Error) throw options.probe;
    return options.probe.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as ReturnType<typeof vi.fn>;
}

function ok(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
}

describe('video routing preflight', () => {
  it('passes when OpenRouter routes a video request', async () => {
    stubOpenRouter({ probe: ok() });

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  /**
   * The production failure: OpenRouter refuses the model at the routing layer,
   * after every chunk has already uploaded megabytes of base64 MP4.
   */
  it('fails before any chunk uploads when no endpoint accepts video', async () => {
    stubOpenRouter({
      probe: new Response(NO_VIDEO_ENDPOINT, { status: 404 }),
      candidates: [{ id: 'vendor/sees-video', modalities: ['text', 'image', 'video'] }],
    });

    await expect(assertVideoInputSupported()).rejects.toThrow(
      /no OpenRouter endpoint accepting video input.*vendor\/sees-video/s,
    );
  });

  it('marks that failure terminal so the job does not retry a config error', async () => {
    stubOpenRouter({ probe: new Response(NO_VIDEO_ENDPOINT, { status: 404 }) });

    await expect(assertVideoInputSupported()).rejects.toMatchObject({ retryable: false });
  });

  /**
   * The decisive case for probing rather than reading the catalogue: a model
   * can advertise video input and still have no endpoint routing it. Trusting
   * `input_modalities` would let exactly the broken configuration through.
   */
  it('rejects a model that advertises video but does not route it', async () => {
    stubOpenRouter({
      probe: new Response(NO_VIDEO_ENDPOINT, { status: 404 }),
      candidates: [{ id: CONFIGURED_MODEL, modalities: ['text', 'image', 'video'] }],
    });

    await expect(assertVideoInputSupported()).rejects.toThrow(/has no OpenRouter endpoint/);
  });

  /**
   * Exhausted credits are a billing problem, not a capability problem, and
   * reporting one as the other sends the user to fix the wrong thing.
   */
  it('does not read exhausted credits as missing video support', async () => {
    stubOpenRouter({
      probe: new Response(JSON.stringify({ error: { message: 'requires at least $0.50 in balance' } }), {
        status: 402,
      }),
    });

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  it('does not read rate limiting as missing video support', async () => {
    stubOpenRouter({ probe: new Response('{"error":{"message":"rate limited"}}', { status: 429 }) });

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  /** A diagnostic must not be able to take down search on its own. */
  it('allows the search through when the probe cannot be sent', async () => {
    stubOpenRouter({ probe: new Error('network down') });

    await expect(assertVideoInputSupported()).resolves.toBeUndefined();
  });

  it('still reports the failure when no replacement candidates can be listed', async () => {
    stubOpenRouter({ probe: new Response(NO_VIDEO_ENDPOINT, { status: 404 }), candidates: [] });

    await expect(assertVideoInputSupported()).rejects.toThrow(/has no OpenRouter endpoint accepting video/);
  });

  it('probes once and reuses the verdict across searches', async () => {
    const fetchMock = stubOpenRouter({ probe: ok() });

    await assertVideoInputSupported();
    await assertVideoInputSupported();
    await assertVideoInputSupported();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache an inconclusive probe', async () => {
    stubOpenRouter({ probe: new Error('network down') });
    await assertVideoInputSupported();

    const recovered = stubOpenRouter({ probe: ok() });
    await assertVideoInputSupported();

    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('sends the probe as a real video request with a negligible token budget', async () => {
    const fetchMock = stubOpenRouter({ probe: ok() });
    await assertVideoInputSupported();

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model: string;
      max_tokens: number;
      messages: Array<{ content: Array<{ type: string; video_url?: { url: string } }> }>;
    };

    expect(body.model).toBe(CONFIGURED_MODEL);
    expect(body.max_tokens).toBe(1);
    const video = body.messages[0]?.content.find((part) => part.type === 'video_url');
    expect(video?.video_url?.url).toMatch(/^data:video\/mp4;base64,/);
    // Small enough that the check costs nothing meaningful per worker.
    expect(video?.video_url?.url.length).toBeLessThan(4_000);
  });

  /**
   * The probe payload is a base64 literal in the source. A typo in it would
   * not fail any other test — it would just make every probe inconclusive,
   * quietly disabling the guard.
   */
  it('sends a structurally valid MP4, not a corrupted literal', async () => {
    const fetchMock = stubOpenRouter({ probe: ok() });
    await assertVideoInputSupported();

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<{ content: Array<{ type: string; video_url?: { url: string } }> }>;
    };
    const url = body.messages[0]?.content.find((part) => part.type === 'video_url')?.video_url?.url ?? '';
    const mp4 = Buffer.from(url.replace(/^data:video\/mp4;base64,/, ''), 'base64');

    // An ISO base media file opens with a length-prefixed 'ftyp' box.
    expect(mp4.subarray(4, 8).toString('ascii')).toBe('ftyp');
    expect(mp4.readUInt32BE(0)).toBeLessThanOrEqual(mp4.length);
    // 'mdat' is the frame data itself; without it there is no video to route.
    expect(mp4.includes(Buffer.from('mdat', 'ascii'))).toBe(true);
    expect(mp4.length).toBeGreaterThan(500);
  });
});
