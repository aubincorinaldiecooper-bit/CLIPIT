import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { logger } from '../../lib/logger.js';

/**
 * One session with the Gander runtime, for one scout watching one page.
 *
 * Gander is a realtime duplex runtime, not a request/response model. It runs
 * on a clock: every `chunk_ms` it consumes one unit — a slice of audio, plus
 * whatever video frames were captured during that slice — and may say
 * something about what it just took in. Audio is what turns the clock. A
 * session that sends no audio consumes no units and therefore never looks at
 * the frames it was sent, however many arrive.
 *
 * Two sockets, because the runtime has two:
 *
 *   /ws/duplex   the session itself — the handshake, the question, the audio,
 *                and everything the model says back
 *   /ws/screen   the pictures, one JSON header then one encoded image, opened
 *                with the token the handshake hands out
 *
 * Why this matters for timestamps: the client names every frame, and every
 * chunk of text the model produces reports `metrics.consumed_frame_ids` — the
 * exact frames that went into the unit it is talking about. So if a frame's
 * name carries the position in the video it was taken at, what the model says
 * can be placed in the video exactly, rather than guessed at from how long
 * the reply took to arrive.
 */

/** A frame's name carries where in the video it came from. */
const FRAME_ID_PREFIX = 'v';

/** How long to wait for the runtime to say it is ready before giving up. */
const READY_TIMEOUT_MS = 120_000;

/** How long to wait for the runtime to accept the question. */
const TURN_TIMEOUT_MS = 30_000;

export interface GanderChunk {
  /** What the model said. Empty while it is only listening. */
  text: string;
  /** The frames that went into the unit this chunk is about. */
  consumedFrameIds: string[];
  endOfTurn: boolean;
  /** True while the model is taking input rather than answering. */
  isListen: boolean;
  index: number;
}

export interface GanderReady {
  sessionId: string;
  resumeToken: string | null;
  /** PCM16 sample rate the session expects on the duplex socket. */
  inputSampleRate: number;
  /** Milliseconds of audio in one unit. Frames land in the unit they fall in. */
  chunkMs: number;
  screen: {
    enabled: boolean;
    token: string | null;
    maxFrameBytes: number;
    maxPixels: number;
    /** Frames per second the runtime says it can actually use. */
    recommendedFrameRate: number;
    encodings: string[];
  };
}

export interface GanderSessionOptions {
  /** The runtime's base address, e.g. https://…modal.run */
  baseUrl: string;
  /** The internal credential; sent as `Authorization: Bearer …` on both sockets. */
  apiKey: string;
  signal?: AbortSignal;
  /** Injected in tests. Anything with the `ws` constructor's shape. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

/** The name a frame gets, given where in the video it was captured. */
export function frameIdForPosition(videoMs: number, sequence: number): string {
  const position = Math.max(0, Math.round(videoMs));
  // Only [A-Za-z0-9_.:-] is allowed, and 256 characters at most.
  return `${FRAME_ID_PREFIX}.${String(position).padStart(9, '0')}.${sequence}`;
}

/** Where in the video a frame came from, read back off its name. */
export function positionFromFrameId(frameId: string): number | null {
  const parts = frameId.split('.');
  if (parts.length !== 3 || parts[0] !== FRAME_ID_PREFIX) return null;
  const position = Number(parts[1]);
  return Number.isFinite(position) && position >= 0 ? position : null;
}

function websocketUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : url.protocol === 'https:' ? 'wss:' : url.protocol;
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function openSocket(options: GanderSessionOptions, path: string, query?: Record<string, string>): WebSocket {
  const url = websocketUrl(options.baseUrl, path, query);
  const headers = { authorization: `Bearer ${options.apiKey}` };
  if (options.connect) return options.connect(url, headers);
  return new WebSocket(url, { headers });
}

function once<T>(
  socket: WebSocket,
  match: (payload: Record<string, unknown>) => T | null,
  timeoutMs: number,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (error: Error | null, value?: T) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(() => settle(new Error(`timed out waiting for ${what}`)), timeoutMs);
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      // A fatal error ends the wait; a recoverable one is the runtime telling
      // us about something it carried on from, so it is not ours to fail on.
      if (payload.type === 'error' && payload.fatal !== false) {
        settle(new Error(String(payload.message ?? `gander refused during ${what}`)));
        return;
      }
      const matched = match(payload);
      if (matched !== null) settle(null, matched);
    };
    const onClose = () => settle(new Error(`socket closed while waiting for ${what}`));
    const onError = (error: Error) => settle(error);
    const onAbort = () => settle(new Error(`cancelled while waiting for ${what}`));
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readReady(payload: Record<string, unknown>): GanderReady | null {
  if (payload.type !== 'ready') return null;
  const screen = (payload.screen ?? {}) as Record<string, unknown>;
  return {
    sessionId: String(payload.session_id ?? ''),
    resumeToken: typeof payload.resume_token === 'string' ? payload.resume_token : null,
    inputSampleRate: Number(payload.input_sample_rate ?? 16_000),
    chunkMs: Number(payload.chunk_ms ?? 1_000),
    screen: {
      enabled: Boolean(screen.enabled),
      token: typeof screen.token === 'string' ? screen.token : null,
      maxFrameBytes: Number(screen.max_frame_bytes ?? 0),
      maxPixels: Number(screen.max_pixels ?? 0),
      recommendedFrameRate: Number(screen.recommended_frame_rate ?? 1),
      encodings: Array.isArray(screen.encodings) ? screen.encodings.map(String) : ['jpeg'],
    },
  };
}

export class GanderSession {
  private audioSequence = 0;
  private audioSamplesSent = 0;
  private frameSequence = 0;
  private closed = false;

