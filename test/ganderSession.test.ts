import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GanderSession } from '../src/services/scout/ganderSession.js';

/** A socket that behaves like `ws` as far as this client is concerned. */
class FakeSocket extends EventEmitter {
  readonly sent: Array<string | Buffer> = [];
  readyState = WebSocket.OPEN;
  closed = false;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  /** Deliver a JSON message the way `ws` does, text rather than binary. */
  deliver(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)), false);
  }
}

const READY = {
  type: 'ready',
  session_id: 'session-1',
  resume_token: 'resume-1',
  input_sample_rate: 16_000,
  chunk_ms: 1_000,
  screen: {
    enabled: true,
    path: '/ws/screen',
    token: 'screen-token',
    max_frame_bytes: 900_000,
    max_pixels: 1_000_000,
    recommended_frame_rate: 1,
    encodings: ['jpeg'],
  },
};

/** Open a session against two fake sockets that say the right things. */
async function openFake() {
  const sockets: FakeSocket[] = [];
  const headersSeen: Array<Record<string, string>> = [];
  const session = await GanderSession.open({
    baseUrl: 'https://gander.example',
    apiKey: 'secret-key',
    connect: (_url, headers) => {
      const socket = new FakeSocket();
      sockets.push(socket);
      headersSeen.push(headers);
      // The handshake answers on the next tick, as a real one would.
      setTimeout(() => socket.deliver(sockets.length === 1 ? READY : { type: 'screen.ready' }), 0);
      return socket as unknown as WebSocket;
    },
  });
  return { session, duplex: sockets[0]!, screen: sockets[1]!, headersSeen };
}

describe('opening a Gander session', () => {
  it('carries the credential on both sockets', async () => {
    const { headersSeen } = await openFake();
    expect(headersSeen).toHaveLength(2);
    for (const headers of headersSeen) expect(headers.authorization).toBe('Bearer secret-key');
  });

  it('reads the screen token out of the handshake', async () => {
    const { session } = await openFake();
    expect(session.ready.screen.token).toBe('screen-token');
    expect(session.ready.chunkMs).toBe(1_000);
  });

  it('survives a transport error after startup instead of taking the worker down', async () => {
    const { session, duplex } = await openFake();

    // Node treats an EventEmitter 'error' with no listener as an exception.
    // The readiness wait installs one and takes it off again when it settles,
    // so without a lifetime listener this would kill the process rather than
    // fail one inspection.
    expect(() => duplex.emit('error', new Error('connection reset'))).not.toThrow();

    // And the session knows it is gone, rather than accepting sends into a
    // socket nobody is reading.
    expect(() => session.sendFrame({ videoMs: 0, capturedAtMs: 0, image: Buffer.from('x') })).toThrow('connection reset');
  });

  it('survives an error on the screen socket too', async () => {
    const { session, screen } = await openFake();
    expect(() => screen.emit('error', new Error('screen socket reset'))).not.toThrow();
    expect(() => session.sendAudio(Buffer.alloc(320), 0)).toThrow('screen socket reset');
  });

  it('says stop on the way out, so the Thinker is let go rather than held for a resume', async () => {
    const { session, duplex } = await openFake();
    session.close();
    const stop = duplex.sent.map(String).find((message) => message.includes('"stop"'));
    expect(stop).toBeTruthy();
    expect(duplex.closed).toBe(true);
  });
});
