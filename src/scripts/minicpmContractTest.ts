/**
 * The first real conversation with our MiniCPM-V deployment: ONE chunk, ONE
 * request, every fact about the exchange written down.
 *
 * Run it from an environment that holds the real storage credentials and the
 * Clipit Modal proxy token (Railway shell, or locally with the production
 * env):
 *
 *     node dist/scripts/minicpmContractTest.js chunks/<videoId>/<index>.mp4
 *
 * The argument is the storage key of an existing analysis chunk. The script
 * signs a short-lived URL for it with the normal storage code (the object
 * stays private), sends the endpoint the capability-test prompt, and prints
 * the measurements the rollout decision needs. It deliberately does NOT loop,
 * retry, or touch more than one chunk: every call wakes a GPU, and a failed
 * first contact should be read, not hammered.
 *
 * Nothing here writes to the database, and the signed URL is never printed.
 */
import { env } from '../config/env.js';
import { getStorage } from '../services/storage/s3.js';

const TEST_PROMPT = `Analyze this video segment.

Return:
1. a concise chronological description of what happens visually;
2. important spoken or visible moments you can identify;
3. approximate timestamps in seconds when possible.

Do not invent events that are not observable.`;

async function main(): Promise<void> {
  const storageKey = process.argv[2];
  if (!storageKey) {
    console.error('Usage: node dist/scripts/minicpmContractTest.js <chunk storage key>');
    process.exit(2);
  }
  if (!env.MINICPM_VIDEO_URL || !env.MODAL_PROXY_TOKEN_ID || !env.MODAL_PROXY_TOKEN_SECRET) {
    console.error(
      'MINICPM_VIDEO_URL, MODAL_PROXY_TOKEN_ID and MODAL_PROXY_TOKEN_SECRET must all be set. ' +
        'VIDEO_PROVIDER does not need to be switched for this test.',
    );
    process.exit(2);
  }

  const head = await getStorage().head(storageKey);
  if (!head) {
    console.error(`No object in storage at "${storageKey}" — pass an existing analysis chunk key.`);
    process.exit(2);
  }

  const videoUrl = await getStorage().createDownloadUrl(storageKey, {
    expiresInSeconds: env.MINICPM_REQUEST_TIMEOUT_SECONDS,
  });

  console.log('chunk:', storageKey);
  console.log('chunk bytes:', head.sizeBytes);
  console.log('proxy spec:', `${env.PROXY_HEIGHT}p, ${env.PROXY_FPS} fps (from env — the chunk was cut from this proxy)`);
  console.log('endpoint:', env.MINICPM_VIDEO_URL);
  console.log('timeout:', `${env.MINICPM_REQUEST_TIMEOUT_SECONDS}s`);
  console.log('sending one request…');

  const body = JSON.stringify({ video_url: videoUrl, prompt: TEST_PROMPT });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.MINICPM_REQUEST_TIMEOUT_SECONDS * 1000);
  const startedAt = performance.now();

  try {
    const response = await fetch(env.MINICPM_VIDEO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Modal-Key': env.MODAL_PROXY_TOKEN_ID,
        'Modal-Secret': env.MODAL_PROXY_TOKEN_SECRET,
      },
      body,
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const text = await response.text();

    console.log('\n--- result ---');
    console.log('http status:', response.status);
    console.log('latency:', `${(latencyMs / 1000).toFixed(1)}s`);
    console.log('request body bytes:', Buffer.byteLength(body), '(the video went by URL, not in the body)');
    console.log('response bytes:', Buffer.byteLength(text));
    console.log('\nraw response:\n');
    console.log(text);
    console.log('\nRead the response before calling again — every call wakes a GPU.');
    process.exit(response.ok ? 0 : 1);
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const aborted = (error as Error).name === 'AbortError';
    console.error('\nrequest failed after', `${(latencyMs / 1000).toFixed(1)}s:`, aborted ? 'timed out' : (error as Error).message);
    console.error('Inspect before retrying — a cold start can take minutes, and a retry storm is a bill.');
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

void main();
