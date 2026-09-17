import net from 'node:net';
import { chromium } from 'playwright';

/**
 * Watch a page rather than resolving it to a media file.
 *
 * The browser opens the real page, resolves one exact player, gets that player
 * running, and samples pictures against the player's media clock. Downstream
 * video models receive the player's own currentTime as source truth; model
 * prose is never trusted for time.
 *
 * This path is intentionally visual-only. VideoChat3 does not consume the page
 * audio in the internet-search path.
 */

const DEFAULT_FPS = 1;
const DEFAULT_MAX_SECONDS = 90;
const PLAYBACK_TIMEOUT_MS = 20_000;
const SAMPLE_WAIT_TIMEOUT_MS = 1_000;
const STALL_RECOVER_MS = 2_500;
const STALL_GIVE_UP_MS = 8_000;
const PLAYER_ATTRIBUTE = 'data-clipit-player';

/**
 * Live frames currently cross a Modal Queue as base64 JSON. Queue items are
 * capped at 1 MiB, and base64 adds roughly one third, so keep the raw JPEG
 * comfortably below that boundary rather than discovering the limit after
 * capture. 680kB -> ~907kB before the small JSON envelope.
 */
const MAX_FRAME_BYTES = 680_000;

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not reserve a local CDP port');
  return port;
}

function stagehandSettings() {
  if (!truthy(process.env.STAGEHAND_PLAYER_RESOLVER_ENABLED)) return null;
  const apiKey = (process.env.STAGEHAND_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    modelName: (process.env.STAGEHAND_MODEL || 'openai/gpt-5').trim(),
    baseURL: (process.env.STAGEHAND_BASE_URL || process.env.OPENROUTER_API_BASE_URL || 'https://openrouter.ai/api/v1').trim(),
  };
}

