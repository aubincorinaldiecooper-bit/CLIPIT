/* eslint-disable no-console */
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * ARCHITECTURE SPIKE — actual-video search benchmark. NOT product code.
 *
 * Sends REAL video (not frames, not a scene index) to candidate models and
 * asks the exact question that produced a confirmed false negative: a black
 * car with "bought with investor money" written on it, visible at ~00:54 of
 * the test source. The segment sent is 00:30–01:30, so the correct in-clip
 * answer is ~00:24.
 *
 * Runs on Railway because this sandbox has no egress to the providers.
 * Standalone on purpose: no imports from src/, no full env validation.
 */

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
};

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: need('AWS_ACCESS_KEY_ID'), secretAccessKey: need('AWS_SECRET_ACCESS_KEY') },
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL, forcePathStyle: true } : {}),
});
const BUCKET = need('BUCKET_NAME');

/**
 * The uploaded test source. If SPIKE_SOURCE_KEY is unset, find the largest
 * object under originals/ — the source videos all live there, and the benchmark
 * only needs one real one.
 */
async function resolveSourceKey(): Promise<string> {
  if (process.env.SPIKE_SOURCE_KEY) return process.env.SPIKE_SOURCE_KEY;

  const listing = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'originals/' }));
  const objects = (listing.Contents ?? [])
    .filter((object) => object.Key?.endsWith('.mp4'))
    .sort((a, b) => (b.Size ?? 0) - (a.Size ?? 0));
  if (objects.length === 0 || !objects[0]?.Key) {
    throw new Error('no source video found under originals/; set SPIKE_SOURCE_KEY');
  }
  console.log('auto-selected source:', objects[0].Key, `(${objects[0].Size} bytes)`);
  return objects[0].Key;
}

const SEG_START = 30;
const SEG_END = 90;

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

const Q_VISUAL_TEXT = [
  'Find the black car that has text referring to being bought with investor money.',
  'The clip may or may not contain it. Read any text visible on vehicles.',
  'Return ONLY JSON: {"found":true|false,"timestamp":"MM:SS from the start of THIS clip","confidence":0..1,"details":"what you saw, including the exact text"}',
].join(' ');

const Q_ACTION = [
  'Describe what physically happens in this clip involving any car: who approaches, enters, drives, or gestures at one, and when.',
  'Return ONLY JSON: {"events":[{"timestamp":"MM:SS","description":"..."}]}',
].join(' ');

const Q_MIXED = [
  'Using BOTH the speech you can hear and what is visible: is there a moment where someone talks about money, investors, or buying things while a car is on screen?',
  'Return ONLY JSON: {"found":true|false,"timestamp":"MM:SS","spoken_evidence":"quote if any","visual_evidence":"..."}',
].join(' ');

interface TestResult {
  test: string;
  provider: string;
  model: string;
  format: string;
  videoSeconds: number;
  payloadBytes: number;
  httpStatus: number | string;
  latencyMs: number;
  usage: unknown;
  answer: string;
  error?: string;
}

const results: TestResult[] = [];

async function chatWithVideo(opts: {
  test: string;
  baseUrl: string;
  apiKey: string;
  provider: string;
  model: string;
  prompt: string;
  videoUrl: string;
  format: string;
  videoSeconds: number;
  payloadBytes: number;
}): Promise<void> {
  const started = Date.now();
  const result: TestResult = {
    test: opts.test,
    provider: opts.provider,
    model: opts.model,
    format: opts.format,
    videoSeconds: opts.videoSeconds,
    payloadBytes: opts.payloadBytes,
    httpStatus: 'n/a',
    latencyMs: 0,
    usage: null,
    answer: '',
  };

  try {
    const response = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              { type: 'video_url', video_url: { url: opts.videoUrl } },
            ],
          },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    result.httpStatus = response.status;
    result.latencyMs = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      result.error = text.slice(0, 600);
    } else {
      const payload = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
      result.usage = payload.usage ?? null;
      result.answer = (payload.choices?.[0]?.message?.content ?? '').slice(0, 1500);
    }
  } catch (error) {
    result.latencyMs = Date.now() - started;
    result.error = (error as Error).message;
  }

  results.push(result);
  console.log(`\n=== RESULT ${opts.test} ===`);
  console.log(JSON.stringify(result, null, 2));
}

interface OpenRouterModel {
  id: string;
  architecture?: { input_modalities?: string[] };
}

