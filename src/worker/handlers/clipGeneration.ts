import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger, type Logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { clipKey } from '../../services/storage/types.js';
import { cutClip, ffprobe } from '../../services/media/ffmpeg.js';
import { appendReclipVersion, clearReclipPending, markReclipFailed } from '../../db/repositories/reclips.js';
import { captionsSchema, prepareCaptionFilters } from '../../services/media/captions.js';
import { applyClipPadding } from '../../services/timestamps.js';
import { withTransaction } from '../../db/pool.js';
import { getClip, setClipStatus, restoreClipBoundaries } from '../../db/repositories/clips.js';
import { commitRender } from '../../db/repositories/verticalMedia.js';
import { discardUploadedObjects } from '../../services/media/verticalPipeline.js';
import { releaseObjects, renderDeliveredMedia } from '../../services/media/rerender.js';
import { RECLIP_FAILED_MESSAGE } from '../../services/media/unknownRender.js';
import { discardVariants } from '../../db/repositories/clipVariants.js';
import { recordObjectRelease } from '../../db/repositories/objectReleases.js';
import { recordUnknownRender } from '../../db/repositories/unknownRenders.js';
import { getVideo } from '../../db/repositories/videos.js';
import { enqueueObjectRelease, type ClipGenerationJob } from '../../queues/index.js';
import type { Clip } from '../../domain/types.js';

/**
 * A write whose reply was lost, and a row that could not be read afterwards.
 *
 * The render may or may not have landed; nothing about it is known to have
 * failed. So it is NOT a failure: no boundaries are put back, no Re-clip is
 * marked failed, no error is written on the clip — any of those, done on a
 * render that did land, would tell the person their re-cut failed over a
 * file that is playing. The queue retries the job, and the retry starts by
 * asking the row whether the earlier attempt landed (see
 * earlierAttemptLanded). The objects of both the old render and this one
 * are queued for release, and the release keeps whichever the row names.
 *
 * That release is the only record of those objects, so it is not allowed
 * to quietly fail: if it cannot be queued, the keys are written onto the
 * job itself, and the next attempt queues their release before it does
 * anything else — refusing to go on until that is done, so a retry can
 * never finish while an earlier attempt's objects have no record at all.
 *
 * The job's LAST attempt has no retry to settle it, so it writes the render
 * down (unknown_renders) for the footage sweep to settle once the database
 * answers — see settleUnknownRender. Nothing stays "generating" forever.
 */
export class RenderOutcomeUnknownError extends Error {
  constructor(
    readonly original: unknown,
    /** The file this render wrote; the row naming it proves the write landed — when the key is new to the row. */
    readonly storageKey: string,
    /** The file the row named before this render, if any. */
    readonly previousStorageKey: string | null,
    /** Objects neither the queue nor the database would take on record; only the job and this error know them. */
    readonly unreleasedKeys: string[],
  ) {
    super(`the render's outcome is unknown: ${errorMessage(original)}`);
    this.name = 'RenderOutcomeUnknownError';
  }
}

/**
 * How long to wait between the reads that ask the row what it names after a
 * write's reply was lost. The database answered a moment ago; one dropped
 * connection is the usual case, and a few seconds of patience separate that
 * from an outage.
 */
const REREAD_DELAYS_MS = [500, 1_000, 2_000, 4_000];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Every storage key the clip's row names right now — asked again, with a
 * short wait between, if the first read fails. Null once the reads are
 * spent: the caller then knows nothing, and must act as if it knows nothing.
 */
async function keysNamedByRow(clipId: string, log: Logger): Promise<Set<string> | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const current = await getClip(clipId);
      return new Set(
        [current?.storageKey, current?.posterStorageKey, current?.derivativeStorageKey]
          .filter((key): key is string => typeof key === 'string' && key.length > 0),
      );
    } catch (error) {
      const delay = REREAD_DELAYS_MS[attempt];
      if (delay === undefined) {
        log.error('the render\'s write failed and the row could not be read, even after waiting', { err: error, reads: attempt + 1 });
        return null;
      }
      log.warn('the row could not be read after the write; asking again', { err: error, inMs: delay });
      await sleep(delay);
    }
  }
}

