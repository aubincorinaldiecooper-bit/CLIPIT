/**
 * The first real conversation with our MiniCPM-V deployment: ONE chunk, ONE
 * invocation, every fact about the exchange written down.
 *
 * Run it from an environment that holds the real storage credentials and
 * Clipit's Modal API token (Railway shell, or locally with the production
 * env):
 *
 *     node dist/scripts/minicpmContractTest.js [chunk storage key]
 *
 * With no argument it picks the shortest recent analysis chunk itself
 * (preferring 8-40s — a first contact should cost seconds of GPU, not two
 * minutes). It signs a short-lived private URL with the normal storage code
 * and invokes the deployed Modal class directly through the SDK — no HTTP
 * endpoint is involved. It deliberately does NOT loop, retry, or touch more
 * than one chunk: every call wakes the GPU, and a failed first contact
 * should be read, not hammered.
 *
 * Nothing here writes to the database, and neither the signed URL nor any
 * credential is ever printed.
 */
import { ModalClient } from 'modal';
import { env } from '../config/env.js';
import { queryRows } from '../db/pool.js';
import { getStorage } from '../services/storage/s3.js';

const TEST_PROMPT = `Analyze this video segment.

Return:
1. a concise chronological description of what happens visually;
2. important spoken or visible moments you can identify;
3. approximate timestamps in seconds when possible.

Do not invent events that are not observable.`;

async function pickChunk(): Promise<string | null> {
  const rows = await queryRows<{ storage_key: string; duration_seconds: string }>(
    `SELECT storage_key, duration_seconds FROM video_chunks
      ORDER BY (duration_seconds BETWEEN 8 AND 40) DESC, created_at DESC
      LIMIT 1`,
  );
  if (rows.length === 0) return null;
  console.log(
    `auto-picked chunk (${Number(rows[0]!.duration_seconds).toFixed(1)}s):`,
    rows[0]!.storage_key,
  );
  return rows[0]!.storage_key;
}

async function main(): Promise<void> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    console.error(
      'MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set. ' +
        'VIDEO_PROVIDER does not need to be switched for this test.',
    );
    process.exit(2);
  }

  const storageKey = process.argv[2] ?? (await pickChunk());
  if (!storageKey) {
    console.error(
      'No chunk given and none found in the database.\n' +
        'Usage: node dist/scripts/minicpmContractTest.js [chunk storage key]',
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
  console.log('modal target:', `${env.MINICPM_MODAL_APP} / ${env.MINICPM_MODAL_CLS} / ${env.MINICPM_MODAL_METHOD}`);
  console.log('client deadline:', `${env.MINICPM_REQUEST_TIMEOUT_SECONDS}s`);
  console.log('invoking once through the Modal SDK…');

  const modal = new ModalClient({
    tokenId: env.MODAL_TOKEN_ID,
    tokenSecret: env.MODAL_TOKEN_SECRET,
    ...(env.MINICPM_MODAL_ENVIRONMENT ? { environment: env.MINICPM_MODAL_ENVIRONMENT } : {}),
  });

  const startedAt = performance.now();
  try {
    const lookupStartedAt = performance.now();
    const cls = await modal.cls.fromName(env.MINICPM_MODAL_APP, env.MINICPM_MODAL_CLS);
    const instance = await cls.instance();
    const analyze = instance.method(env.MINICPM_MODAL_METHOD);
    const lookupMs = Math.round(performance.now() - lookupStartedAt);

    const callStartedAt = performance.now();
    const payload = (await analyze.remote([], { video_url: videoUrl, prompt: TEST_PROMPT })) as {
      model?: string;
      result?: string;
      metrics?: Record<string, unknown>;
    };
    const callMs = Math.round(performance.now() - callStartedAt);

    console.log('\n--- result ---');
    console.log('lookup latency:', `${(lookupMs / 1000).toFixed(1)}s`);
    console.log('call latency:', `${(callMs / 1000).toFixed(1)}s (cold start included, if any)`);
    console.log('model:', payload?.model ?? '(not reported)');
    console.log('metrics:', JSON.stringify(payload?.metrics ?? null));
    console.log('result chars:', typeof payload?.result === 'string' ? payload.result.length : 0);
    console.log('\nraw result:\n');
    console.log(typeof payload?.result === 'string' ? payload.result : JSON.stringify(payload));
    console.log('\nRead the response before calling again — every call wakes the GPU.');
    process.exit(typeof payload?.result === 'string' && payload.result.trim() !== '' ? 0 : 1);
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    console.error('\ninvocation failed after', `${(latencyMs / 1000).toFixed(1)}s:`);
    console.error(`  ${(error as Error).name}: ${(error as Error).message}`);
    console.error('Inspect before retrying — a cold start can take minutes, and a retry storm is a bill.');
    process.exit(1);
  }
}

void main();
