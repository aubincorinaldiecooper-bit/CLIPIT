import { describe, expect, it, vi } from 'vitest';
import { createWebFrameStreamSource } from '../src/services/video/webFrameSource.js';

describe('web frame source', () => {
  it('turns browser NDJSON into timestamped frames and preserves real completion', async () => {
    const body = [
      JSON.stringify({ type: 'frame', video_ms: 2500, encoding: 'jpeg', image: Buffer.from('frame').toString('base64') }),
      JSON.stringify({ type: 'ended', watched: true, reason: 'the video ended', framesSent: 1, lastPositionMs: 2500 }),
    ].join('\n') + '\n';
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    const source = createWebFrameStreamSource({ id: 'page-1', pageUrl: 'https://example.test/watch', webAccessUrl: 'http://web', webAccessToken: 'token', fps: 1, fetchImpl: fetchImpl as typeof fetch });
    const frames = [];
    for await (const frame of source.open(new AbortController().signal)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ timestampMs: 2500, durationMs: 1000, encoding: 'jpeg' });
    await expect(source.completion).resolves.toEqual({ exhausted: true, reason: 'the video ended', watchedThroughSeconds: 2.5 });
  });

  it('does not claim a time-limited watch exhausted the video', async () => {
    const body = JSON.stringify({ type: 'ended', watched: true, reason: 'reached the time limit', framesSent: 0, lastPositionMs: 90000 }) + '\n';
    const source = createWebFrameStreamSource({ id: 'page-2', pageUrl: 'https://example.test/watch', webAccessUrl: 'http://web', webAccessToken: 'token', fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch });
    for await (const _ of source.open(new AbortController().signal)) void _;
    expect((await source.completion).exhausted).toBe(false);
  });
});
