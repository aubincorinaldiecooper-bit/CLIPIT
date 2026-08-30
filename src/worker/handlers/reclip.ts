import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { ReclipJob } from '../../queues/index.js';
import { enqueueClipGeneration } from '../../queues/index.js';
import { getClipRequest, listMatchesByIds } from '../../db/repositories/clipRequests.js';
import {
  appendReclipVersion,
  clearReclipPending,
  countReclips,
  ensureInitialVersion,
  listVersions,
  markReclipFailed,
} from '../../db/repositories/reclips.js';
import { getRootClipByMatchId, restoreClipBoundaries, setClipBoundaries } from '../../db/repositories/clips.js';
import { getVideo } from '../../db/repositories/videos.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { getStorage } from '../../services/storage/s3.js';
import { reclipWindowKey } from '../../services/storage/types.js';
import { cutClip, ffprobe } from '../../services/media/ffmpeg.js';
import { askVideoModel, videoPartFromFile, type ContentPart } from '../../services/search/openrouterVideo.js';
import { RECLIP_SYSTEM_PROMPT, buildReclipInstruction, buildTranscriptBlock } from '../../services/search/prompt.js';
import { parseReclipBoundaries } from '../../services/search/modelResponse.js';

/**
 * Re-evaluates ONE moment: cut a wider window around its current boundaries
 * from the analysis proxy, hand that window to the active video provider
 * with the Re-clip prompt, and — if the answer is a usable refinement of the
 * SAME moment — record it as the moment's next version and re-render the
 * clip if one exists.
 *
 * Failure discipline: nothing the person already has is ever made worse. A
 * failure at any step leaves the original boundaries, the original clip and
 * the original file untouched, and writes a visible reason into
 * reclip_status/reclip_error. Success is the only path that changes state.
 */
export async function handleReclip(job: Job<ReclipJob>): Promise<void> {
  const { matchId, clipRequestId } = job.data;
  const log = logger.child({ job: 'reclip', matchId, clipRequestId });

  try {
    await runReclip(job, log);
  } catch (error) {
    const message = safeFailureMessage(error);
    log.error('reclip failed', { err: error });
    await markReclipFailed(matchId, message).catch((markError) => {
      // Losing the failure marker means the UI shows "thinking" forever —
      // worth its own loud log line, because the person will see a hang.
      log.error('could not record reclip failure', { err: markError });
    });
  }
}

