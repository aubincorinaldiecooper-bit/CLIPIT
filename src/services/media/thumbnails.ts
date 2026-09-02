import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import type { Logger } from '../../lib/logger.js';
import { setMatchThumbnails } from '../../db/repositories/clipRequests.js';
import { getStorage } from '../storage/s3.js';
import { extractFrameAt, ffprobe } from './ffmpeg.js';
import { planReframe } from './reframe.js';

/** The little a match needs to be given a picture of itself. */
export interface ThumbnailTarget {
  id: string;
  globalStartSeconds: number;
  globalEndSeconds: number;
}

/** How many frames are pulled from one proxy at a time. */
const EXTRACT_CONCURRENCY = 4;

/** The ratio a vertical thumbnail is cut to — the same one the export uses. */
const VERTICAL_ASPECT = '9:16' as const;

/**
 * The width a still is scaled to so that its SHORTER side lands on
 * THUMBNAIL_SHORT_SIDE: a 9:16 crop is 720 wide, a landscape frame 720 tall.
 * Exported for the tests. Never upscales — extractFrameAt scales with
 * min(maxWidth, iw).
 */
export function thumbnailMaxWidth(frame: { width: number; height: number }, vertical: boolean): number {
  if (vertical) return env.THUMBNAIL_SHORT_SIDE;
  if (frame.width >= frame.height && frame.height > 0) {
    return Math.round((env.THUMBNAIL_SHORT_SIDE * frame.width) / frame.height);
  }
  return env.THUMBNAIL_SHORT_SIDE;
}

/**
 * Gives each match a still from its own moment, framed the way the moment
 * will be delivered.
 *
 * Frames come from the PLAYBACK proxy — 720 lines, real frame rate — not the
 * analysis proxy, which is 360p at two frames a second and exists for a
 * model, not a person. Cutting a 320px still from it was the blurry card
 * creators saw. When a video has no playback proxy (older footage, or the
 * build failed) the analysis proxy is used and the log says so, because a
 * soft picture is still better than none.
 *
 * A vertical request's thumbnail is cropped to 9:16 through the SAME window
 * calculation the export uses (planReframe). No focal point has been chosen
 * for a candidate this early, so the window sits at the centre; once a
 * moment is rendered, its poster — cut from the finished 9:16 file at the
 * chosen framing — replaces this picture on the card.
 *
 * Best-effort by design: by the time this runs the matches exist and have
 * real timestamps, so a missing picture must never cost a real result. Every
 * failure is logged and swallowed, and `thumbnail_key` stays null.
 *
 * Returns how many stills were attached.
 */
export async function attachThumbnails(input: {
  videoId: string;
  proxyStorageKey: string;
  playbackStorageKey: string | null;
  /** 'vertical' cuts a 9:16 window; 'original' keeps the source frame. */
  presentation: 'vertical' | 'original';
  matches: ThumbnailTarget[];
  /** A directory this call may write into; the caller owns its lifetime. */
  workDir: string;
  log: Logger;
}): Promise<number> {
  const { videoId, matches, workDir, log } = input;
  if (matches.length === 0) return 0;

  try {
    const startedAt = performance.now();
    const sourceKey = input.playbackStorageKey ?? input.proxyStorageKey;
    const sourcePath = path.join(workDir, 'thumbs-source.mp4');
    await getStorage().downloadToFile(sourceKey, sourcePath);

    const probe = await ffprobe(sourcePath);
    const frame = { width: probe.width ?? 0, height: probe.height ?? 0 };
    const vertical = input.presentation === 'vertical';
    // Centre for a candidate: the focal point is chosen when the moment is
    // rendered, and this picture is replaced by the render's poster then.
    const cropFilter = vertical ? planReframe({ aspect: VERTICAL_ASPECT, focusPct: 50 }, frame).filter : null;
    const maxWidth = thumbnailMaxWidth(frame, vertical);

    const dir = path.join(workDir, 'thumbs');
    await mkdir(dir, { recursive: true });

    const results = await mapWithConcurrency(matches, EXTRACT_CONCURRENCY, async (match) => {
      const file = path.join(dir, `${match.id}.jpg`);
      // A shade after the start: the first frame of a cut often lands on a
      // transition, and a black frame is a worse preview than no preview.
      const at = Math.min(match.globalStartSeconds + 0.5, match.globalEndSeconds);
      if (!(await extractFrameAt(sourcePath, at, file, maxWidth, { cropFilter, quality: 2 }))) return null;

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
      source: input.playbackStorageKey ? 'playback_proxy' : 'analysis_proxy',
      presentation: input.presentation,
      sourceFrame: `${frame.width}x${frame.height}`,
      maxWidth,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return attached.length;
  } catch (error) {
    log.warn('could not attach match thumbnails', { videoId, err: error });
    return 0;
  }
}
