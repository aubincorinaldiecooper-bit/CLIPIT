import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchVideoChunk } from '../src/services/search/openrouterVideo.js';

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
   * Thinking mode is off by choice, not by luck: reasoning tokens add latency
   * and cost to a task whose whole output is a short JSON array, and they can
   * arrive as prose the strict parser then has to reject. Nothing in the
   * request asks for reasoning, and this keeps it that way across model
   * changes — including to a slug whose default might differ.
   */
  it('never asks the model to reason', async () => {
    const { fetchMock } = await runSearch({ mode: 'visual', withVideo: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, unknown> & { model: string };

    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('include_reasoning');
    expect(body.model).not.toMatch(/thinking/);
  });

  it('refuses a visual search with no video rather than answering without it', async () => {
    await expect(runSearch({ mode: 'visual', withVideo: false })).rejects.toThrow(/actual video is required/i);
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
