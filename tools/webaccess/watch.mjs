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
        const score = Math.log2(area + 1)
          + (!info.paused && !info.ended ? 4 : 0)
          + (info.readyState >= 2 ? 2 : 0)
          + (info.videoWidth > 0 && info.videoHeight > 0 ? 1 : 0)
          + (info.duration === null || info.duration >= 3 ? 1 : 0);
        candidates.push({ locator, info, area, score });
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
  return second.area >= first.area * 0.6;
}

async function pin(locator) {
  // Retaining this exact Locator is the pin. We do not rediscover the largest
  // player on every frame; resolution only runs again if this node disappears.
  return { locator };
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
      duration: Number.isFinite(video.duration) ? video.duration : null,
    }));
  } catch {
    return null;
  }
}

async function seekPlayer(player, seconds) {
  return player.locator.evaluate((video, requested) => new Promise((resolve) => {
    let settled = false;
    const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : null;
    const target = duration === null
      ? Math.max(0, requested)
      : Math.min(Math.max(0, requested), Math.max(0, duration - 0.01));
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({
        ms: Math.round(video.currentTime * 1000),
        duration,
        ended: video.ended,
      });
    };
    const timer = setTimeout(finish, 1_500);
    video.addEventListener('seeked', () => { clearTimeout(timer); finish(); }, { once: true });
    try { video.currentTime = target; } catch { clearTimeout(timer); finish(); }
  }), seconds);
}

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
      resolve({ ms: Math.round(mediaMs), ended: video.ended, paused: video.paused, timedOut });
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
    startSeconds = 0,
    endSeconds,
    scanMode = 'continuous',
    burstSeconds = 1,
    strideSeconds = 5,
    signal,
  } = input;
  const captureFps = Math.min(30, Math.max(0.2, Number(fps) || DEFAULT_FPS));
  const targetGapMs = 1_000 / captureFps;
  const requestedStartMs = Math.max(0, Number(startSeconds) || 0) * 1000;
  const requestedEndMs = Math.max(
    requestedStartMs + 1,
    Number.isFinite(Number(endSeconds)) ? Number(endSeconds) * 1000 : requestedStartMs + Math.max(1, maxSeconds) * 1000,
  );
  const coarse = realtimeV2 && scanMode === 'coarse';
  const burstMs = Math.max(250, Number(burstSeconds) * 1000 || 1_000);
  const strideMs = Math.max(burstMs, Number(strideSeconds) * 1000 || 5_000);
  const stagehandConfig = realtimeV2 ? stagehandSettings() : null;
  const cdpPort = stagehandConfig ? await reservePort() : null;
  const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
  if (cdpPort) launchArgs.push(`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1');

  const browser = await chromium.launch({ headless: true, args: launchArgs });
  let stagehand = null;
  let framesSent = 0;
  let framesSkipped = 0;
  let stallsRecovered = 0;
  let seeks = 0;
  let lastPositionMs = requestedStartMs;

  const finish = (reason, rangeComplete = false, watched = true) => ({
    watched,
    reason,
    framesSent,
    framesSkipped,
    stallsRecovered,
    seeks,
    lastPositionMs,
    rangeComplete,
    mediaSecondsObserved: framesSent / captureFps,
  });

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
    if (!player) return finish('no video element on the page', false, false);

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
    if (!playback.playing) return finish(playback.reason ?? 'the video never started playing', false, false);

    const durationMs = playback.duration === null ? null : playback.duration * 1000;
    const rangeEndMs = durationMs === null ? requestedEndMs : Math.min(requestedEndMs, durationMs);
    if (durationMs !== null && requestedStartMs >= durationMs - 10) {
      lastPositionMs = durationMs;
      return finish('assigned range starts after the video end', true);
    }

    if (requestedStartMs > 0) {
      const sought = await seekPlayer(player, requestedStartMs / 1000);
      seeks += 1;
      lastPositionMs = sought.ms;
      await startPlayback(player);
    } else {
      const initial = await playerState(player);
      lastPositionMs = initial?.ms ?? 0;
    }

    let burstStartMs = requestedStartMs;
    let burstEndMs = Math.min(rangeEndMs, burstStartMs + burstMs);
    let lastCapturedMs = lastPositionMs - targetGapMs;
    let lastProgressAt = Date.now();
    const deadline = Date.now() + Math.max(30, Math.max(1, maxSeconds) + 30) * 1000;

    while (Date.now() < deadline) {
      if (signal?.aborted) return finish('cancelled');

      let where;
      try {
        where = await waitForMediaSample(player, lastCapturedMs, targetGapMs, SAMPLE_WAIT_TIMEOUT_MS);
      } catch {
        const replacement = await resolvePlayer(page, getStagehand);
        if (!replacement) return finish('the player went away');
        player = replacement;
        await startPlayback(player);
        const sought = await seekPlayer(player, lastPositionMs / 1000);
        seeks += 1;
        lastPositionMs = sought.ms;
        lastCapturedMs = sought.ms - targetGapMs;
        framesSkipped += 1;
        continue;
      }

      if (where.ended) {
        lastPositionMs = Math.max(lastPositionMs, where.ms);
        return finish('the video ended', true);
      }
      if (where.ms >= rangeEndMs) {
        lastPositionMs = Math.max(lastPositionMs, rangeEndMs);
        return finish('completed assigned range', true);
      }

      if (coarse && where.ms >= burstEndMs) {
        const nextBurstStart = burstStartMs + strideMs;
        if (nextBurstStart >= rangeEndMs) {
          lastPositionMs = Math.max(lastPositionMs, rangeEndMs);
          return finish('completed assigned coarse range', true);
        }
        const sought = await seekPlayer(player, nextBurstStart / 1000);
        seeks += 1;
        burstStartMs = nextBurstStart;
        burstEndMs = Math.min(rangeEndMs, burstStartMs + burstMs);
        lastPositionMs = sought.ms;
        lastCapturedMs = sought.ms - targetGapMs;
        lastProgressAt = Date.now();
        await startPlayback(player);
        continue;
      }

      if (where.ms > lastPositionMs + 5) {
        lastProgressAt = Date.now();
        lastPositionMs = where.ms;
      } else if (Date.now() - lastProgressAt >= STALL_RECOVER_MS) {
        const resumed = await startPlayback(player);
        stallsRecovered += 1;
        if (!resumed.playing && getStagehand) await stagehandIntervention(await getStagehand(), page);
        if (Date.now() - lastProgressAt >= STALL_GIVE_UP_MS) return finish('the video stalled');
      }

      if (where.ms < lastCapturedMs + targetGapMs * 0.5) {
        framesSkipped += 1;
        continue;
      }

      let image;
      try {
        image = await captureFrame(player, realtimeV2);
      } catch {
        const replacement = await resolvePlayer(page, getStagehand);
        if (!replacement) return finish('the picture could not be taken because the player disappeared');
        player = replacement;
        await startPlayback(player);
        const sought = await seekPlayer(player, lastPositionMs / 1000);
        seeks += 1;
        lastPositionMs = sought.ms;
        lastCapturedMs = sought.ms - targetGapMs;
        framesSkipped += 1;
        continue;
      }
      if (!image) {
        framesSkipped += 1;
        continue;
      }

      const capturedAt = await playerState(player);
      if (!capturedAt) {
        framesSkipped += 1;
        continue;
      }
      if (capturedAt.ended) {
        lastPositionMs = Math.max(lastPositionMs, capturedAt.ms);
        return finish('the video ended', true);
      }
      if (capturedAt.ms >= rangeEndMs || (coarse && capturedAt.ms >= burstEndMs)) {
        lastPositionMs = Math.max(lastPositionMs, Math.min(capturedAt.ms, rangeEndMs));
        continue;
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

    return finish('reached the watch wall-time limit');
  } finally {
    if (stagehand) await stagehand.close().catch(() => undefined);
    await browser.close();
  }
}
