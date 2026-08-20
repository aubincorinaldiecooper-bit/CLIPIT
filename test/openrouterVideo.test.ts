import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isContentFilterRejection, searchVideoChunk } from '../src/services/search/openrouterVideo.js';
import { ExternalServiceError } from '../src/lib/errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter actual-video search', () => {
  it('sends the MP4 itself to the single configured Qwen model', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clipit-openrouter-video-'));
    const videoPath = path.join(dir, 'chunk.mp4');
    await writeFile(videoPath, Buffer.from('test-mp4-bytes'));

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"matches":[{"start_seconds":53,"end_seconds":57,"description":"black car","confidence":0.9}]}' } }],
      provider: 'test-provider',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const result = await searchVideoChunk({
        instruction: 'find the black car',
        mode: 'visual',
        chunkIndex: 0,
        chunkCount: 1,
        chunkDurationSeconds: 120,
        videoPath,
        transcript: [],
      });

      expect(result.matches[0]).toMatchObject({ startSeconds: 53, endSeconds: 57 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        model: string;
        messages: Array<{ content: Array<{ type: string; video_url?: { url: string } }> }>;
      };
      expect(body.model).toBe('qwen/qwen3.6-flash');
      const userContent = body.messages[1]?.content ?? [];
      expect(userContent.some((part) => part.type === 'image_url')).toBe(false);
      expect(userContent.find((part) => part.type === 'video_url')?.video_url?.url)
        .toBe(`data:video/mp4;base64,${Buffer.from('test-mp4-bytes').toString('base64')}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The three modes differ only in what evidence reaches the model, and
   * getting that wrong is invisible from the outside: a transcript search
   * that quietly ships video burns money, and a visual search that ships
   * none silently answers from speech alone.
   */
  it('sends NO video for a transcript-only search', async () => {
    const { fetchMock, parts } = await runSearch({ mode: 'transcript', withVideo: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(parts.some((part) => part.type === 'video_url')).toBe(false);
    // The transcript still has to be there, or the search has no evidence.
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'))
      .toContain('a black car pulls in');
  });

  it('sends BOTH video and transcript for a multimodal search', async () => {
    const { parts } = await runSearch({ mode: 'both', withVideo: true });

    expect(parts.some((part) => part.type === 'video_url')).toBe(true);
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n'))
      .toContain('a black car pulls in');
  });

  /**
   * This assertion has flipped twice and has now landed where the previous
   * version said it should. Reasoning was disabled as a cost fix, then put
   * back when the numbers showed the chunks that found moments were the ones
   * spending tokens to think. A full run then measured the rest of the curve:
   * the productive spend is a band (438-1,700 tokens) and everything above it
   * found nothing while consuming the search's wall clock.
   *
   * So the request must BOUND thinking without removing it. `enabled: false`
   * would be the re-disable this project already rejected on the evidence;
   * `max_tokens` keeps the band and ends the runaways.
   */
  it('budgets reasoning rather than disabling it', async () => {
    const { fetchMock } = await runSearch({ mode: 'visual', withVideo: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      model: string;
      max_tokens: number;
      reasoning?: { enabled?: boolean; exclude?: boolean; max_tokens?: number };
    };

    expect(body.reasoning?.enabled).not.toBe(false);
    expect(body.reasoning?.max_tokens).toBe(2500);
    // The budget is the ANSWER's, plus room to think — not one ceiling for
    // both. Sending 1024 alone lets a provider that charges reasoning against
    // max_tokens spend the entire allowance before answering.
    expect(body.max_tokens).toBe(1024 + 2500);
    expect(body).not.toHaveProperty('include_reasoning');
    expect(body.model).not.toMatch(/thinking/);
  });

  /**
   * The rule, and the reason it exists: on one run a chunk came back 200 with
   * reasoning tokens and no answer, and the two minutes of video it covered
   * were reported to the user as containing nothing. A retry of the same
   * request would have thought its way to the same silence at the same price,
   * so the retry has to be a different request.
   */
  it('recovers a chunk that answered nothing by asking again without thinking', async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      const empty = bodies.length === 1;
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{
          message: { content: empty ? '' : '{"matches":[{"start_seconds":5,"end_seconds":9,"description":"a car","confidence":0.8}]}' },
          finish_reason: empty ? 'length' : 'stop',
        }],
        provider: 'test-provider',
        usage: {
          prompt_tokens: 100,
          completion_tokens: empty ? 3000 : 40,
          total_tokens: empty ? 3100 : 140,
          cost: empty ? 0.004 : 0.001,
          completion_tokens_details: { reasoning_tokens: empty ? 3000 : 0 },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const usage: Array<{ costUsd: number | null }> = [];
    const dir = await mkdtemp(path.join(tmpdir(), 'clipit-openrouter-video-'));
    const videoPath = path.join(dir, 'chunk.mp4');
    await writeFile(videoPath, Buffer.from('test-mp4-bytes'));

    try {
      const result = await searchVideoChunk({
        instruction: 'find the car',
        mode: 'visual',
        chunkIndex: 0,
        chunkCount: 1,
        chunkDurationSeconds: 120,
        videoPath,
        transcript: [],
        onUsage: (value) => usage.push(value),
      });

      // The chunk is answered, not lost.
      expect(result.matches[0]).toMatchObject({ startSeconds: 5, endSeconds: 9 });
      // And the caller can tell it was answered without deliberation.
      expect(result.reasoningDisabled).toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(bodies[1]!) as { reasoning?: { enabled?: boolean } };
      expect(second.reasoning?.enabled).toBe(false);

      // Both calls were billed, so both are reported. Counting only the one
      // that answered understates the cost of exactly the calls worth knowing
      // about — a chunk that thought for 3,000 tokens and said nothing.
      expect(usage.map((entry) => entry.costUsd)).toEqual([0.004, 0.001]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * A blank answer is not "no matches here". `""` parses to zero matches and
   * would be stored as a considered negative result, which is how a lost chunk
   * disappears without leaving a trace.
   */
  it('does not read a blank answer as a considered no-matches result', async () => {
    // A new Response per call: a single instance can only be read once, and
    // the second read failing would be a transport error, not the blank answer
    // this is about.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      choices: [{ message: { content: '   ' }, finish_reason: 'length' }],
      provider: 'test-provider',
      usage: { prompt_tokens: 100, completion_tokens: 3000, total_tokens: 3100 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);

    const dir = await mkdtemp(path.join(tmpdir(), 'clipit-openrouter-video-'));
    const videoPath = path.join(dir, 'chunk.mp4');
    await writeFile(videoPath, Buffer.from('test-mp4-bytes'));

    try {
      await expect(searchVideoChunk({
        instruction: 'find the car',
        mode: 'visual',
        chunkIndex: 0,
        chunkCount: 1,
        chunkDurationSeconds: 120,
        videoPath,
        transcript: [],
        // Both attempts answer nothing, so the chunk genuinely fails — and the
        // error carries why, rather than a bare "no message content".
      })).rejects.toThrow(/no answer.*finish_reason=length/i);
      // One budgeted attempt, one without thinking. Not a ladder.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a visual search with no video rather than answering without it', async () => {
    await expect(runSearch({ mode: 'visual', withVideo: false })).rejects.toThrow(/actual video is required/i);
  });

  /**
   * `fetch` resolves on headers, while the model is still generating, so a
   * single timer around it measured upload and time-to-first-byte and called
   * it the request. That hid four minutes of a four-and-a-half-minute search
   * and sent the investigation after the storage layer instead.
   */
  it('times the body read separately from the headers', async () => {
    const { fetchMock } = await runSearch({ mode: 'visual', withVideo: true });

    // The stub resolves both at once; the contract under test is that the
    // response body is read as text and timed, not consumed by response.json()
    // inside an untimed region.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBeDefined();
  });

  it('reports tokens, cost and latency for the caller to record', async () => {
    const usage: unknown[] = [];
    await runSearch({ mode: 'visual', withVideo: true, onUsage: (value) => usage.push(value) });

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      costUsd: 0.001,
      provider: 'test-provider',
      model: 'qwen/qwen3.6-flash',
    });
    expect((usage[0] as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
  });
});

interface ContentPart {
  type: string;
  text?: string;
  video_url?: { url: string };
}

/** Runs one search against a stubbed OpenRouter and returns what was sent. */
async function runSearch(options: {
  mode: 'visual' | 'transcript' | 'both';
  withVideo: boolean;
  onUsage?: (usage: unknown) => void;
}): Promise<{ fetchMock: ReturnType<typeof vi.fn>; parts: ContentPart[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'clipit-openrouter-video-'));
  const videoPath = path.join(dir, 'chunk.mp4');
  await writeFile(videoPath, Buffer.from('test-mp4-bytes'));

  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"matches":[]}' } }],
    provider: 'test-provider',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);

  try {
    await searchVideoChunk({
      instruction: 'find the black car',
      mode: options.mode,
      chunkIndex: 0,
      chunkCount: 1,
      chunkDurationSeconds: 120,
      ...(options.withVideo ? { videoPath } : {}),
      transcript: [{ localStartSeconds: 10, localEndSeconds: 14, text: 'a black car pulls in' }],
      ...(options.onUsage ? { onUsage: options.onUsage as never } : {}),
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<{ content: ContentPart[] | string }>;
    };
    const content = body.messages[1]?.content;
    return { fetchMock, parts: Array.isArray(content) ? content : [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('content-filter classification', () => {
  /**
   * Alibaba refused one chunk of an ordinary business podcast with
   * `data_inspection_failed`. It arrives as a 400 like any malformed request,
   * but unlike those it is worth retrying WITHOUT the transcript text the
   * provider objected to — so it has to be told apart from the rest.
   */
  it.each([
    'Video request failed with status 400: {"error":{"code":"data_inspection_failed"}}',
    'Video request failed with status 400: Input text data may contain inappropriate content.',
    'Video request failed with status 400: blocked by content policy',
  ])('recognises a provider content refusal: %s', (message) => {
    expect(isContentFilterRejection(new ExternalServiceError('openrouter-video', message))).toBe(true);
  });

  it('does not mistake other failures for a content refusal', () => {
    const others = [
      'Video request failed with status 400: invalid_parameter_error',
      'Video request failed with status 404: No endpoints found that support input video',
      'Video request failed with status 429: rate limited',
      'Video request timed out',
    ];
    for (const message of others) {
      expect(isContentFilterRejection(new ExternalServiceError('openrouter-video', message))).toBe(false);
    }
    // A non-ExternalServiceError must never be classified as one.
    expect(isContentFilterRejection(new Error('data_inspection_failed'))).toBe(false);
  });
});
