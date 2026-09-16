import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { chromium } from 'playwright';
import { watchPage } from './watch.mjs';

const PORT = Number(process.env.PORT || 8080);
const TOKEN = (process.env.WEB_ACCESS_INTERNAL_TOKEN || '').trim();
const MAX_BODY = 16 * 1024;
const NAVIGATION_TIMEOUT_MS = Number(process.env.WEB_ACCESS_NAVIGATION_TIMEOUT_MS || 15000);

function privateAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
  }
  return true;
}

async function assertPublicHttpUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http/https URLs are allowed');
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed');
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((row) => privateAddress(row.address))) {
    throw new Error('URL resolves to a private or unsupported network address');
  }
  return url.toString();
}

function mediaLike(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    // Current Modal transports fetch one media file. Streaming manifests are
    // observed but deliberately not returned until HLS/DASH segment handling
    // is implemented end to end.
    return ['.mp4', '.webm', '.mov', '.m4v'].some((suffix) => path.endsWith(suffix));
  } catch {
    return false;
  }
}

async function resolveMedia(pageUrl) {
  const safePageUrl = await assertPublicHttpUrl(pageUrl);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const candidates = new Set();

    page.on('request', (request) => {
      const url = request.url();
      const type = request.resourceType();
      if (type === 'media' || mediaLike(url)) candidates.add(url);
    });
    page.on('response', (response) => {
      const type = (response.headers()['content-type'] || '').toLowerCase();
      if (type.startsWith('video/') || type.includes('mpegurl') || type.includes('dash+xml')) {
        candidates.add(response.url());
      }
    });

    await page.goto(safePageUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });

    const domCandidates = await page.evaluate(() => {
      const out = [];
      for (const node of document.querySelectorAll('video, video source')) {
        if (node.currentSrc) out.push(node.currentSrc);
        if (node.src) out.push(node.src);
      }
      for (const selector of [
        'meta[property="og:video"]',
        'meta[property="og:video:url"]',
        'meta[property="og:video:secure_url"]',
        'meta[name="twitter:player:stream"]',
      ]) {
        const value = document.querySelector(selector)?.content;
        if (value) out.push(value);
      }
      return out;
    });
    for (const value of domCandidates) candidates.add(value);

    for (const candidate of candidates) {
      try {
        const resolved = new URL(candidate, safePageUrl).toString();
        if (mediaLike(resolved)) {
          await assertPublicHttpUrl(resolved);
          return { pageUrl: safePageUrl, mediaUrl: resolved, resolvedBy: 'playwright' };
        }
      } catch {
        // Ignore one bad candidate and continue looking.
      }
    }
    return { pageUrl: safePageUrl, mediaUrl: null, resolvedBy: 'playwright', reason: 'no public file-backed media URL observed' };
  } finally {
    await browser.close();
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  res.end(encoded);
}

/**
 * Watch a page and stream what is on screen, one line of NDJSON per event.
 *
 * Streamed rather than collected because the point is to watch in step with
 * something else watching: a scout feeds each picture to Gander as it arrives,
 * and a response that only came back at the end would make the whole page a
 * wait rather than a watch.
 *
 * The pictures are base64 inside the JSON line. At about one frame a second
 * that costs little, and it keeps the stream one thing a reader can parse
 * line by line instead of two interleaved framings.
 */
async function streamWatch(req, res, body) {
  const pageUrl = await assertPublicHttpUrl(String(body.pageUrl || '').trim());
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  res.writeHead(200, {
    'content-type': 'application/x-ndjson',
    'cache-control': 'no-store',
    // Nothing downstream should buffer this; the value is in its timing.
    'x-accel-buffering': 'no',
  });

  const write = (event) =>
    new Promise((resolve) => {
      // Respect back-pressure: a consumer slower than the capture should slow
      // the capture, not accumulate pictures nobody has looked at yet.
      if (res.write(`${JSON.stringify(event)}\n`)) resolve();
      else res.once('drain', resolve);
    });

  try {
    const outcome = await watchPage(
      {
        pageUrl,
        maxSeconds: Number(body.maxSeconds) || undefined,
        fps: Number(body.fps) || undefined,
        signal: controller.signal,
      },
      async (frame) => {
        await write({
          type: 'frame',
          video_ms: frame.videoMs,
          encoding: frame.encoding,
          image: frame.image.toString('base64'),
        });
      },
    );
    await write({ type: 'ended', ...outcome });
  } catch (error) {
    // The stream has already started, so the failure is a line in it rather
    // than a status code nobody is waiting on any more.
    await write({ type: 'ended', watched: false, reason: error instanceof Error ? error.message : 'watch failed', framesSent: 0 });
  } finally {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || !['/resolve', '/watch'].includes(req.url)) return send(res, 404, { error: 'not found' });
  if (!TOKEN || req.headers['x-clipit-web-access-token'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

  try {
    const body = await readBody(req);
    if (typeof body.pageUrl !== 'string' || !body.pageUrl.trim()) return send(res, 400, { error: 'pageUrl is required' });
    if (req.url === '/watch') return await streamWatch(req, res, body);
    return send(res, 200, await resolveMedia(body.pageUrl.trim()));
  } catch (error) {
    if (res.headersSent) return res.end();
    return send(res, 422, { error: error instanceof Error ? error.message : 'resolution failed' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`web-access listening on ${PORT}`));