/** JSON with every object's keys in one order, so two spellings of the same spec compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/**
 * Whether an earlier attempt of THIS re-render landed although its reply was
 * lost — asked at the start of a retry, so the retry records nothing twice
 * and cuts nothing again.
 *
 * The evidence is the row. Every attempt marks the clip 'generating' before
 * it cuts, and only a landed write marks it 'ready' again before the job's
 * attempts are spent: a Re-clip's definite failure leaves the row alone
 * until the last attempt, after which no retry runs; a Replace's puts the
 * row back to 'ready' but with the captions it had, not the job's. So a row
 * that is 'ready' AND carries what this job was to write — the Re-clip's
 * boundaries, the Replace's spec — was written by this render.
 */
function earlierAttemptLanded(clip: Clip, data: ClipGenerationJob): boolean {
  if (clip.status !== 'ready' || !clip.storageKey) return false;
  if (data.reclip) {
    return clip.startSeconds === data.reclip.startSeconds && clip.endSeconds === data.reclip.endSeconds;
  }
  if (data.captions !== undefined) {
    return canonicalJson(clip.captions ?? []) === canonicalJson(data.captions);
  }
  return false;
}

/**
 * Cuts a match out of the ORIGINAL source (never the analysis proxy) and stores
 * the result as MP4 / H.264 / AAC.
 */
