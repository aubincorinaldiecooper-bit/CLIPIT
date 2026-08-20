import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import type { Logger } from '../../lib/logger.js';
import { setMatchThumbnails } from '../../db/repositories/clipRequests.js';
import { getStorage } from '../storage/s3.js';
import { extractFrameAt } from './ffmpeg.js';

/** The little a match needs to be given a picture of itself. */
export interface ThumbnailTarget {
  id: string;
  globalStartSeconds: number;
  globalEndSeconds: number;
}

/** How many frames are pulled from one proxy at a time. */
const EXTRACT_CONCURRENCY = 4;

/**
 * Gives each match a still from its own moment.
 *
 * Frames come from the low-resolution proxy already in storage rather than the
 * original: one download, then a keyframe seek per match. Best-effort by
 * design — by the time this runs the matches exist and have real timestamps,
 * so a missing picture must never cost a real result. Every failure is logged
 * and swallowed, and `thumbnail_key` stays null.
 *
 * Returns how many stills were attached.
 */
export async function attachThumbnails(input: {
  videoId: string;
  proxyStorageKey: string;
  matches: ThumbnailTarget[];
  /** A directory this call may write into; the caller owns its lifetime. */
  workDir: string;
  log: Logger;
}): Promise<number> {
  const { videoId, proxyStorageKey, matches, workDir, log } = input;
  if (matches.length === 0) return 0;

  try {
    const startedAt = performance.now();
    const proxyPath = path.join(workDir, 'thumbs-source.mp4');
    await getStorage().downloadToFile(proxyStorageKey, proxyPath);

    const dir = path.join(workDir, 'thumbs');
    await mkdir(dir, { recursive: true });

    const results = await mapWithConcurrency(matches, EXTRACT_CONCURRENCY, async (match) => {
      const file = path.join(dir, `${match.id}.jpg`);
      // A shade after the start: the first frame of a cut often lands on a
      // transition, and a black frame is a worse preview than no preview.
      const at = Math.min(match.globalStartSeconds + 0.5, match.globalEndSeconds);
      if (!(await extractFrameAt(proxyPath, at, file))) return null;

      const key = `thumbnails/${videoId}/${match.id}.jpg`;
      await getStorage().uploadFile(key, file, 'image/jpeg');
      return { matchId: match.id, thumbnailKey: key };
    });

    const attached = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
    await setMatchThumbnails(attached);

    log.info('match thumbnails attached', {
      videoId,
      attached: attached.length,
      matches: matches.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return attached.length;
  } catch (error) {
    log.warn('could not attach match thumbnails', { videoId, err: error });
    return 0;
  }
}
