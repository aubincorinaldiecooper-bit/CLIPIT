import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { askVideoModel, videoPartFromFile, type ContentPart } from '../search/openrouterVideo.js';
import { COMPOSITION_INSTRUCTION, COMPOSITION_SYSTEM_PROMPT } from '../search/composition.js';
import type { UsageTally } from '../usageTally.js';
import { createAnalysisProxy } from './ffmpeg.js';

/**
 * Asking the model how one moment should be framed for 9:16.
 *
 * This used to live inside the deck orchestrator, which framed every moment
 * a search found before anyone had looked at it. Framing now happens when a
 * person keeps a moment, from the render job — one call, for one clip they
 * chose. Same shape as every other video call in the system: same queue,
 * same retries, same cost accounting. A second way to reach the model would
 * be a second thing to keep correct.
 *
 * Built per clip so it can carry the clip's own storage key: the MiniCPM
 * lane sends a signed URL to that key, and the OpenRouter lane sends bytes.
 */
export interface FramingAskInput {
  videoId: string;
  /** The question that found this moment, for the cost row. Null if it is gone. */
  clipRequestId: string | null;
  /** The canonical cut's key in storage — what the MiniCPM lane is pointed at. */
  canonicalKey: string;
  durationSeconds: number;
  /** A directory this call may write a proxy into; the caller owns its lifetime. */
  workDir: string;
  /** A request's running total, when the call is made inside one. */
  tally?: UsageTally;
}

/** The pipeline's contract: hand it the cut on disk, get the model's words back. */
export type FramingAsker = (canonicalPath: string) => Promise<{ content: string | null; provider: string; model: string }>;

export function askModelForFraming(input: FramingAskInput): FramingAsker {
  return async (canonicalPath: string) => {
    const parts: ContentPart[] = [{ type: 'text', text: COMPOSITION_INSTRUCTION }];

    // The MiniCPM lane sends a signed URL to videoStorageKey and reads only
    // the text parts, so base64-encoding the clip for it produces a
    // multi-megabyte string that is built and thrown away. The OpenRouter
    // lane genuinely needs the bytes.
    const usesStorageKey = env.VIDEO_PROVIDER === 'minicpm';
    // Named before anything can create it, and cleaned up in the `finally`
    // below, so a proxy that ffmpeg only half-wrote is removed on the same
    // path as one that was read successfully.
    let proxyPath: string | null = null;
    try {
      let videoBytes: number;
      if (usesStorageKey) {
        videoBytes = (await stat(canonicalPath)).size;
      } else {
        // ...but it must never be handed the DELIVERY file. The canonical
        // clip is full quality: thirty seconds of it is ~20MB, and base64
        // adds a third again, which the provider refuses with a 413 before
        // looking at a single frame. Every candidate then falls back to the
        // safe composition, so no crop is chosen by anything that actually
        // watched the footage. That is what production did on 2026-09-01.
        //
        // Framing is answered in NORMALISED coordinates (focal_x/focal_y in
        // 0..1), so 360p settles it exactly as well as 1080p does. This is
        // the same proxy, at the same settings, that the search lane already
        // reads from — around fifty times smaller than what was being sent.
        proxyPath = path.join(input.workDir, `composition-${randomUUID()}.mp4`);
        await createAnalysisProxy(canonicalPath, proxyPath, Math.max(1, Math.ceil(input.durationSeconds)));
        const videoPart = await videoPartFromFile(proxyPath);
        parts.push(videoPart.part);
        videoBytes = videoPart.bytes;
      }

      const answer = await askVideoModel({
        chunkIndex: 0,
        chunkDurationSeconds: input.durationSeconds,
        systemPrompt: COMPOSITION_SYSTEM_PROMPT,
        parts,
        videoBytes,
        purpose: 'search',
        videoStorageKey: input.canonicalKey,
        onUsage: (usage) => {
          // Counted in the request's total when there is one...
          input.tally?.add(usage);
          // ...and stored under its own stage regardless: what framing costs
          // is a separate business number from what searching costs, and it
          // only exists if the rows keep it apart.
          void recordModelUsage({
            ...usage,
            stage: 'composition',
            videoId: input.videoId,
            clipRequestId: input.clipRequestId ?? undefined,
          });
        },
      });

      return { content: answer.content, provider: answer.provider, model: answer.model };
    } finally {
      // Failing to delete the proxy must never fail a framing that succeeded.
      if (proxyPath) await rm(proxyPath, { force: true }).catch(() => {});
    }
  };
}
