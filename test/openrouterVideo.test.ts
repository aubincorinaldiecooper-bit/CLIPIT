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
      expect(body.model).toBe('qwen/qwen3-vl-32b-instruct');
      const userContent = body.messages[1]?.content ?? [];
      expect(userContent.some((part) => part.type === 'image_url')).toBe(false);
      expect(userContent.find((part) => part.type === 'video_url')?.video_url?.url)
        .toBe(`data:video/mp4;base64,${Buffer.from('test-mp4-bytes').toString('base64')}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