  private constructor(
    readonly ready: GanderReady,
    private readonly duplex: WebSocket,
    private readonly screen: WebSocket | null,
  ) {}

  /**
   * Open a session and wait until the runtime is perceptually ready.
   *
   * The Brain behind it may still be warming when this resolves; that is the
   * runtime's own design and not something to wait out here.
   */
  static async open(options: GanderSessionOptions): Promise<GanderSession> {
    const duplex = openSocket(options, 'ws/duplex');
    let ready: GanderReady;
    try {
      ready = await once(duplex, readReady, READY_TIMEOUT_MS, 'the session to be ready', options.signal);
    } catch (error) {
      duplex.close();
      throw error;
    }

    if (!ready.screen.enabled || !ready.screen.token) {
      duplex.close();
      throw new Error('gander session has no screen input; a scout cannot watch without it');
    }

    const screen = openSocket(options, 'ws/screen', {
      session_id: ready.sessionId,
      token: ready.screen.token,
    });
    try {
      await once(
        screen,
        (payload) => (payload.type === 'screen.ready' ? true : null),
        READY_TIMEOUT_MS,
        'the screen socket to be ready',
        options.signal,
      );
    } catch (error) {
      screen.close();
      duplex.close();
      throw error;
    }

    logger.debug('gander session open', {
      session_id: ready.sessionId,
      chunk_ms: ready.chunkMs,
      frame_rate: ready.screen.recommendedFrameRate,
    });
    return new GanderSession(ready, duplex, screen);
  }

  /** Put the question to the model, as text. It has no other way in. */
  async ask(text: string, signal?: AbortSignal): Promise<void> {
    const turnId = randomUUID();
    const accepted = once(
      this.duplex,
      (payload) => (payload.type === 'turn.final.accepted' ? true : null),
      TURN_TIMEOUT_MS,
      'the question to be accepted',
      signal,
    );
    this.duplex.send(JSON.stringify({ type: 'turn.final', turn_id: turnId, text }));
    await accepted;
  }

  /**
   * One picture, named for where in the video it came from.
   *
   * The name is the whole point: it comes back on the chunk that consumed it,
   * which is what lets a sentence be placed in the video.
   */
  sendFrame(input: { videoMs: number; capturedAtMs: number; image: Buffer; encoding?: string }): string {
    const frameId = frameIdForPosition(input.videoMs, ++this.frameSequence);
    if (!this.screen) throw new Error('this session has no screen socket');
    this.screen.send(
      JSON.stringify({
        type: 'screen.frame',
        frame_id: frameId,
        captured_at_ms: input.capturedAtMs,
        encoding: input.encoding ?? 'jpeg',
        video_source: 'screen',
      }),
    );
    this.screen.send(input.image);
    return frameId;
  }

  /**
   * One slice of PCM16, which is what advances the model's clock.
   *
   * Silence is still a slice. A page whose sound cannot be captured is still
   * watched — but it is watched and not heard, and a question about what was
   * said cannot be answered from frames.
   */
  sendAudio(pcm16: Buffer, capturedAtMs: number): void {
    const sampleCount = Math.floor(pcm16.byteLength / 2);
    if (sampleCount <= 0) return;
    this.duplex.send(
      JSON.stringify({
        type: 'audio.frame',
        sequence: ++this.audioSequence,
        start_sample: this.audioSamplesSent,
        sample_count: sampleCount,
        captured_at_ms: capturedAtMs,
      }),
    );
    this.duplex.send(pcm16);
    this.audioSamplesSent += sampleCount;
  }

  /** Everything the model says, as it says it. */
  async *chunks(signal?: AbortSignal): AsyncGenerator<GanderChunk> {
    const queue: GanderChunk[] = [];
    let waiting: (() => void) | null = null;
    let ended: Error | null = null;

    const wake = () => {
      const resume = waiting;
      waiting = null;
      resume?.();
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.type === 'error' && payload.fatal !== false) {
        ended = new Error(String(payload.message ?? 'gander failed'));
        wake();
        return;
      }
      if (payload.type !== 'chunk') return;
      const metrics = (payload.metrics ?? {}) as Record<string, unknown>;
      const consumed = metrics.consumed_frame_ids;
      queue.push({
        text: String(payload.text ?? ''),
        consumedFrameIds: Array.isArray(consumed) ? consumed.map(String) : [],
        endOfTurn: Boolean(payload.end_of_turn),
        isListen: Boolean(payload.is_listen),
        index: Number(payload.index ?? 0),
      });
      wake();
    };
    const onClose = () => {
      ended = ended ?? new Error('gander socket closed');
      wake();
    };

    this.duplex.on('message', onMessage);
    this.duplex.on('close', onClose);
    signal?.addEventListener('abort', wake, { once: true });
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (signal?.aborted) return;
        if (ended) throw ended;
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
      }
    } finally {
      this.duplex.off('message', onMessage);
      this.duplex.off('close', onClose);
      signal?.removeEventListener('abort', wake);
    }
  }

  /**
   * End the session and let go of the Thinker.
   *
   * Sending `stop` rather than just dropping the socket matters: a socket that
   * drops without one is held open for a reconnect, and the next scout would
   * queue behind a session nobody is coming back to.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.duplex.readyState === WebSocket.OPEN) this.duplex.send(JSON.stringify({ type: 'stop' }));
    } catch {
      // The socket is going away regardless.
    }
    this.screen?.close();
    this.duplex.close();
  }
}