async function runReclip(job: Job<ReclipJob>, log: ReturnType<typeof logger.child>): Promise<void> {
  const { matchId, clipRequestId } = job.data;

  const request = await getClipRequest(clipRequestId);
  if (!request) throw new ReclipFailure('This search no longer exists.');
  const [match] = await listMatchesByIds(clipRequestId, [matchId]);
  if (!match) throw new ReclipFailure('This moment no longer exists.');

  const video = await getVideo(request.videoId);
  if (!video) throw new ReclipFailure('The video no longer exists.');
  if (!video.proxyStorageKey) {
    throw new ReclipFailure('The footage for this video is no longer stored, so it cannot be re-examined.');
  }

  // The ceiling is enforced at the endpoint too; re-checked here because the
  // queue outlives the request that filled it.
  const spent = await countReclips(matchId);
  if (spent >= env.MAX_RECLIPS_PER_MOMENT) {
    throw new ReclipFailure('This moment has reached its Re-clip limit.');
  }

  // Version 1 is the first-pass prediction, copied from the immutable match
  // row exactly once. Every re-evaluation reconsiders the CURRENT boundaries
  // — a second Re-clip refines what the first one chose, not the original.
  await ensureInitialVersion(match);
  const versions = await listVersions(matchId);
  const current = versions[versions.length - 1]!;

  const before = env.RECLIP_CONTEXT_BEFORE_SECONDS;
  const after = env.RECLIP_CONTEXT_AFTER_SECONDS;
  const windowStart = Math.max(0, current.startSeconds - before);
  const requestedWindowEnd = current.endSeconds + after;
  const windowEnd =
    video.durationSeconds != null ? Math.min(video.durationSeconds, requestedWindowEnd) : requestedWindowEnd;

  const dir = await mkdtemp(path.join(tmpdir(), 'clipit-reclip-'));
  const windowKey = reclipWindowKey(video.id, matchId);
  try {
    // The window is cut from the analysis PROXY — the same footage the
    // first pass read, at the same fidelity, so a boundary the model moves
    // is moved for editorial reasons and not because it saw different
    // pixels. Cutting also means a Re-clip never re-reads the whole video:
    // the model sees ~(moment + before + after) seconds and nothing else.
    const proxyPath = path.join(dir, 'proxy.mp4');
    await getStorage().downloadToFile(video.proxyStorageKey, proxyPath);
    const proxyProbe = await ffprobe(proxyPath);

    const windowPath = path.join(dir, 'window.mp4');
    await cutClip({
      inputPath: proxyPath,
      outputPath: windowPath,
      startSeconds: windowStart,
      endSeconds: windowEnd,
      hasAudio: proxyProbe.hasAudio,
    });
    // The cut file's own duration is the truth the model's answer is
    // validated against — a window requested past the end of the footage
    // comes back shorter, and timestamps must clamp to what it can see.
    const windowProbe = await ffprobe(windowPath);
    const windowDuration = windowProbe.durationSeconds;
    if (!windowDuration || windowDuration <= 0) {
      throw new ReclipFailure('The footage around this moment could not be read.');
    }

    // MiniCPM receives the window as a signed URL, so it must exist in
    // storage; the OpenRouter path reads the local file. Both see the same
    // bytes.
    await getStorage().uploadFile(windowKey, windowPath, 'video/mp4');

    const localOriginalStart = current.startSeconds - windowStart;
    const localOriginalEnd = Math.min(current.endSeconds - windowStart, windowDuration);

    const parts: ContentPart[] = [
      {
        type: 'text',
        text: buildReclipInstruction({
          instruction: request.instruction,
          originalLocalStartSeconds: localOriginalStart,
          originalLocalEndSeconds: localOriginalEnd,
          segmentDurationSeconds: windowDuration,
        }),
      },
    ];
    const videoPart = await videoPartFromFile(windowPath);
    parts.push(videoPart.part);

    // The transcript the first pass used, sliced to the window and restated
    // in window-relative seconds so both evidence streams share a clock.
    const segments = await listTranscriptSegmentsInRange(video.id, windowStart, windowEnd);
    if (segments.length > 0) {
      parts.push({
        type: 'text',
        text: buildTranscriptBlock(
          segments.map((segment) => ({
            localStartSeconds: Math.max(0, segment.startSeconds - windowStart),
            localEndSeconds: Math.max(0, segment.endSeconds - windowStart),
            text: segment.text,
          })),
        ),
      });
    }

    const answer = await askVideoModel({
      chunkIndex: 0,
      chunkDurationSeconds: windowDuration,
      systemPrompt: RECLIP_SYSTEM_PROMPT,
      parts,
      videoBytes: videoPart.bytes,
      purpose: 'search',
      videoStorageKey: windowKey,
      onUsage: (usage) => {
        // 'reclip' has its own stage so its calls, milliseconds and dollars
        // never blend into first-pass analysis — re-clip cost share is a
        // business number, and it only exists if the rows keep it separate.
        void recordModelUsage({ ...usage, stage: 'reclip', videoId: video.id, clipRequestId });
      },
    });

    const refined = parseReclipBoundaries(answer.content, windowDuration);
    if (!refined) {
      throw new ReclipFailure('The model did not return usable boundaries. Nothing was changed.');
    }

    const newStart = Number((windowStart + refined.startSeconds).toFixed(3));
    const newEnd = Number((windowStart + refined.endSeconds).toFixed(3));

    // Same-moment identity, enforced rather than hoped for: the refined cut
    // must overlap the boundaries it was asked to reconsider. An answer
    // elsewhere in the window is a different moment, and accepting it would
    // silently replace what the person was evaluating.
    if (newStart >= current.endSeconds || newEnd <= current.startSeconds) {
      throw new ReclipFailure('The model wandered to a different moment. Nothing was changed.');
    }

    // If a clip file exists, claim it before recording the new version: the
    // version history must never say boundaries moved while the rendered
    // file provably kept the old ones.
    const clip = await getRootClipByMatchId(matchId);
    let claimed = null;
    if (clip) {
      claimed = await setClipBoundaries(clip.id, newStart, newEnd);
      if (!claimed) {
        throw new ReclipFailure('The clip was busy rendering. Try again when it settles.');
      }
      try {
        await enqueueClipGeneration({ clipId: clip.id });
      } catch (queueError) {
        await restoreClipBoundaries(clip.id, {
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          boundariesEditedAt: clip.boundariesEditedAt,
        });
        throw queueError;
      }
    }

    const version = await appendReclipVersion({
      matchId,
      startSeconds: newStart,
      endSeconds: newEnd,
      provider: answer.provider,
      model: answer.model,
      promptVersion: answer.promptVersion,
    });
    await clearReclipPending(matchId);

    log.info('moment re-clipped', {
      version: version.version,
      startSeconds: newStart,
      endSeconds: newEnd,
      startShiftSeconds: Number((newStart - current.startSeconds).toFixed(3)),
      endShiftSeconds: Number((newEnd - current.endSeconds).toFixed(3)),
      clipReRendered: Boolean(claimed),
      provider: answer.provider,
      model: answer.model,
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    // The window object exists only to be looked at once; leaving it would
    // bill storage for footage retention was never told about.
    await getStorage()
      .remove(windowKey)
      .catch(() => undefined);
  }
}

/** A failure whose message was written to be shown to the person. */
class ReclipFailure extends Error {}

function safeFailureMessage(error: unknown): string {
  if (error instanceof ReclipFailure) return error.message;
  // Anything else may carry provider internals; the row gets a generic
  // sentence and the log keeps the real one.
  return 'Re-clip did not finish. The original clip is untouched — try again.';
}
