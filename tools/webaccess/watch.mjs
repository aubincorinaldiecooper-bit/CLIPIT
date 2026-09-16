import { chromium } from 'playwright';

/**
 * Watch a page rather than resolving it to a media file.
 *
 * The browser opens the real page, gets its main video playing, and streams
 * pictures with the player's own currentTime. Downstream video models receive
 * those timestamps as source truth; model prose is never trusted for time.
 *
 * This path is visual-only. The headless browser does not expose page audio.
 */

const DEFAULT_FPS = 1;
const DEFAULT_MAX_SECONDS = 90;
const PLAYBACK_TIMEOUT_MS = 20_000;

/**
 * Live frames currently cross a Modal Queue as base64 JSON. Queue items are
 * capped at 1 MiB, and base64 adds roughly one third, so keep the raw JPEG
 * comfortably below that boundary rather than discovering the limit after
 * capture. 680kB -> ~907kB before the small JSON envelope.
 */
const MAX_FRAME_BYTES = 680_000;

async function startPlayback(page) {
  return page.evaluate(async () => {
    const videos = Array.from(document.querySelectorAll('video'));
    const video = videos
      .map((node) => ({ node, area: node.clientWidth * node.clientHeight }))
      .sort((a, b) => b.area - a.area)[0]?.node;
    if (!video) return { playing: false, reason: 'no video element on the page' };

    video.muted = true;
    video.playsInline = true;
    try {
      await video.play();
    } catch (error) {
      return { playing: false, reason: `the player refused to start: ${String(error)}` };
    }
    return {
      playing: !video.paused,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
    };
  });
}

async function positionMs(page) {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    const video = videos
      .map((node) => ({ node, area: node.clientWidth * node.clientHeight }))
      .sort((a, b) => b.area - a.area)[0]?.node;
    if (!video) return null;
    return { ms: Math.round(video.currentTime * 1000), ended: video.ended, paused: video.paused };
  });
}

export async function watchPage(input, onFrame) {
  const { pageUrl, maxSeconds = DEFAULT_MAX_SECONDS, fps = DEFAULT_FPS, signal } = input;
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const started = Date.now();
  let framesSent = 0;
  let lastPositionMs = 0;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: PLAYBACK_TIMEOUT_MS });

    let playback = await startPlayback(page);
    if (!playback.playing) {
      await page.waitForTimeout(2_000);
      playback = await startPlayback(page);
    }
    if (!playback.playing) {
      return { watched: false, reason: playback.reason ?? 'the video never started playing', framesSent: 0, lastPositionMs: 0 };
    }

    const element = await page.$('video');
    const intervalMs = Math.max(200, Math.round(1_000 / Math.max(0.2, fps)));
    const deadline = started + maxSeconds * 1_000;

    while (Date.now() < deadline) {
      if (signal?.aborted) return { watched: true, reason: 'cancelled', framesSent, lastPositionMs };

      const where = await positionMs(page);
      if (!where) return { watched: true, reason: 'the player went away', framesSent, lastPositionMs };
      if (where.ended) return { watched: true, reason: 'the video ended', framesSent, lastPositionMs };

      let image;
      try {
        image = await element.screenshot({ type: 'jpeg', quality: 70, timeout: 5_000 });
      } catch (error) {
        return { watched: true, reason: `the picture could not be taken: ${String(error)}`, framesSent, lastPositionMs };
      }
      if (image.byteLength <= MAX_FRAME_BYTES) {
        await onFrame({ videoMs: where.ms, image, encoding: 'jpeg' });
        framesSent += 1;
        lastPositionMs = where.ms;
      }

      await page.waitForTimeout(intervalMs);
    }
    return { watched: true, reason: 'reached the time limit', framesSent, lastPositionMs };
  } finally {
    await browser.close();
  }
}
