import { logger } from '../../lib/logger.js';
import { GanderSession } from '../scout/ganderSession.js';
import { ThinkerSlot } from '../scout/ganderSlot.js';
import { MomentReader, questionFor } from '../scout/momentReader.js';
import type { ScoutCandidate, ScoutInspection, ScoutRuntime } from './scoutSwarm.js';

/**
 * The runtime behind the four scouts: a candidate page, opened in a real
 * browser, played, and watched by Gander.
 *
 * The browser container does the opening and the playing and streams back
 * what is on screen with each picture's position in the video. This end holds
 * the Gander session, feeds it those pictures, and reads what it says. The
 * coordinator (scoutSwarm) does the rest.
 *
 * One model, four scouts, so watching is serialised through the Thinker slot.
 * That does mean a scout holds the slot while its page plays: overlapping one
 * scout's navigation with another's watching would buy real time, but it
 * needs somewhere to put the frames that arrive before the slot is free, and
 * anywhere to put them is somewhere they go stale. Serialised and correct
 * first.
 *
 * The page is watched, not heard. A headless browser will not hand over its
 * audio, so the silence sent here is doing one job — turning the model's
 * clock, which is what makes it consume the pictures at all. Nothing
 * downstream should read a moment from this runtime as evidence about what
 * was said.
 */

export interface PageCandidate extends ScoutCandidate {
  pageUrl: string;
}

export interface GanderScoutRuntimeOptions {
  /** The browser container: Railway's web-access service. */
  webAccessUrl: string;
  webAccessToken: string;
  /** The Gander runtime and the internal credential for it. */
  ganderUrl: string;
  ganderApiKey: string;
  /** Longest one page is watched. */
  maxWatchSeconds?: number;
  /** Longest moment the coordinator will take, in seconds. */
  maxMomentSeconds?: number;
  /**
   * How long to keep listening after the last picture was sent.
   *
   * The model speaks about a unit after it has consumed it, so its comment on
   * the closing seconds of a page arrives after the last frame. Closing the
   * moment the watch ends would throw that away — and it is exactly the part
   * that describes the end of what it just saw.
   */
  trailingDrainMs?: number;
  /** Shared so all four scouts queue on the same model. */
  slot?: ThinkerSlot;
  /** Injected in tests. */
  openSession?: typeof GanderSession.open;
  fetchImpl?: typeof fetch;
}

interface WatchFrame {
  type: 'frame';
  video_ms: number;
  encoding: string;
  image: string;
}

interface WatchEnded {
  type: 'ended';
  watched: boolean;
  reason: string;
  framesSent: number;
  lastPositionMs?: number;
}

type WatchEvent = WatchFrame | WatchEnded;

/** Read an NDJSON body line by line, without waiting for the end of it. */
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

/** One unit of silence, which is what advances the model's clock. */
function silence(sampleRate: number, chunkMs: number): Buffer {
  return Buffer.alloc(Math.max(1, Math.round((sampleRate * chunkMs) / 1000)) * 2);
}

export function createGanderScoutRuntime(options: GanderScoutRuntimeOptions): ScoutRuntime<PageCandidate> {
  const slot = options.slot ?? new ThinkerSlot();
  const open = options.openSession ?? GanderSession.open;
  const doFetch = options.fetchImpl ?? fetch;
  const maxWatchSeconds = options.maxWatchSeconds ?? 90;
  const trailingDrainMs = options.trailingDrainMs ?? 5_000;

  return {
    async inspect({ scoutId, searchId, query, candidate, signal }): Promise<ScoutInspection> {
      const log = logger.child({ search_id: searchId, scout_id: scoutId, candidate_id: candidate.id });

      return slot.use(async () => {
        const session = await open({
          baseUrl: options.ganderUrl,
          apiKey: options.ganderApiKey,
          signal,
        });

        const reader = new MomentReader({ query, maxMomentSeconds: options.maxMomentSeconds });
        const quiet = silence(session.ready.inputSampleRate, session.ready.chunkMs);
        let watchedSeconds = 0;
        let exhausted = false;
        let reason = 'the watch ended without saying why';

        // Read what the model says for as long as the page is being fed to
        // it. Started before the first frame so nothing it says is missed.
        // A holder rather than a bare variable: assigned only from inside the
        // drain below, which the reading loop above cannot see, so a plain
        // `let` narrows to null and the call is rejected.
        const turnEnd: { fire: (() => void) | null } = { fire: null };
        const reading = (async () => {
          for await (const chunk of session.chunks(signal)) {
            reader.take(chunk);
            if (chunk.endOfTurn) turnEnd.fire?.();
          }
        })().catch((error: unknown) => {
          // The socket closing at the end of a watch is how this ends, not a
          // failure of the watch itself.
          log.debug('gander stream ended', { err: error instanceof Error ? error.message : String(error) });
        });

        try {
          await session.ask(questionFor(query), signal);

          const response = await doFetch(new URL('/watch', options.webAccessUrl).toString(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-clipit-web-access-token': options.webAccessToken,
            },
            body: JSON.stringify({ pageUrl: candidate.pageUrl, maxSeconds: maxWatchSeconds, fps: session.ready.screen.recommendedFrameRate }),
            signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`the browser refused to watch this page (${response.status})`);
          }

          for await (const event of ndjson(response.body)) {
            if (signal.aborted) break;
            if (event.type === 'frame') {
              session.sendFrame({
                videoMs: event.video_ms,
                capturedAtMs: Date.now(),
                image: Buffer.from(event.image, 'base64'),
                encoding: event.encoding,
              });
              // The picture is only looked at once a unit consumes it, and a
              // unit is a slice of sound. No sound, no looking.
              session.sendAudio(quiet, Date.now());
              watchedSeconds = Math.max(watchedSeconds, event.video_ms / 1000);
              continue;
            }
            reason = event.reason;
            // A page that played to its end was examined in full; one that
            // hit the time limit was not, and the difference is the
            // difference between "nothing there" and "we did not look".
            exhausted = event.watched && event.reason === 'the video ended';
            if (!event.watched) throw new Error(event.reason);
          }
          // Let the model finish what it was saying about the last thing it
          // saw, then let go. Bounded, because a model that says nothing more
          // must not hold the Thinker while the other scouts wait.
          await new Promise<void>((resolve) => {
            let timer: NodeJS.Timeout;
            const finish = () => {
              clearTimeout(timer);
              turnEnd.fire = null;
              resolve();
            };
            timer = setTimeout(finish, trailingDrainMs);
            turnEnd.fire = finish;
          });
        } finally {
          session.close();
          await reading;
        }

        log.debug('scout finished a candidate', {
          moments: reader.moments.length,
          frames_consumed: reader.consumed.size,
          watched_seconds: Math.round(watchedSeconds),
          reason,
        });

        return {
          moments: reader.moments,
          mediaSecondsObserved: watchedSeconds,
          exhausted,
          metrics: {
            frames_consumed: reader.consumed.size,
            reason,
            heard: false,
          },
        };
      }, signal);
    },
  };
}
