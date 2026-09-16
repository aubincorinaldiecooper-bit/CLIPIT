import { chromium } from 'playwright';

/**
 * Watching a page, rather than resolving it.
 *
 * The old job here was to sniff out a media file URL so something else could
 * download it. This one never leaves the browser: it opens the page, gets the
 * video actually playing, and streams out what is on screen along with where
 * in the video each picture came from. Gander watches the result.
 *
 * Every frame is stamped with the player's own `currentTime`, read at the
 * moment the picture is taken. That stamp is the whole reason this exists:
 * downstream, a frame's position is what lets something the model says be
 * placed in the video exactly instead of guessed at from elapsed time.
 *
 * What this cannot do, stated plainly so nothing downstream assumes it can:
 * there is no audio. A headless browser will not hand over the page's sound,
 * so a page watched this way is watched and not heard.
 */

/** Pictures per second. Gander consumes about one per unit; more is waste. */
const DEFAULT_FPS = 1;

/** Longest a single page is watched before the scout moves on. */
const DEFAULT_MAX_SECONDS = 90;

/** How long to wait for a page to produce a playing video at all. */
const PLAYBACK_TIMEOUT_MS = 20_000;

/** Beyond this, a frame is too big for the runtime to take. */
const MAX_FRAME_BYTES = 900_000;

/**
 * Get a video element playing, past the obstacles a real page puts up.
 *
 * Muted autoplay is what browsers allow without a gesture, and muted costs
 * nothing here because the sound cannot be captured anyway.
 */
async function startPlayback(page) {
  return page.evaluate(async () => {
    const videos = Array.from(document.querySelectorAll('video'));
    // The one that is actually the content: biggest on screen wins.
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

/** Where the player is now, in milliseconds, or null if it has gone away. */
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

/**
 * Open a page, play its video, and hand each frame to `onFrame` with the
 * position it was taken at.
 *
 * `onFrame` is awaited, so a slow consumer slows the capture rather than
 * building a backlog of stale pictures nobody has looked at yet.
 */
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

    // A page that cannot be played is not a failure of the search; it is a
    // page that could not be examined, and the difference matters upstream.
    let playback = await startPlayback(page);
    if (!playback.playing) {
      // One more try after the page has had a moment to build its player.
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
      // A frame the runtime would refuse is not worth the round trip.
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
