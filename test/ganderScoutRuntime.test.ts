import { describe, expect, it } from 'vitest';
import { createGanderScoutRuntime, type PageCandidate } from '../src/services/retrieval/ganderScoutRuntime.js';
import { ThinkerSlot } from '../src/services/scout/ganderSlot.js';
import type { GanderChunk, GanderSession } from '../src/services/scout/ganderSession.js';
import { frameIdForPosition } from '../src/services/scout/ganderSession.js';

/** A Gander that says whatever the test tells it to, when the frames arrive. */
function fakeSession(script: (sent: { frameIds: string[]; audioUnits: number }) => GanderChunk[]) {
  const sent = { frameIds: [] as string[], audioUnits: 0 };
  let closed = false;
  let asked: string | null = null;
  const session = {
    ready: {
      sessionId: 's1',
      resumeToken: null,
      inputSampleRate: 16_000,
      chunkMs: 1_000,
      screen: { enabled: true, token: 't', maxFrameBytes: 900_000, maxPixels: 0, recommendedFrameRate: 1, encodings: ['jpeg'] },
    },
    async ask(text: string) {
      asked = text;
    },
    sendFrame(input: { videoMs: number }) {
      const id = frameIdForPosition(input.videoMs, sent.frameIds.length + 1);
      sent.frameIds.push(id);
      return id;
    },
    sendAudio() {
      sent.audioUnits += 1;
    },
    async *chunks() {
      // Nothing is said until the page has been fed; the runtime reads this
      // stream concurrently with sending, exactly as it does for real. And
      // like the real one, this stream ends when the session is closed —
      // otherwise a watch that never produced a frame would hang here rather
      // than finishing, which the real socket's close event prevents.
      while (sent.frameIds.length === 0 && !closed) await new Promise((resolve) => setTimeout(resolve, 1));
      if (closed) return;
      for (const chunk of script(sent)) yield chunk;
    },
    close() {
      closed = true;
    },
  };
  return {
    session: session as unknown as GanderSession,
    sent,
    get closed() {
      return closed;
    },
    get asked() {
      return asked;
    },
  };
}

/** A browser container that streams the frames a test describes. */
function fakeWatch(lines: unknown[]) {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          controller.close();
        },
      }),
      { status: 200 },
    );
}

function frameLine(videoMs: number) {
  return { type: 'frame', video_ms: videoMs, encoding: 'jpeg', image: Buffer.from('jpeg-bytes').toString('base64') };
}

const candidate: PageCandidate = { id: 'c1', pageUrl: 'https://publisher.example/watch/1' };

function runtimeWith(options: {
  chunks: (sent: { frameIds: string[]; audioUnits: number }) => GanderChunk[];
  lines: unknown[];
  slot?: ThinkerSlot;
}) {
  const fake = fakeSession(options.chunks);
  const runtime = createGanderScoutRuntime({
    webAccessUrl: 'http://web-access.internal:8080',
    webAccessToken: 'token',
    ganderUrl: 'https://gander.example',
    ganderApiKey: 'key',
    slot: options.slot,
    // Short, so a test that scripts no reply is not seven seconds of waiting.
    trailingDrainMs: 20,
    openSession: async () => fake.session,
    fetchImpl: fakeWatch(options.lines) as unknown as typeof fetch,
  });
  return { runtime, fake };
}

function inspect(runtime: ReturnType<typeof createGanderScoutRuntime>, signal = new AbortController().signal) {
  return runtime.inspect({ scoutId: 'scout-1', searchId: 'search-1', query: 'a dog on a skateboard', candidate, signal });
}