async function attachStagehand(cdpUrl, settings) {
  if (!settings) return null;
  try {
    const { Stagehand } = await import('@browserbasehq/stagehand');
    const stagehand = new Stagehand({
      env: 'LOCAL',
      model: {
        modelName: settings.modelName,
        apiKey: settings.apiKey,
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      },
      localBrowserLaunchOptions: { cdpUrl },
      selfHeal: true,
      verbose: 0,
    });
    await stagehand.init();
    return stagehand;
  } catch (error) {
    console.warn('stagehand player resolver unavailable', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function collectVideoCandidates(page) {
  const candidates = [];
  for (const frame of page.frames()) {
    const videos = frame.locator('video');
    let count = 0;
    try { count = await videos.count(); } catch { continue; }
    for (let index = 0; index < count; index += 1) {
      const locator = videos.nth(index);
      try {
        const box = await locator.boundingBox();
        if (!box || box.width < 32 || box.height < 32) continue;
        const info = await locator.evaluate((video) => {
          const style = getComputedStyle(video);
          return {
            paused: video.paused,
            ended: video.ended,
            readyState: video.readyState,
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            videoWidth: video.videoWidth || 0,
            videoHeight: video.videoHeight || 0,
            currentSrc: video.currentSrc || '',
            visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0,
          };
        });
        if (!info.visible) continue;
        const area = box.width * box.height;
        // Area leads because the main player is usually the dominant surface.
        // Playback/readiness break ties without letting a tiny autoplay ad win.
        const score = Math.log2(area + 1)
          + (!info.paused && !info.ended ? 4 : 0)
          + (info.readyState >= 2 ? 2 : 0)
          + (info.videoWidth > 0 && info.videoHeight > 0 ? 1 : 0)
          + (info.duration === null || info.duration >= 3 ? 1 : 0);
        candidates.push({ frame, locator, box, info, area, score });
      } catch {
        // A detached or cross-navigation node is simply not a candidate.
      }
    }
  }
  return candidates.sort((one, other) => other.score - one.score || other.area - one.area);
}

function ambiguous(candidates) {
  if (candidates.length < 2) return false;
  const [first, second] = candidates;
  // If two visible players are of similar size, semantic page understanding is
  // more reliable than guessing which one is content and which one is an ad or
  // preview. A clearly dominant surface stays deterministic and free.
  return second.area >= first.area * 0.6;
}

async function pin(locator) {
  const token = `clipit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  await locator.evaluate((video, value) => video.setAttribute('data-clipit-player', value), token);
  const frame = locator.frameLocator ? null : null; // keep this module Playwright-version agnostic
  void frame;
  return { locator, token };
}

async function stagehandIntervention(stagehand, page) {
  if (!stagehand) return false;
  try {
    await stagehand.act(
      'Start or focus the primary main-content video on this page. Do not choose an advertisement, background loop, thumbnail preview, or recommended-video preview. Do not navigate away from the page.',
      { page },
    );
    await page.waitForTimeout(500);
    return true;
  } catch (error) {
    console.warn('stagehand could not resolve the primary player', error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function resolvePlayer(page, getStagehand) {
  let candidates = await collectVideoCandidates(page);
  if ((candidates.length === 0 || ambiguous(candidates)) && getStagehand) {
    const stagehand = await getStagehand();
    if (await stagehandIntervention(stagehand, page)) candidates = await collectVideoCandidates(page);
  }
  if (candidates.length === 0) return null;

  // Prefer a player that is already advancing after Stagehand interacted with
  // the page, otherwise fall back to the strongest deterministic candidate.
  const playing = candidates.find((candidate) => !candidate.info.paused && !candidate.info.ended);
  return pin((playing ?? candidates[0]).locator);
}

async function startPlayback(player) {
  try {
    return await player.locator.evaluate(async (video) => {
      video.muted = true;
      video.playsInline = true;
      try { await video.play(); } catch (error) {
        return { playing: false, reason: `the player refused to start: ${String(error)}` };
      }
      return {
        playing: !video.paused,
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      };
    });
  } catch (error) {
    return { playing: false, reason: `the player went away: ${String(error)}` };
  }
}

async function playerState(player) {
  try {
    return await player.locator.evaluate((video) => ({
      ms: Math.round(video.currentTime * 1000),
      ended: video.ended,
      paused: video.paused,
    }));
  } catch {
    return null;
  }
}

/**
 * Wait on actual video presentation rather than sleeping for a wall-clock
 * interval. requestVideoFrameCallback is the browser's media-frame clock; the
 * currentTime fallback is only for players/browsers that do not expose it.
 */
async function waitForMediaSample(player, afterMs, targetGapMs, timeoutMs) {
  return player.locator.evaluate((video, args) => new Promise((resolve) => {
    let settled = false;
    let callbackId = null;
    let timer = null;
    const finish = (mediaMs, timedOut = false) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (callbackId !== null && typeof video.cancelVideoFrameCallback === 'function') {
        try { video.cancelVideoFrameCallback(callbackId); } catch { /* no-op */ }
      }
      resolve({
        ms: Math.round(mediaMs),
        ended: video.ended,
        paused: video.paused,
        timedOut,
      });
    };
    const threshold = args.afterMs < 0 ? 0 : args.afterMs + args.targetGapMs * 0.9;
    timer = setTimeout(() => finish(video.currentTime * 1000, true), args.timeoutMs);

    if (video.ended) return finish(video.currentTime * 1000);
    if (typeof video.requestVideoFrameCallback === 'function') {
      const next = (_now, metadata) => {
        const mediaMs = metadata.mediaTime * 1000;
        if (mediaMs >= threshold || video.ended) return finish(mediaMs);
        callbackId = video.requestVideoFrameCallback(next);
      };
      callbackId = video.requestVideoFrameCallback(next);
      return;
    }

    const poll = () => {
      const mediaMs = video.currentTime * 1000;
      if (mediaMs >= threshold || video.ended) return finish(mediaMs);
      setTimeout(poll, 16);
    };
    poll();
  }), { afterMs, targetGapMs, timeoutMs });
}

async function captureFrame(player, realtimeV2) {
  const qualities = realtimeV2 ? [82, 70, 55] : [70, 55];
  let last = null;
  for (const quality of qualities) {
    last = await player.locator.screenshot({ type: 'jpeg', quality, timeout: 5_000 });
    if (last.byteLength <= MAX_FRAME_BYTES) return last;
  }
  return last && last.byteLength <= MAX_FRAME_BYTES ? last : null;
}

export async function watchPage(input, onFrame) {
  const {
    pageUrl,
    maxSeconds = DEFAULT_MAX_SECONDS,
    fps = DEFAULT_FPS,
    realtimeV2 = false,
    signal,
  } = input;
  const captureFps = Math.min(30, Math.max(0.2, Number(fps) || DEFAULT_FPS));
  const targetGapMs = 1_000 / captureFps;
  const stagehandConfig = realtimeV2 ? stagehandSettings() : null;
  const cdpPort = stagehandConfig ? await reservePort() : null;
  const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
  if (cdpPort) {
    launchArgs.push(`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1');
  }

  const browser = await chromium.launch({ headless: true, args: launchArgs });
  let stagehand = null;
  let framesSent = 0;
  let framesSkipped = 0;
  let stallsRecovered = 0;
  let lastPositionMs = 0;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: PLAYBACK_TIMEOUT_MS });

    const getStagehand = stagehandConfig && cdpPort
      ? async () => {
          if (stagehand) return stagehand;
          stagehand = await attachStagehand(`http://127.0.0.1:${cdpPort}`, stagehandConfig);
          return stagehand;
        }
      : null;

    let player = await resolvePlayer(page, getStagehand);
    if (!player) {
      await page.waitForTimeout(1_000);
      player = await resolvePlayer(page, getStagehand);
    }
    if (!player) {
      return { watched: false, reason: 'no video element on the page', framesSent: 0, framesSkipped, stallsRecovered, lastPositionMs: 0 };
    }

    let playback = await startPlayback(player);
    if (!playback.playing && getStagehand) {
      await stagehandIntervention(await getStagehand(), page);
      player = (await resolvePlayer(page, getStagehand)) ?? player;
      playback = await startPlayback(player);
    }
    if (!playback.playing) {
      await page.waitForTimeout(1_000);
      playback = await startPlayback(player);
    }
    if (!playback.playing) {
      return { watched: false, reason: playback.reason ?? 'the video never started playing', framesSent: 0, framesSkipped, stallsRecovered, lastPositionMs: 0 };
    }

    const initial = await playerState(player);
    lastPositionMs = initial?.ms ?? 0;
    let lastCapturedMs = -targetGapMs;
    let lastProgressAt = Date.now();
    const watchStarted = Date.now();
    const deadline = watchStarted + Math.max(1, maxSeconds) * 1_000;

    while (Date.now() < deadline) {
      if (signal?.aborted) return { watched: true, reason: 'cancelled', framesSent, framesSkipped, stallsRecovered, lastPositionMs };

      let where;
      try {
        where = await waitForMediaSample(player, lastCapturedMs, targetGapMs, SAMPLE_WAIT_TIMEOUT_MS);
      } catch {
        // Modern sites can replace the <video> node during an ad/content or
        // quality transition. Re-resolve once instead of treating that DOM
        // replacement as the end of the actual video.
        const replacement = await resolvePlayer(page, getStagehand);
        if (!replacement) return { watched: true, reason: 'the player went away', framesSent, framesSkipped, stallsRecovered, lastPositionMs };
        player = replacement;
        await startPlayback(player);
        framesSkipped += 1;
        continue;
      }

      if (where.ended) return { watched: true, reason: 'the video ended', framesSent, framesSkipped, stallsRecovered, lastPositionMs: Math.max(lastPositionMs, where.ms) };

      if (where.ms > lastPositionMs + 5) {
        lastProgressAt = Date.now();
        lastPositionMs = where.ms;
      } else if (Date.now() - lastProgressAt >= STALL_RECOVER_MS) {
        const resumed = await startPlayback(player);
        stallsRecovered += 1;
        if (!resumed.playing && getStagehand) await stagehandIntervention(await getStagehand(), page);
        if (Date.now() - lastProgressAt >= STALL_GIVE_UP_MS) {
          return { watched: true, reason: 'the video stalled', framesSent, framesSkipped, stallsRecovered, lastPositionMs };
        }
      }

      // A timed-out callback or a very slow screenshot can leave us on the same
      // presented frame. Do not spend model budget on duplicate evidence.
      if (where.ms < lastCapturedMs + targetGapMs * 0.5) {
        framesSkipped += 1;
        continue;
      }

      let image;
      try {
        image = await captureFrame(player, realtimeV2);
      } catch {
        const replacement = await resolvePlayer(page, getStagehand);
        if (!replacement) return { watched: true, reason: 'the picture could not be taken because the player disappeared', framesSent, framesSkipped, stallsRecovered, lastPositionMs };
        player = replacement;
        await startPlayback(player);
        framesSkipped += 1;
        continue;
      }
      if (!image) {
        framesSkipped += 1;
        continue;
      }

      // Read the player clock after the screenshot. That is the closest honest
      // timestamp to the pixels Playwright just captured.
      const capturedAt = await playerState(player);
      if (!capturedAt) {
        framesSkipped += 1;
        continue;
      }
      if (capturedAt.ended) {
        return { watched: true, reason: 'the video ended', framesSent, framesSkipped, stallsRecovered, lastPositionMs: Math.max(lastPositionMs, capturedAt.ms) };
      }
      if (capturedAt.ms < lastCapturedMs + targetGapMs * 0.5) {
        framesSkipped += 1;
        continue;
      }

      await onFrame({ videoMs: capturedAt.ms, image, encoding: 'jpeg' });
      framesSent += 1;
      lastCapturedMs = capturedAt.ms;
      lastPositionMs = Math.max(lastPositionMs, capturedAt.ms);
    }

    return { watched: true, reason: 'reached the time limit', framesSent, framesSkipped, stallsRecovered, lastPositionMs };
  } finally {
    // Stagehand is attached to the same local Chromium. Close it first so its
    // CDP session is released before Playwright owns the final browser close.
    if (stagehand) await stagehand.close().catch(() => undefined);
    await browser.close();
  }
}
