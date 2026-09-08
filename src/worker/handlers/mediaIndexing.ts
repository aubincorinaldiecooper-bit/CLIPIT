import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from '../../services/storage/s3.js';
import { getVideo } from '../../db/repositories/videos.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import {
  beginIndexRun,
  setMediaIndexStatus,
  storeIndexedWindows,
  type WindowProvenance,
} from '../../db/repositories/mediaIndex.js';
import { packVector } from '../../services/mediaIndex/vectors.js';
import { coveredThroughSeconds, unreadRanges } from '../../services/mediaIndex/coverage.js';
import { estimateGpuCostUsd, gpuMsFrom } from '../../services/mediaIndex/cost.js';
import { DEFAULT_WINDOW_PLAN, planWindows, windowKey, type IndexWindow } from '../../services/mediaIndex/windows.js';
import { embedVideoIntervals } from '../../services/mediaIndex/qwen.js';
import { sourceIdentity } from '../../services/mediaIndex/sourceIdentity.js';
import type { MediaIndexingJob } from '../../queues/index.js';

/**
 * Reading a video into vectors, once, at upload.
 *
 * The notes taken by the scene indexer are a model's summary of what it
 * thought worth writing down. This is the other kind of memory: overlapping
 * stretches of the timeline, each carrying a vector of what the pictures in
 * it actually look like. A typed question can be compared against those
 * without watching the video again, and — unlike the notes — their silence
 * about a thing is not evidence the thing is absent, only that this stretch
 * did not look like the question.
 *
 * Three promises this handler keeps, in order of how badly breaking them
 * would hurt:
 *
 * It never claims to have read footage it did not read. Coverage is the
 * contiguous prefix of stored windows, failures are counted rather than
 * rounded away, and the stretches nobody looked at are named.
 *
 * It never mixes vectors from two runs. The provenance of the first batch
 * becomes the run's identity; a later batch reporting different weights ends
 * the run rather than storing a vector that is not comparable with the rest.
 *
 * It never indexes a video that has been replaced underneath it. The proxy
 * key is mutable — re-processing overwrites the same object — so the source's
 * content tag is read before and after, and a change voids the whole run.
 */

const log = logger.child({ handler: 'media-indexing' });

/** How the run identifies itself and its rows. */
function provenanceOf(
  reply: { model: string; revision: string; dims: number },
  sourceIdentity: string,
): WindowProvenance {
  return {
    model: reply.model,
    revision: reply.revision,
    dims: reply.dims,
    indexVersion: env.MEDIA_INDEX_VERSION,
    sourceIdentity,
  };
}

function samePlace(a: WindowProvenance, b: WindowProvenance): boolean {
  return (
    a.model === b.model &&
    a.revision === b.revision &&
    a.dims === b.dims &&
    a.indexVersion === b.indexVersion &&
    a.sourceIdentity === b.sourceIdentity
  );
}