describe('the scout runtime: a page, played, watched', () => {
  it('returns a moment whose times come from the frames the model consumed', async () => {
    const { runtime } = runtimeWith({
      lines: [frameLine(10_000), frameLine(11_000), frameLine(12_000), { type: 'ended', watched: true, reason: 'the video ended', framesSent: 3 }],
      chunks: (sent) => [
        {
          text: 'MOMENT: A dog rolls past on a skateboard.',
          consumedFrameIds: sent.frameIds,
          endOfTurn: true,
          isListen: false,
          index: 1,
        },
      ],
    });

    const result = await inspect(runtime);

    expect(result.moments).toEqual([
      { startSeconds: 10, endSeconds: 12, description: 'A dog rolls past on a skateboard.' },
    ]);
    expect(result.exhausted).toBe(true);
  });

  it('sends a slice of sound with every picture, because sound is what makes it look', async () => {
    const { runtime, fake } = runtimeWith({
      lines: [frameLine(0), frameLine(1_000), { type: 'ended', watched: true, reason: 'the video ended', framesSent: 2 }],
      chunks: () => [],
    });

    await inspect(runtime);

    // No audio would mean no units, and no units means the frames are never
    // looked at however many were sent.
    expect(fake.sent.audioUnits).toBe(fake.sent.frameIds.length);
    expect(fake.sent.audioUnits).toBe(2);
  });

  it('puts the question to the model as text, in the shape the reader expects', async () => {
    const { runtime, fake } = runtimeWith({
      lines: [frameLine(0), { type: 'ended', watched: true, reason: 'the video ended', framesSent: 1 }],
      chunks: () => [],
    });

    await inspect(runtime);

    expect(fake.asked).toContain('a dog on a skateboard');
    expect(fake.asked).toContain('MOMENT:');
  });

  it("waits for what the model says about the last thing it saw", async () => {
    // The model speaks about a unit after consuming it, so its comment on the
    // closing seconds arrives after the final frame was sent. Closing the
    // moment the watch ends would throw away exactly that part.
    const fake = fakeSession(() => []);
    let yielded = 0;
    const slow = {
      ...(fake.session as unknown as Record<string, unknown>),
      async *chunks() {
        // Nothing until after the watch has ended.
        await new Promise((resolve) => setTimeout(resolve, 40));
        for (const chunk of [
          { text: '', consumedFrameIds: fake.sent.frameIds, endOfTurn: false, isListen: true, index: 1 },
          { text: 'MOMENT: The dog lands the trick.', consumedFrameIds: fake.sent.frameIds, endOfTurn: true, isListen: false, index: 2 },
        ]) {
          // As the real socket does: once the session is closed there is
          // nothing more to hear, so a runtime that closed too early gets
          // silence rather than the words it did not wait for.
          if (fake.closed) return;
          yielded += 1;
          yield chunk;
        }
      },
    } as unknown as GanderSession;

    const runtime = createGanderScoutRuntime({
      webAccessUrl: 'http://web-access.internal:8080',
      webAccessToken: 'token',
      ganderUrl: 'https://gander.example',
      ganderApiKey: 'key',
      trailingDrainMs: 500,
      openSession: async () => slow,
      fetchImpl: fakeWatch([
        frameLine(58_000),
        frameLine(59_000),
        { type: 'ended', watched: true, reason: 'the video ended', framesSent: 2 },
      ]) as unknown as typeof fetch,
    });

    const result = await inspect(runtime);

    expect(yielded).toBe(2);
    expect(result.moments).toEqual([
      { startSeconds: 58, endSeconds: 59, description: 'The dog lands the trick.' },
    ]);
  });

  it('says a page that hit the time limit was not examined in full', async () => {
    const { runtime } = runtimeWith({
      lines: [frameLine(0), { type: 'ended', watched: true, reason: 'reached the time limit', framesSent: 1 }],
      chunks: () => [],
    });

    const result = await inspect(runtime);

    // "We stopped early" and "there was nothing there" are different answers.
    expect(result.exhausted).toBe(false);
    expect(result.moments).toEqual([]);
  });

  it('fails a page that could not be played rather than reporting it as empty', async () => {
    const { runtime, fake } = runtimeWith({
      lines: [{ type: 'ended', watched: false, reason: 'the video never started playing', framesSent: 0 }],
      chunks: () => [],
    });

    // Returning zero moments here would tell the coordinator we looked and
    // found nothing. We never looked, so it has to be a failure.
    await expect(inspect(runtime)).rejects.toThrow('the video never started playing');
    expect(fake.closed).toBe(true);
  });

  it('lets go of the Thinker even when the watch fails', async () => {
    const slot = new ThinkerSlot();
    const failing = runtimeWith({
      lines: [{ type: 'ended', watched: false, reason: 'the player refused to start', framesSent: 0 }],
      chunks: () => [],
      slot,
    });
    await expect(inspect(failing.runtime)).rejects.toThrow();

    // A scout that died holding the slot would strand the other three.
    const after = runtimeWith({
      lines: [frameLine(5_000), { type: 'ended', watched: true, reason: 'the video ended', framesSent: 1 }],
      chunks: (sent) => [
        { text: 'MOMENT: Something happens.', consumedFrameIds: sent.frameIds, endOfTurn: true, isListen: false, index: 1 },
      ],
      slot,
    });
    const result = await Promise.race([
      inspect(after.runtime),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the slot was never released')), 2_000)),
    ]);
    expect((result as { moments: unknown[] }).moments).toHaveLength(1);
  });

  it('closes the session when it is done, so the next scout is not held up', async () => {
    const { runtime, fake } = runtimeWith({
      lines: [frameLine(0), { type: 'ended', watched: true, reason: 'the video ended', framesSent: 1 }],
      chunks: () => [],
    });

    await inspect(runtime);

    expect(fake.closed).toBe(true);
  });
});

describe('the Thinker slot', () => {
  it('lets one scout in at a time', async () => {
    const slot = new ThinkerSlot();
    const order: string[] = [];
    const hold = (name: string, ms: number) =>
      slot.use(async () => {
        order.push(`${name}:in`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        order.push(`${name}:out`);
      });

    await Promise.all([hold('a', 20), hold('b', 1), hold('c', 1)]);

    // Never two inside at once.
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
  });

  it('hands the slot straight to the next in line', async () => {
    const slot = new ThinkerSlot();
    let released = false;
    const first = slot.use(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      released = true;
    });
    const second = slot.use(async () => {
      expect(released).toBe(true);
    });
    await Promise.all([first, second]);
  });

  it('gives up waiting when the search is cancelled', async () => {
    const slot = new ThinkerSlot();
    const controller = new AbortController();
    const holding = slot.use(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const waiting = slot.use(async () => 'never', controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow('cancelled');
    await holding;
  });
});