export async function handleClipGeneration(job: Job<ClipGenerationJob>): Promise<void> {
  const { clipId } = job.data;
  const log = logger.child({ job: 'clip-generation', clipId });

  const clip = await getClip(clipId);

  // An earlier attempt left objects of unknown ownership and could not queue
  // their release (see RenderOutcomeUnknownError). That comes before every
  // shortcut below — a clip already generated, a clip that is gone — because
  // those are exactly the cases where the earlier attempt's write landed and
  // this one would otherwise return without a word. A queue that refuses
  // again ends this attempt here: the job retries later rather than
  // finishing with those objects on record nowhere.
  if (job.data.unresolvedKeys?.length) {
    const keys = job.data.unresolvedKeys;
    await enqueueObjectRelease(keys, { videoId: clip?.videoId ?? '', clipId, reason: 'render_outcome_unknown' });
    log.warn('an earlier attempt\'s objects of unknown ownership are now queued for release', { keys });
    // The record has served; a job that cannot clear it queues them again
    // next time, which the release's ownership check makes harmless.
    await job.updateData?.({ ...job.data, unresolvedKeys: undefined }).catch((updateError: unknown) => {
      log.warn('the unresolved keys stay on the job; the next attempt will queue them again', { err: updateError });
    });
  }

  if (!clip) {
    log.warn('clip no longer exists, dropping job');
    return;
  }
  // Re-render jobs (a Replace, or a Re-clip applying new boundaries) carry
  // their intent in the job and must run even against a finished clip; only
  // a plain generation of an already-finished clip is a duplicate worth
  // skipping.
  if (clip.status === 'ready' && clip.storageKey && job.data.captions === undefined && job.data.reclip === undefined) {
    log.info('clip already generated, skipping');
    return;
  }
  // A retry of a re-render whose earlier attempt landed without saying so:
  // the row already carries this render. Cutting again would put a second
  // file under the same id and, for a Re-clip, record its version twice.
  if (job.attemptsMade > 0 && earlierAttemptLanded(clip, job.data)) {
    log.warn('an earlier attempt of this render landed although its reply was lost; nothing left to do', {
      attemptsMade: job.attemptsMade,
      key: clip.storageKey,
    });
    return;
  }

  const video = await getVideo(clip.videoId);
  if (!video?.originalStorageKey) {
    await setClipStatus(clipId, 'failed', { errorMessage: 'Source video is no longer available' });
    return;
  }

  await setClipStatus(clipId, 'generating');
  await job.updateProgress({ stage: 'generating', percent: 10 });

  try {
    // Widen the match slightly so the moment is not clipped off at either edge.
    const padded = applyClipPadding(
      { startSeconds: clip.startSeconds, endSeconds: clip.endSeconds },
      {
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        videoDurationSeconds: video.durationSeconds ?? Number.POSITIVE_INFINITY,
        minDurationSeconds: env.MIN_CLIP_SECONDS,
        maxDurationSeconds: env.MAX_CLIP_SECONDS,
      },
    );

    await withWorkDir(`clip-${clipId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await getStorage().downloadToFile(video.originalStorageKey!, sourcePath);
      await job.updateProgress({ stage: 'cutting', percent: 40 });

      // Captions are burned during the cut, sized against the real frame.
      // A Replace carries its spec in the job (the row keeps the old one
      // until this render succeeds); everything else renders the row's. The
      // spec is re-validated here so a hand-edited row cannot smuggle text
      // into a shell command.
      let videoFilters: string[] | undefined;
      const spec = captionsSchema.safeParse(job.data.captions ?? clip.captions ?? []);
      if (spec.success && spec.data.length > 0) {
        const probe = await ffprobe(sourcePath);
        videoFilters = await prepareCaptionFilters(spec.data, dir, {
          videoWidth: probe.width ?? Math.round(((probe.height ?? 720) * 16) / 9),
          videoHeight: probe.height ?? 720,
        });
      }

      const outputPath = path.join(dir, `${clipId}.mp4`);
      const result = await cutClip({
        inputPath: sourcePath,
        outputPath,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        hasAudio: video.hasAudio ?? true,
        ...(videoFilters ? { videoFilters } : {}),
      });

      // A re-render puts a different file under the same clip id. Its bytes
      // go to a FRESH key beside the old ones, so the working clip is never
      // overwritten before the row accepts the new one; a first render keeps
      // the plain key it always had.
      const rerender = clip.storageKey !== null && (job.data.captions !== undefined || job.data.reclip !== undefined);
      const render = rerender ? randomUUID().slice(0, 8) : undefined;

      // The card's picture — and for a vertical moment the 9:16 file — were
      // made from the cut, so they are made again from THIS one, first, at
      // fresh keys too. If any of it fails, nothing has been replaced yet and
      // the failure below rolls this render back like any other.
      const delivered = await renderDeliveredMedia({
        clip,
        videoId: video.id,
        canonicalPath: outputPath,
        workDir: dir,
        hasAudio: video.hasAudio ?? true,
        cut: result,
        render,
        log,
      });

      await job.updateProgress({ stage: 'uploading', percent: 80 });

      const key = clipKey(video.id, clipId, render);
      // Everything this render uploaded: on a failure, whatever the row does
      // not name goes, and the previous cut and media stay exactly as they
      // were. A first render's plain key is in the list too — a cut whose
      // row never came to name it would otherwise sit in storage for good.
      const fresh = [key, ...(delivered?.freshKeys ?? [])];
      const context = { videoId: video.id, clipId };
      // Platform shapes cut from the master this render replaces. Their rows
      // go inside the transaction; their files, after it.
      let staleVariantKeys: string[] = [];
      try {
        await getStorage().uploadFile(key, outputPath, 'video/mp4');

        // ONE transaction. The row takes the new cut and the media made
        // from it — a Replace's spec included — the platform shapes cut from
        // the OLD master go (posting one would send footage the person just
        // replaced), and a Re-clip's next version is recorded with its
        // pending state cleared: together, or not at all. As separate writes
        // a failure after the first left a row naming a new cut whose
        // history still said the re-cut had failed.
        await withTransaction(async (client) => {
          const wrote = await commitRender(clipId, {
            storageKey: key,
            durationSeconds: Number(result.durationSeconds.toFixed(3)),
            sizeBytes: result.sizeBytes,
            captions: job.data.captions,
            media: delivered?.media ?? { kind: 'none' },
          }, client);
          if (!wrote) {
            throw new Error(`Clip ${clipId} no longer exists — its render has nowhere to be recorded`);
          }
          if (job.data.captions !== undefined || job.data.reclip !== undefined) {
            staleVariantKeys = (await discardVariants(clipId, client)) ?? [];
          }
          if (job.data.reclip) {
            const { matchId, startSeconds, endSeconds, provider, model, promptVersion } = job.data.reclip;
            await appendReclipVersion({ matchId, startSeconds, endSeconds, provider, model, promptVersion }, client);
            await clearReclipPending(matchId, client);
          }
        });
      } catch (error) {
        // The write's outcome may be unknown: a connection can drop after
        // COMMIT, and then the row names every fresh key while this promise
        // rejected. So the row is asked before anything is deleted, and what
        // it names, this render keeps.
        const named = await keysNamedByRow(clipId, log);
        if (named === null) {
          // Nothing is known. Nothing is deleted now, and nothing is marked
          // failed (see RenderOutcomeUnknownError). Both renders' objects go
          // to the release, which asks the rows again when it acts and keeps
          // whichever they name — the previous cut and media if the write
          // did not land, this render's if it did.
          const unresolved = [render ? clip.storageKey : null, ...(delivered?.oldKeys ?? []), ...staleVariantKeys, ...fresh]
            .filter((unresolvedKey): unresolvedKey is string => typeof unresolvedKey === 'string' && unresolvedKey.length > 0);
          log.error('the render\'s outcome is unknown; its objects and the previous ones are queued for a release that will ask the row', {
            ...context, keys: unresolved, err: error,
          });
          let unreleased: string[] = [];
          try {
            await enqueueObjectRelease(unresolved, { ...context, reason: 'render_outcome_unknown' });
          } catch (queueError) {
            // The release was the record. Without it the keys are written
            // down where the queue is not needed: in the database, for the
            // footage sweep to hand to the queue when it next runs — a
            // record that holds even on the job's last attempt — and on the
            // job, for the next attempt to queue before anything else. If
            // neither can be written, the log line above is the map to
            // them — said so, rather than silently.
            log.error('the release could not be queued either; recording the keys for the sweep and the next attempt', {
              ...context, keys: unresolved, err: queueError,
            });
            await recordObjectRelease(unresolved, { ...context, reason: 'render_outcome_unknown' }).catch((recordError: unknown) => {
              log.error('the keys could not be recorded in the database either', { ...context, keys: unresolved, err: recordError });
              unreleased = unresolved;
            });
            await job.updateData?.({ ...job.data, unresolvedKeys: unresolved }).catch((updateError: unknown) => {
              log.error('the keys could not be recorded on the job; they are orphaned unless the database record or the logs find them', {
                ...context, keys: unresolved, err: updateError,
              });
            });
          }
          throw new RenderOutcomeUnknownError(error, key, clip.storageKey, unreleased);
        }
        // The row naming this render's key proves the write landed only when
        // the key is NEW to the row: a first render at the plain key, on a
        // row that already named that key from an earlier attempt, proves
        // nothing either way — so that is treated as the failure it reported,
        // and the object the row still names is kept.
        const landed = named.has(key) && clip.storageKey !== key;
        if (landed) {
          // It landed; only the reply was lost. Carry on as committed.
          log.warn('the render\'s write landed although its reply did not; carrying on as committed', { ...context, err: error });
        } else {
          await discardUploadedObjects(fresh.filter((freshKey) => !named.has(freshKey)), { ...context, reason: 'render_commit_failed' });
          throw error;
        }
      }

      // Committed. The previous objects go only now — after everything that
      // could still fail has succeeded — so a failure anywhere above leaves
      // the old cut and its media where the row can still name them.
      await releaseObjects(
        [render ? clip.storageKey : null, ...(delivered?.oldKeys ?? []), ...staleVariantKeys],
        [key, ...(delivered?.freshKeys ?? [])],
        context,
        log,
      );
      if (job.data.reclip) {
        const { matchId, startSeconds, endSeconds } = job.data.reclip;
        log.info('reclip applied', { matchId, startSeconds, endSeconds });
      }

      log.info('clip generated', {
        key,
        // Both ranges make boundary problems diagnosable from one log line.
        // With the default zero padding they are identical; an intentional
        // deployment override remains visible instead of silently changing
        // what the timestamps on screen mean.
        requestedStartSeconds: clip.startSeconds,
        requestedEndSeconds: clip.endSeconds,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        requestedDurationSeconds: Number((clip.endSeconds - clip.startSeconds).toFixed(3)),
        renderedDurationSeconds: Number(result.durationSeconds.toFixed(3)),
        sizeBytes: result.sizeBytes,
      });
      await job.updateProgress({ stage: 'ready', percent: 100 });
    });
  } catch (error) {
    // Not a failure: the write may have landed. Marking anything failed here
    // could be untrue, and would be about a render that is playing. The
    // queue retries; the retry asks the row (earlierAttemptLanded). The
    // last attempt has no retry, so it writes the render down for the
    // footage sweep to settle once the database answers.
    if (error instanceof RenderOutcomeUnknownError) {
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      log.error('the render\'s outcome is unknown; nothing marked failed', {
        err: error.original,
        attemptsMade: job.attemptsMade,
        lastAttempt,
      });
      if (lastAttempt) {
        // With the objects nothing else would take on record, so the sweep
        // that settles this render hands them to the queue first.
        const unresolvedKeys = error.unreleasedKeys.length > 0 ? error.unreleasedKeys : job.data.unresolvedKeys;
        const record = { ...job.data, ...(unresolvedKeys?.length ? { unresolvedKeys } : {}) };
        await recordUnknownRender({ clipId, storageKey: error.storageKey, previousStorageKey: error.previousStorageKey, job: record }).catch((recordError: unknown) => {
          // The database is the thing that could not be reached; if it still
          // cannot, the log line is the only record, and says so.
          log.error('the unknown render could not be written down for the sweep; the row may stay generating until settled by hand', {
            clipId, storageKey: error.storageKey, err: recordError,
          });
        });
      }
      throw error;
    }

    const message = errorMessage(error);
    log.error('clip generation failed', { err: error });

    // A Re-clip render that has spent its last attempt rolls the WHOLE
    // re-evaluation back: the clip returns to exactly the boundaries, edit
    // mark and status the person could see, no version is recorded, and the
    // failure lands where they can read it. Intermediate attempts change
    // nothing — the retry runs with the new boundaries still in place.
    if (job.data.reclip) {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (finalAttempt) {
        const previous = job.data.reclip.previous;
        await restoreClipBoundaries(clipId, {
          startSeconds: previous.startSeconds,
          endSeconds: previous.endSeconds,
          boundariesEditedAt: previous.boundariesEditedAt ? new Date(previous.boundariesEditedAt) : null,
          status: previous.status,
        });
        await markReclipFailed(job.data.reclip.matchId, RECLIP_FAILED_MESSAGE);
      }
      throw error;
    }

    if (clip.storageKey) {
      // A re-render failed, but the clip it was replacing still exists and
      // still plays. Marking it 'failed' would delete a working clip from
      // the library and every room it was shared into — so it goes back to
      // 'ready', file, spec and all, with the failure recorded on it for
      // the editor to report.
      await setClipStatus(clipId, 'ready', { errorMessage: message });
    } else {
      await setClipStatus(clipId, 'failed', { errorMessage: message });
    }
    throw error;
  }
}