export async function handleMediaIndexing(job: Job<MediaIndexingJob>): Promise<void> {
  const { videoId } = job.data;
  const started = Date.now();

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('no such video; nothing to index', { videoId });
    return;
  }
  // Footage already removed, or being removed. Indexing it would recreate a
  // description of bytes that are going away, and retention has already run
  // its delete — so the row would outlive the video it describes.
  if (video.footageExpiredAt) {
    await setMediaIndexStatus(videoId, 'unavailable', {
      error: 'the footage was removed before indexing began',
      ifState: ['queued'],
    });
    return;
  }
  if (!video.proxyStorageKey || !video.durationSeconds) {
    await setMediaIndexStatus(videoId, 'unavailable', {
      error: !video.proxyStorageKey ? 'no analysis proxy to read' : 'the video has no known duration',
      ifState: ['queued'],
    });
    return;
  }

  const plan = {
    windowSeconds: env.MEDIA_INDEX_WINDOW_SECONDS,
    strideSeconds: env.MEDIA_INDEX_STRIDE_SECONDS,
    minWindowSeconds: env.MEDIA_INDEX_MIN_WINDOW_SECONDS,
  };
  const planned = planWindows(video.durationSeconds, plan.windowSeconds ? plan : DEFAULT_WINDOW_PLAN);
  if (planned.length === 0) {
    await setMediaIndexStatus(videoId, 'unavailable', {
      error: 'the video is too short to plan a single window',
      ifState: ['queued'],
    });
    return;
  }

  const proxyKey = video.proxyStorageKey;
  const stored = new Set<string>();
  const failures: Array<{ id: string; reason: string }> = [];
  let provenance: WindowProvenance | null = null;
  let runStartedAt: Date | null = null;

  try {
    // Read before the first signed URL is minted. The identity carries the
    // store's tag for the CONTENT, so it changes when the bytes change.
    const source = await sourceIdentity(proxyKey);
    const batchSize = env.MEDIA_INDEX_BATCH_WINDOWS;

    for (let offset = 0; offset < planned.length; offset += batchSize) {
      // Windows already stored under this exact identity are not embedded
      // again. That is what makes a resumed run cheap rather than merely
      // correct: an attempt that died at minute forty picks up where it
      // stopped instead of paying for the whole video a second time. The
      // first batch always runs, because the run's identity is not known
      // until something answers.
      const batch = planned.slice(offset, offset + batchSize).filter((window) => !stored.has(windowKey(window)));
      if (batch.length === 0) continue;
      // Re-signed per batch so a long run cannot expire halfway through.
      const videoUrl = await getStorage().createDownloadUrl(proxyKey, {
        expiresInSeconds: env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS,
      });
      const batchStarted = Date.now();
      const reply = await embedVideoIntervals({
        videoUrl,
        videoKey: source.identity,
        expectedBytes: source.sizeBytes,
        // The proxy IS the source timeline, so window seconds need no rebasing.
        intervals: batch.map((window) => ({
          id: windowKey(window),
          start: window.startSeconds,
          end: window.endSeconds,
        })),
      });

      const here = provenanceOf(reply, source.identity);
      if (provenance === null) {
        provenance = here;
        // Opens the run and clears anything stored under other weights, so a
        // video never carries a dead copy of itself. Rows matching this exact
        // provenance survive, which is what makes a resumed run cheap.
        const opened = await beginIndexRun(videoId, provenance);
        runStartedAt = opened.runStartedAt;
        if (opened.cleared > 0) {
          log.info('cleared windows that describe other weights or other footage', {
            videoId, cleared: opened.cleared, ...provenance,
          });
        }
        // Windows already paid for under this exact identity. Counted towards
        // coverage from the start, or a retry would report a video as unread
        // when most of it is stored — and then re-embed all of it.
        for (const key of opened.retained) stored.add(key);
        if (opened.retained.length > 0) {
          log.info('resuming an earlier run', { videoId, retained: opened.retained.length });
        }
        await setMediaIndexStatus(videoId, 'running', {
          windowsPlanned: planned.length,
          windowsStored: stored.size,
          coveredThroughSeconds: coveredThroughSeconds(planned, stored, windowKey),
          ifRunStartedAt: opened.runStartedAt,
        });
      } else if (!samePlace(provenance, here)) {
        // Mid-run the service began answering from different weights. Vectors
        // from two sets of weights are no more comparable than vectors from
        // two models, and there is no way to tell them apart afterwards.
        throw new Error(
          `the embedding service changed identity mid-run (${provenance.model}@${provenance.revision}/${provenance.dims} ` +
            `→ ${here.model}@${here.revision}/${here.dims}); the vectors already stored are not comparable with the rest`,
        );
      }

      const byKey = new Map(batch.map((window) => [windowKey(window), window]));
      const rows = reply.embedded.flatMap((row) => {
        const window = byKey.get(row.id);
        // An id nobody asked for. The client already rejects unknown ids, so
        // this is belt and braces; it is dropped and counted rather than
        // stored against a window it might not describe.
        if (!window) {
          failures.push({ id: row.id, reason: 'the service answered about a window that was not asked for' });
          return [];
        }
        return [{
          windowKey: row.id,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          embedding: Array.from(row.embedding),
        }];
      });

      if (rows.length > 0) {
        // provenance and runStartedAt are set together when the run opens,
        // which happens on the first batch — before any row can be stored.
        if (!runStartedAt) throw new Error('windows were ready before the run was opened');
        const written = await storeIndexedWindows(videoId, rows, provenance, packVector, runStartedAt);
        // Nothing stored means this attempt has been superseded, or the
        // footage was claimed for deletion. Either way it must not go on
        // counting windows it did not write: an obsolete run that keeps
        // tallying would report coverage the index does not have.
        if (written === 0) {
          log.info('this indexing attempt is no longer the current one; stopping', { videoId });
          return;
        }
        for (const row of rows) stored.add(row.windowKey);
      }
      failures.push(...reply.failed);

      // Priced from the time the GPU was actually held, not wall clock: the
      // caller's clock includes queueing and transfer, which nobody bills for.
      const gpuMs = gpuMsFrom([reply.metrics]);
      await recordModelUsage({
        videoId,
        provider: 'modal',
        model: reply.model,
        stage: 'embedding',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: estimateGpuCostUsd(gpuMs),
        latencyMs: Date.now() - batchStarted,
        metrics: {
          windows: batch.length,
          embedded: rows.length,
          failed: reply.failed.length,
          gpuMs,
          ...reply.metrics,
        },
        startedAt: new Date(batchStarted),
      });

      // Written after every batch, not at the end, so a question asked while
      // a long video is still being read can be answered from the part that
      // has been read — with the unread part named.
      await setMediaIndexStatus(videoId, 'running', {
        windowsStored: stored.size,
        windowsFailed: failures.length,
        coveredThroughSeconds: coveredThroughSeconds(planned, stored, windowKey),
        ifRunStartedAt: runStartedAt ?? undefined,
      });
    }

    // The proxy key is mutable and re-processing overwrites it. If the bytes
    // moved while this ran, some vectors describe one version of the video
    // and some another, and nothing here can tell which is which — so none of
    // them are believed.
    const after = await sourceIdentity(proxyKey);
    if (after.identity !== source.identity) {
      // Recorded as unavailable with no coverage, NOT as a failure with a
      // usable prefix. A failed run's prefix is searchable on purpose — those
      // windows were read correctly, just not all of them. These were read
      // from footage that has since been replaced, so every one of them
      // describes a video that is gone. The next run clears them, because
      // its source identity will not match.
      await setMediaIndexStatus(videoId, 'unavailable', {
        windowsStored: stored.size,
        windowsFailed: failures.length,
        coveredThroughSeconds: 0,
        finishedAt: new Date(),
        error: 'the analysis proxy was replaced while it was being indexed; these vectors describe two different videos',
        ...(runStartedAt ? { ifRunStartedAt: runStartedAt } : { ifState: ['queued'] as const }),
      }).catch(() => undefined);
      log.warn('the footage was replaced mid-index; none of these vectors are believed', { videoId });
      return;
    }

    const unread = unreadRanges(planned, stored, windowKey);
    const covered = coveredThroughSeconds(planned, stored, windowKey);
    await setMediaIndexStatus(videoId, unread.length === 0 ? 'ready' : 'partial', {
      windowsPlanned: planned.length,
      windowsStored: stored.size,
      windowsFailed: failures.length,
      coveredThroughSeconds: covered,
      finishedAt: new Date(),
      // A resume that found every window already stored never opens a run and
      // so has no identity to be fenced on; it may then only report over a
      // still-`queued` row, never over a newer attempt.
      ...(runStartedAt ? { ifRunStartedAt: runStartedAt } : { ifState: ['queued'] as const }),
      error: unread.length === 0
        ? null
        : `${unread.length} stretch(es) were not read: ${unread
            .slice(0, 5)
            .map((gap) => `${gap.startSeconds.toFixed(1)}–${gap.endSeconds.toFixed(1)}s`)
            .join(', ')}${unread.length > 5 ? ', …' : ''}`,
    });

    log.info('media index written', {
      videoId,
      planned: planned.length,
      stored: stored.size,
      failed: failures.length,
      coveredThroughSeconds: covered,
      ms: Date.now() - started,
    });
  } catch (error) {
    const message = errorMessage(error);
    // Whatever was stored before the failure stays stored and stays honest:
    // coverage still says how far the unbroken read got, so a question about
    // the early part of the video can still be answered from it.
    await setMediaIndexStatus(videoId, 'failed', {
      windowsPlanned: planned.length,
      windowsStored: stored.size,
      windowsFailed: failures.length,
      coveredThroughSeconds: coveredThroughSeconds(planned, stored, windowKey),
      finishedAt: new Date(),
      // Fenced on this run when it got as far as opening one. If it did not,
      // it never owned this row: it may only report over a `queued` state,
      // so a delivery that died early cannot stamp `failed` over a newer
      // attempt that has since opened or even finished — which would send
      // every later question to the slow path for a video that is indexed.
      ...(runStartedAt ? { ifRunStartedAt: runStartedAt } : { ifState: ['queued'] as const }),
      error: message,
    }).catch(() => undefined);
    log.error('media index failed', { videoId, err: error, stored: stored.size });
    throw error;
  }
}