/** Finds models that accept video input, and picks the two MVP candidates. */
async function discoverVideoModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ gemini: string | null; qwen: string | null; allVideoModels: string[] }> {
  const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`/models failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as { data?: OpenRouterModel[] };

  const allVideoModels = (body.data ?? [])
    .filter((model) => (model.architecture?.input_modalities ?? []).includes('video'))
    .map((model) => model.id)
    .sort();

  // Prefer a non-preview flash Gemini, then any Gemini; a VL Qwen, then any Qwen.
  const gemini =
    allVideoModels.find((id) => /google\/gemini.*flash/i.test(id) && !/preview|thinking/i.test(id)) ??
    allVideoModels.find((id) => /google\/gemini.*flash/i.test(id)) ??
    allVideoModels.find((id) => /google\/gemini/i.test(id)) ??
    null;
  const qwen =
    allVideoModels.find((id) => /qwen.*vl/i.test(id)) ??
    allVideoModels.find((id) => /qwen.*flash/i.test(id)) ??
    allVideoModels.find((id) => /qwen/i.test(id)) ??
    null;

  return { gemini, qwen, allVideoModels };
}

async function main(): Promise<void> {
  await mkdir('/tmp/spike', { recursive: true });

  const sourceKey = await resolveSourceKey();
  console.log('downloading source…', sourceKey);
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
  await pipeline(object.Body as Readable, createWriteStream('/tmp/spike/source.mp4'));

  console.log('cutting segments…');
  // 720p for OpenRouter (URL and base64 variants), 360p for modelbest (base64 body size).
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(SEG_START), '-i', '/tmp/spike/source.mp4', '-t', String(SEG_END - SEG_START), '-vf', 'scale=-2:720', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '/tmp/spike/seg720.mp4']);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(SEG_START), '-i', '/tmp/spike/source.mp4', '-t', String(SEG_END - SEG_START), '-vf', 'scale=-2:360', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '/tmp/spike/seg360.mp4']);

  const seg720 = await readFile('/tmp/spike/seg720.mp4');
  const seg360 = await readFile('/tmp/spike/seg360.mp4');
  console.log('segment sizes', { seg720: seg720.length, seg360: seg360.length });

  const data720 = `data:video/mp4;base64,${seg720.toString('base64')}`;
  const data360 = `data:video/mp4;base64,${seg360.toString('base64')}`;

  // Presigned-URL variant: can a provider fetch private Railway-hosted media?
  const spikeKey = 'spike/seg720.mp4';
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: spikeKey, Body: seg720, ContentType: 'video/mp4' }));
  const presigned = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: spikeKey }), { expiresIn: 3600 });
  console.log('presigned URL host:', new URL(presigned).host);

  const or = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: need('OPENROUTER_API_KEY'), provider: 'openrouter' };

  // Discover video-capable models at runtime rather than trusting a guessed
  // slug: OpenRouter renames and deprecates constantly, and a 404 here would
  // waste the whole run. Prefer a Gemini flash and a Qwen-VL as the two
  // realistic MVP candidates, falling back to whatever else reports video in.
  const { gemini, qwen, allVideoModels } = await discoverVideoModels(or.baseUrl, or.apiKey);
  console.log('video-input models on OpenRouter (first 25):', allVideoModels.slice(0, 25));
  const GEMINI = process.env.SPIKE_GEMINI_MODEL ?? gemini ?? allVideoModels[0];
  const QWEN = process.env.SPIKE_QWEN_MODEL ?? qwen ?? allVideoModels[1] ?? allVideoModels[0];
  console.log('chosen candidates:', { GEMINI, QWEN });
  if (!GEMINI) throw new Error('no video-input model found on OpenRouter');

  await chatWithVideo({ ...or, test: 'T1-gemini-base64-visualtext', model: GEMINI, prompt: Q_VISUAL_TEXT, videoUrl: data720, format: 'base64-720p', videoSeconds: 60, payloadBytes: seg720.length });
  await chatWithVideo({ ...or, test: 'T2-gemini-presigned-visualtext', model: GEMINI, prompt: Q_VISUAL_TEXT, videoUrl: presigned, format: 'presigned-url-720p', videoSeconds: 60, payloadBytes: seg720.length });
  if (QWEN) {
    await chatWithVideo({ ...or, test: 'T3-qwen-base64-visualtext', model: QWEN, prompt: Q_VISUAL_TEXT, videoUrl: data720, format: 'base64-720p', videoSeconds: 60, payloadBytes: seg720.length });
  } else {
    console.log('no Qwen video model discovered; skipping T3');
  }
  await chatWithVideo({ ...or, test: 'T4-gemini-base64-action', model: GEMINI, prompt: Q_ACTION, videoUrl: data720, format: 'base64-720p', videoSeconds: 60, payloadBytes: seg720.length });
  await chatWithVideo({ ...or, test: 'T5-gemini-base64-mixed-audio', model: GEMINI, prompt: Q_MIXED, videoUrl: data720, format: 'base64-720p', videoSeconds: 60, payloadBytes: seg720.length });

  const modelbestKey = process.env.MODELBEST_API_KEY;
  if (modelbestKey) {
    await chatWithVideo({
      test: 'T6-minicpm-base64-visualtext',
      baseUrl: 'https://api.modelbest.cn/v1',
      apiKey: modelbestKey,
      provider: 'modelbest',
      model: process.env.SPIKE_MINICPM_MODEL ?? 'MiniCPM-V-4.6-1B',
      prompt: Q_VISUAL_TEXT,
      videoUrl: data360,
      format: 'base64-360p',
      videoSeconds: 60,
      payloadBytes: seg360.length,
    });
  } else {
    console.log('MODELBEST_API_KEY not set; skipping T6');
  }

  console.log('\n===== SPIKE SUMMARY =====');
  console.log('expected in-clip timestamp for the car: ~00:24 (00:54 global, segment starts 00:30)');
  console.log(JSON.stringify(results.map(({ answer, ...rest }) => ({ ...rest, answerPreview: answer.slice(0, 200) })), null, 2));
  console.log('===== SPIKE DONE =====');
}

main().catch((error) => {
  console.error('spike failed:', error);
  process.exitCode = 1;
});

// Keep the container alive so logs can be read before the service is deleted.
setInterval(() => {}, 60_000);
