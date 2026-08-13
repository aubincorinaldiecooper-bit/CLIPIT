import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Scratch space for ffmpeg / yt-dlp. Everything here is transient: the durable
 * copy of any artefact lives in object storage.
 */
export async function createWorkDir(prefix: string): Promise<string> {
  await mkdir(env.WORK_DIR, { recursive: true });
  return mkdtemp(path.join(env.WORK_DIR, `${prefix}-`));
}

export async function removeWorkDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn('failed to clean work dir', { dir, err: error });
  }
}

/** Runs `fn` with a temporary directory that is always removed afterwards. */
export async function withWorkDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createWorkDir(prefix);
  try {
    return await fn(dir);
  } finally {
    await removeWorkDir(dir);
  }
}
