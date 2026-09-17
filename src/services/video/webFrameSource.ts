import type { FrameStreamCompletion, FrameStreamVideoSource, VideoFrame } from './source.js';

interface WatchFrameEvent { type: 'frame'; video_ms: number; encoding: 'jpeg' | 'png'; image: string; }
interface WatchEndedEvent { type: 'ended'; watched: boolean; reason: string; framesSent: number; lastPositionMs?: number; }
type WatchEvent = WatchFrameEvent | WatchEndedEvent;

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<WatchEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) yield JSON.parse(line) as WatchEvent;
      newline = buffered.indexOf('\n');
    }
  }
  const last = buffered.trim();
  if (last) yield JSON.parse(last) as WatchEvent;
}

export function createWebFrameStreamSource(input: {
  id: string;
  pageUrl: string;
  webAccessUrl: string;
  webAccessToken: string;
  maxSeconds?: number;
  fps?: number;
  realtimeV2?: boolean;
  fetchImpl?: typeof fetch;
}): FrameStreamVideoSource {
  const fps = input.fps ?? 1;
  // This is evidence time, not a browser sleep. At 6 fps one observation
  // represents about 167 ms, so a 200 ms floor would make our timestamps lie.
  const durationMs = Math.max(1, Math.round(1000 / Math.max(0.2, fps)));
  const doFetch = input.fetchImpl ?? fetch;
  let opened = false;
  let settle!: (completion: FrameStreamCompletion) => void;
  const completion = new Promise<FrameStreamCompletion>((resolve) => { settle = resolve; });

  return {
    kind: 'frame-stream',
    id: input.id,
    completion,
    open(signal: AbortSignal): AsyncIterable<VideoFrame> {
      if (opened) throw new Error('frame stream sources are single-use');
      opened = true;
      return (async function*() {
        let lastPositionMs = 0;
        let terminal = false;
        try {
          const response = await doFetch(new URL('/watch', input.webAccessUrl).toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-clipit-web-access-token': input.webAccessToken },
            body: JSON.stringify({
              pageUrl: input.pageUrl,
              maxSeconds: input.maxSeconds ?? 90,
              fps,
              realtimeV2: input.realtimeV2 === true,
            }),
            signal,
          });
          if (!response.ok || !response.body) throw new Error(`the browser refused to watch this page (${response.status})`);
          for await (const event of ndjson(response.body)) {
            if (signal.aborted) break;
            if (event.type === 'frame') {
              if (!Number.isFinite(event.video_ms) || event.video_ms < 0) continue;
              lastPositionMs = Math.max(lastPositionMs, event.video_ms);
              yield { timestampMs: event.video_ms, durationMs, encoding: event.encoding, image: Buffer.from(event.image, 'base64') };
              continue;
            }
            terminal = true;
            lastPositionMs = Math.max(lastPositionMs, event.lastPositionMs ?? 0);
            const done = {
              exhausted: event.watched && event.reason === 'the video ended',
              reason: event.reason,
              watchedThroughSeconds: lastPositionMs / 1000,
            };
            settle(done);
            if (!event.watched) throw new Error(event.reason);
            return;
          }
        } finally {
          if (!terminal) settle({ exhausted: false, reason: signal.aborted ? 'cancelled' : 'browser stream ended without a terminal event', watchedThroughSeconds: lastPositionMs / 1000 });
        }
      })();
    },
  };
}
