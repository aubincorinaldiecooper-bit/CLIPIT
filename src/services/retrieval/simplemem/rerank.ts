import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '../../../config/env.js';
import { run } from '../../../lib/exec.js';
import { getStorage } from '../../storage/s3.js';
import { searchVideoChunk, type VideoUsageReporter } from '../../search/openrouterVideo.js';
import type { Candidate } from './candidates.js';

interface FootageVerificationResult {
  model: string;
  revision: null;
  metrics: Record<string, unknown>;
}

export interface VerifiedSimpleMemCandidates {
  candidates: Candidate[];
  failed: Array<Candidate & { reason: string }>;
  result: FootageVerificationResult;
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download SimpleMem verification source (${response.status})`);
  }
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}

async function cutInterval(sourcePath: string, outputPath: string, startSeconds: number, endSeconds: number): Promise<void> {
  const duration = Math.max(0.05, endSeconds - startSeconds);
  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      startSeconds.toFixed(3),
      '-i',
      sourcePath,
      '-t',
      duration.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeoutMs: Math.max(120_000, Math.ceil(duration * 4_000)) },
  );
}

/**
 * Verifies Omni-SimpleMem's candidate windows with Clipit's normal footage
 * watcher. SimpleMem tells us where to look; this function re-opens those
 * exact source intervals and only keeps candidates the configured video model
 * actually confirms.
 *
 * This deliberately does not use the retired Media Index/Qwen reranker. The
 * evidence boundary is the same one as the full fallback search: a visual
 * claim becomes evidence only after a model has been given the actual MP4.
 */
export async function rerankSimpleMemCandidates(input: {
  query: string;
  candidates: readonly Candidate[];
  videoUrl: string;
  videoKey: string;
  expectedBytes: number;
}): Promise<VerifiedSimpleMemCandidates> {
  const workDir = await mkdtemp(path.join(tmpdir(), 'clipit-simplemem-verify-'));
  const sourcePath = path.join(workDir, 'source.mp4');
  const verified: Candidate[] = [];
  const failed: Array<Candidate & { reason: string }> = [];
  const usage: Parameters<VideoUsageReporter>[0][] = [];
  let provider = 'clipit-footage';
  let model = env.OPENROUTER_VIDEO_MODEL;
  let promptVersion: string | null = null;

  try {
    await download(input.videoUrl, sourcePath);

    for (const [index, candidate] of input.candidates.entries()) {
      const clipPath = path.join(workDir, `candidate-${index}.mp4`);
      const storageKey = `verification/simplemem/${encodeURIComponent(input.videoKey)}/${Date.now()}-${index}.mp4`;
      try {
        await cutInterval(sourcePath, clipPath, candidate.startSeconds, candidate.endSeconds);
        await getStorage().uploadFile(storageKey, clipPath, 'video/mp4');

        const result = await searchVideoChunk({
          instruction: input.query,
          mode: 'visual',
          chunkIndex: index,
          chunkCount: input.candidates.length,
          chunkDurationSeconds: Math.max(0.05, candidate.endSeconds - candidate.startSeconds),
          videoPath: clipPath,
          videoStorageKey: storageKey,
          transcript: [],
          onUsage: (row) => usage.push(row),
        });
        provider = result.provider;
        model = result.model;
        promptVersion = result.promptVersion || promptVersion;

        const match = [...result.matches]
          .filter((item) => item.confidence >= env.MIN_MATCH_CONFIDENCE)
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (!match) {
          failed.push({ ...candidate, reason: 'actual footage watcher found no matching moment in this interval' });
          continue;
        }

        verified.push({
          ...candidate,
          score: Math.max(0, Math.min(1, match.confidence)),
          description: match.description || candidate.description,
        });
      } catch (error) {
        failed.push({
          ...candidate,
          reason: error instanceof Error ? error.message : 'actual footage verification failed',
        });
      } finally {
        await getStorage().remove(storageKey).catch(() => undefined);
        await rm(clipPath, { force: true }).catch(() => undefined);
      }
    }

    const totalCostUsd = usage.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    const totalTokens = usage.reduce((sum, row) => sum + row.totalTokens, 0);
    const totalLatencyMs = usage.reduce((sum, row) => sum + row.latencyMs, 0);

    return {
      candidates: verified.sort((a, b) => b.score - a.score),
      failed,
      result: {
        model,
        revision: null,
        metrics: {
          verifier: 'clipit-actual-footage',
          provider,
          prompt_version: promptVersion,
          calls: usage.length,
          total_cost_usd: totalCostUsd,
          total_tokens: totalTokens,
          total_latency_ms: totalLatencyMs,
          source_bytes: input.expectedBytes,
        },
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
