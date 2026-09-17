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
    await expect(source.completion).resolves.toEqual({ exhausted: true, reason: 'the video ended', watchedThroughSeconds: 2.5, mediaSecondsObserved: 1 });
  });

  it('does not claim a time-limited watch exhausted the video', async () => {
    const body = JSON.stringify({ type: 'ended', watched: true, reason: 'reached the time limit', framesSent: 0, lastPositionMs: 90000 }) + '\n';
    const source = createWebFrameStreamSource({ id: 'page-2', pageUrl: 'https://example.test/watch', webAccessUrl: 'http://web', webAccessToken: 'token', fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch });
    for await (const _ of source.open(new AbortController().signal)) void _;
    expect((await source.completion).exhausted).toBe(false);
  });

  it('sends the assigned section and coarse burst plan to web access', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requested = JSON.parse(String(init?.body));
      expect(requested).toMatchObject({
        pageUrl: 'https://example.test/watch',
        maxSeconds: 150,
        fps: 6,
        realtimeV2: true,
        startSeconds: 300,
        endSeconds: 450,
        scanMode: 'coarse',
        burstSeconds: 1,
        strideSeconds: 5,
      });
      const body = [
        JSON.stringify({ type: 'frame', video_ms: 300000, encoding: 'jpeg', image: Buffer.from('frame').toString('base64') }),
        JSON.stringify({ type: 'ended', watched: true, reason: 'completed assigned coarse range', framesSent: 1, lastPositionMs: 450000, rangeComplete: true, mediaSecondsObserved: 0.167 }),
      ].join('\n') + '\n';
      return new Response(body, { status: 200 });
    });
    const source = createWebFrameStreamSource({
      id: 'section',
      pageUrl: 'https://example.test/watch',
      webAccessUrl: 'http://web',
      webAccessToken: 'token',
      maxSeconds: 150,
      fps: 6,
      realtimeV2: true,
      startSeconds: 300,
      endSeconds: 450,
      scanMode: 'coarse',
      burstSeconds: 1,
      strideSeconds: 5,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const frames = [];
    for await (const frame of source.open(new AbortController().signal)) frames.push(frame);
    expect(frames[0]?.durationMs).toBe(167);
    expect(source.scanMode).toBe('coarse');
    await expect(source.completion).resolves.toEqual({
      exhausted: true,
      reason: 'completed assigned coarse range',
      watchedThroughSeconds: 450,
      mediaSecondsObserved: 0.167,
    });
  });
});
