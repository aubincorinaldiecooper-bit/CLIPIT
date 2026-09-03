import path from 'node:path';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { chunkKey, playbackProxyKey, proxyKey } from '../../services/storage/types.js';
import {
  createAnalysisProxy,
  createPlaybackProxy,
  createProxiesAndChunks,
  extractFrameAt,
  ffprobe,
  splitIntoChunks,
  type ProxySegment,
} from '../../services/media/ffmpeg.js';
import { mib, readContainerMemory } from '../../lib/containerMemory.js';
import { shouldDiscardOnUploadFailure } from '../../services/media/verticalPipeline.js';
import { getVideo, replaceChunks, setIndexStatus, setTranscriptStatus, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';
import { enqueueIndexing, enqueueTranscription, type PreprocessingJob } from '../../queues/index.js';


interface DerivedMedia {
  playbackPath: string | null;
  segments: ProxySegment[];
  /** 1 once the single pass is doing the work, 2 on the older route. */
  decodePasses: number;
  route: 'single-pass' | 'separate-passes';
  /** When the first chunk was finished and readable, from the start of decoding. */
  firstChunkReadyMs: number | null;
  lastChunkReadyMs: number | null;
}

/**
 * Notices each finished chunk while ffmpeg is still running.
 *
 * The segment muxer opens the next file at the moment it closes the current
 * one, so chunk N is complete when chunk N+1 appears — and the last one when
 * the process exits. That is what makes "time to first chunk" a real number
 * rather than the total, and it is the measurement the indexing work will be
 * judged on: today nothing downstream can start until every chunk exists.
 */
function watchChunks(chunkDir: string, startedAt: number) {
  const appeared = new Map<string, number>();
  const timer = setInterval(() => {
    readdir(chunkDir)
      .then((files) => {
        for (const file of files) {
          if (/^chunk_\d+\.mp4$/.test(file) && !appeared.has(file)) {
            appeared.set(file, performance.now() - startedAt);
          }
        }
      })
      .catch(() => undefined);
  }, 250);
  timer.unref?.();
  return {
    stop(): { firstChunkReadyMs: number | null; lastChunkReadyMs: number | null } {
      clearInterval(timer);
      const times = [...appeared.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, at]) => at);
      // The Nth file appearing is the (N-1)th finishing; the final chunk
      // finishes with the process, which the caller times.
      return {
        firstChunkReadyMs: times.length > 1 ? Math.round(times[1]!) : null,
        lastChunkReadyMs: null,
      };
    },
  };
}

/** Bytes currently held in the working directory — the temporary-disk figure. */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += (await stat(full).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir).catch(() => undefined);
  return total;
}

/**
 * Builds the analysis proxy, its chunks and the playback proxy.
 *
 * Prefers one decode of the source feeding all three. If that command fails
 * for any reason the older route runs instead, unchanged — a new ffmpeg
 * invocation on the ingestion path should not be able to cost an upload while
 * it is proving itself, and the fallback is the code that has been running in
 * production. Which route ran is logged either way.
 */
async function deriveMedia(input: {
  sourcePath: string;
  proxyPath: string;
  playbackPath: string;
  chunkDir: string;
  log: ReturnType<typeof logger.child>;
}): Promise<DerivedMedia> {
  const { sourcePath, proxyPath, playbackPath, chunkDir, log } = input;

  if (env.PREPROCESS_SINGLE_PASS) {
    const startedAt = performance.now();
    const watcher = watchChunks(chunkDir, startedAt);
    try {
      const result = await createProxiesAndChunks({ sourcePath, proxyPath, playbackPath, chunkDir });
      const timings = watcher.stop();
      return {
        playbackPath: result.playbackPath,
        segments: result.segments,
        decodePasses: 1,
        route: 'single-pass',
        firstChunkReadyMs: timings.firstChunkReadyMs,
        lastChunkReadyMs: Math.round(performance.now() - startedAt),
      };
    } catch (cause) {
      watcher.stop();
      log.warn('single decode failed; falling back to separate passes', { error: errorMessage(cause) });
      // A run that died partway may have left segments behind. The fallback
      // writes the same names from zero, so anything it does not overwrite
      // would survive and be measured as a real chunk — a piece of the video
      // that appears to have been indexed and never was.
      await rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(chunkDir, { recursive: true });
    }
  }

  const startedAt = performance.now();
  await createAnalysisProxy(sourcePath, proxyPath);
  const segments = await splitIntoChunks(proxyPath, chunkDir, env.ANALYSIS_CHUNK_SECONDS);
  const chunksAt = Math.round(performance.now() - startedAt);

  let playbackProduced: string | null = null;
  try {
    await createPlaybackProxy(sourcePath, playbackPath);
    playbackProduced = playbackPath;
  } catch (cause) {
    log.warn('could not create a playback proxy; review will use the analysis proxy', {
      error: errorMessage(cause),
    });
  }

  return {
    playbackPath: playbackProduced,
    segments,
    decodePasses: 2,
    route: 'separate-passes',
    // Nothing is readable until the whole proxy has been encoded and copied.
    firstChunkReadyMs: chunksAt,
    lastChunkReadyMs: chunksAt,
  };
}

/**
 * Probes the source, builds the analysis proxy, and cuts it into the fixed
 * analysis chunks the model will see. A multi-hour VOD is never handed to the
 * model in one piece: this is where it becomes a list of bounded segments with
 * known global start/end times.
 */
export async function handlePreprocessing(job: Job<PreprocessingJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'preprocessing', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping job');
    return;
  }
  if (!video.originalStorageKey) {
    await setVideoStatus(videoId, 'failed', 'No source file to preprocess');
    return;
  }

  await setVideoStatus(videoId, 'preprocessing');
  await job.updateProgress({ stage: 'preprocessing', percent: 35 });

  try {
    const storage = getStorage();

    await withWorkDir(`preprocess-${videoId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await storage.downloadToFile(video.originalStorageKey!, sourcePath);

      // 1. Probe the source and persist its real metadata.
      const probe = await ffprobe(sourcePath);
      if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
        throw new Error('Could not determine source duration — the file may be corrupt or not a video');
      }
      if (probe.durationSeconds > env.MAX_SOURCE_DURATION_SECONDS) {
        throw new Error(
          `Video is ${Math.round(probe.durationSeconds)}s long, which exceeds the ${env.MAX_SOURCE_DURATION_SECONDS}s limit`,
        );
      }

      await updateVideoMedia(videoId, {
        durationSeconds: Number(probe.durationSeconds.toFixed(3)),
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes,
        metadata: {
          ...video.metadata,
          formatName: probe.formatName,
          bitRate: probe.bitRate,
        },
      });

      log.info('source probed', {
        durationSeconds: probe.durationSeconds,
        resolution: `${probe.width}x${probe.height}`,
        hasAudio: probe.hasAudio,
      });
      await job.updateProgress({ stage: 'probed', percent: 40 });

      // 2. Derive the analysis proxy, its chunks and the playback proxy.
      //
      // One decode of the source feeds all three. Before this, the original
      // was decoded once for the analysis proxy and again for the playback
      // proxy, then copied a third time into chunks — on a 4K master that is
      // the most expensive thing preprocessing does, paid twice.
      const proxyPath = path.join(dir, 'proxy.mp4');
      const playbackFilePath = path.join(dir, 'playback.mp4');
      const chunkDir = path.join(dir, 'chunks');
      await mkdir(chunkDir, { recursive: true });

      const memoryBefore = await readContainerMemory();
      const derivedStartedAt = performance.now();
      const derived = await deriveMedia({
        sourcePath,
        proxyPath,
        playbackPath: playbackFilePath,
        chunkDir,
        log,
      });
      const derivedMs = Math.round(performance.now() - derivedStartedAt);
      const memoryAfter = await readContainerMemory();
      const tempDiskBytes = await dirBytes(dir);

      // The measurement the 4K memory question turns on. A container's memory
      // figure counts file cache alongside real allocations, so `anon` is what
      // this job actually held and `file` is cache the kernel will drop under
      // pressure. One is a cost, the other is bookkeeping, and a graph cannot
      // tell them apart.
      log.info('source decoded', {
        route: derived.route,
        decodePasses: derived.decodePasses,
        elapsedMs: derivedMs,
        firstChunkReadyMs: derived.firstChunkReadyMs,
        lastChunkReadyMs: derived.lastChunkReadyMs,
        chunks: derived.segments.length,
        playbackProduced: derived.playbackPath !== null,
        tempDiskMb: Math.round(tempDiskBytes / 1_000_000),
        memorySource: memoryAfter.source,
        anonMbBefore: mib(memoryBefore.anonBytes),
        anonMbAfter: mib(memoryAfter.anonBytes),
        fileCacheMbBefore: mib(memoryBefore.fileBytes),
        fileCacheMbAfter: mib(memoryAfter.fileBytes),
        containerPeakMb: mib(memoryAfter.peakBytes),
      });

      const proxyStorageKey = proxyKey(videoId);
      await storage.uploadFile(proxyStorageKey, proxyPath, 'video/mp4');
      await updateVideoMedia(videoId, { proxyStorageKey });

      log.info('analysis proxy created', { proxyStorageKey });

      // The proxy a person watches — and the one candidate thumbnails are cut
      // from. Best-effort: analysis does not depend on it, so a failure here
      // costs review quality, never the ingestion. Both fall back to the
      // analysis proxy when this key is null.
      // Retention finds objects through the keys on rows. An object that was
      // uploaded but whose key never reached the row is invisible to every
      // sweep, so a failure between the upload and the write removes what
      // was uploaded — best-effort, logged with the key either way.
      //
      // But only what THIS attempt introduced. The key is deterministic, so
      // a re-run overwrites a proxy the row may already name; deleting that
      // on a failed write would leave the row pointing at nothing. The same
      // ownership rule the clip media learned (shouldDiscardOnUploadFailure):
      // what the row said when the attempt began, and what it says at the
      // moment of failure, decide whether the object is ours to remove.
      if (derived.playbackPath) {
        const snapshotPlaybackKey = video.playbackStorageKey;
        let uploadedPlaybackKey: string | null = null;
        try {
          const playbackStorageKey = playbackProxyKey(videoId);
          await storage.uploadFile(playbackStorageKey, derived.playbackPath, 'video/mp4');
          uploadedPlaybackKey = playbackStorageKey;
          await updateVideoMedia(videoId, { playbackStorageKey });
          uploadedPlaybackKey = null;
          log.info('playback proxy stored', { playbackStorageKey });
        } catch (cause) {
          log.warn('could not store the playback proxy; review will use the analysis proxy', {
            error: errorMessage(cause),
          });
          if (uploadedPlaybackKey) {
            let currentKey: string | null | undefined;
            let readFailed = false;
            try {
              currentKey = (await getVideo(videoId))?.playbackStorageKey ?? null;
            } catch {
              readFailed = true;
            }
            const ours = shouldDiscardOnUploadFailure({
              key: uploadedPlaybackKey,
              snapshotKey: snapshotPlaybackKey,
              currentKey,
              readFailed,
            });
            if (!ours) {
              log.warn('playback proxy re-uploaded over one the row already names; keeping it', {
                videoId,
                key: uploadedPlaybackKey,
              });
            } else {
              try {
                await storage.remove(uploadedPlaybackKey);
              } catch (removeCause) {
                log.error('playback proxy uploaded but its key was not saved, and it could not be removed; it is now an orphan', {
                  videoId,
                  key: uploadedPlaybackKey,
                  error: errorMessage(removeCause),
                });
              }
            }
          }
        }
      }

      // A poster frame for the video itself, so the library shows the footage
      // rather than a filename. Pulled from the proxy that is already on disk
      // — one extra seek, no second download — and best-effort by design: a
      // missing picture must never cost an ingestion. Taken a little way in,
      // because the first frame of a video is very often black.
      try {
        const posterPath = path.join(dir, 'poster.jpg');
        const at = Math.min(3, Math.max(0, (probe.durationSeconds ?? 0) / 2));
        if (await extractFrameAt(proxyPath, at, posterPath, 640)) {
          const posterStorageKey = `posters/${videoId}.jpg`;
          await storage.uploadFile(posterStorageKey, posterPath, 'image/jpeg');
          await updateVideoMedia(videoId, { posterStorageKey });
          log.info('poster frame captured', { posterStorageKey });
        }
      } catch (cause) {
        log.warn('could not capture a poster frame', { error: errorMessage(cause) });
      }

      await job.updateProgress({ stage: 'proxy_created', percent: 60 });

      // 3. Place the chunks produced above on the source timeline.
      const segments = derived.segments;

      if (segments.length === 0) {
        throw new Error('Splitting the proxy produced no analysis chunks');
      }

      const uploaded: Parameters<typeof replaceChunks>[1] = [];
      for (const segment of segments) {
        // The proxy can run marginally longer than the original (frame duration
        // at the tail), so the grid is clamped to the source. Without this a
        // match in the last chunk could carry a timestamp past the end of the
        // video the clip is cut from.
        const globalEndSeconds = Math.min(segment.globalEndSeconds, probe.durationSeconds);
        if (globalEndSeconds - segment.globalStartSeconds <= 0.001) {
          log.warn('dropping chunk that starts past the end of the source', { chunkIndex: segment.index });
          continue;
        }

        const key = chunkKey(videoId, segment.index);
        await storage.uploadFile(key, segment.filePath, 'video/mp4');
        uploaded.push({
          chunkIndex: segment.index,
          globalStartSeconds: segment.globalStartSeconds,
          globalEndSeconds: Number(globalEndSeconds.toFixed(3)),
          durationSeconds: Number((globalEndSeconds - segment.globalStartSeconds).toFixed(3)),
          storageKey: key,
        });
        await job.updateProgress({
          stage: 'chunking',
          percent: 60 + Math.round((30 * (segment.index + 1)) / segments.length),
          chunksUploaded: segment.index + 1,
          chunksTotal: segments.length,
        });
      }

      await replaceChunks(videoId, uploaded);
      await updateVideoMedia(videoId, {
        chunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        chunkCount: uploaded.length,
      });

      log.info('analysis chunks created', {
        count: uploaded.length,
        chunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        lastChunkEnd: uploaded.at(-1)?.globalEndSeconds,
      });

      // 4. The video can now be searched.
      await setVideoStatus(videoId, 'ready');
      await job.updateProgress({ stage: 'ready', percent: 100 });

      // 5. Transcription runs after the video is searchable, so a spoken-word
      //    search waits only for the transcript, not for the whole pipeline.
      if (!env.TRANSCRIPTION_ENABLED) {
        await setTranscriptStatus(videoId, 'unavailable', { error: 'Transcription is disabled' });
      } else if (!probe.hasAudio) {
        await setTranscriptStatus(videoId, 'unavailable', { error: 'Source has no audio track' });
      } else {
        // Both follow-ups run AFTER the video is already searchable, so a queue
        // that is momentarily unreachable must not reach the catch below and
        // mark a fully processed video failed. Each records its own failure and
        // leaves the video exactly as usable as it already is.
        try {
          await setTranscriptStatus(videoId, 'queued');
          await enqueueTranscription({ videoId, captionsStorageKey: video.captionsStorageKey });
        } catch (error) {
          log.error('could not queue transcription', { err: error });
          await setTranscriptStatus(videoId, 'failed', {
            error: `Could not queue transcription: ${errorMessage(error)}`,
          });
        }
      }

      // 6. Read the video into notes, once, so questions can be answered from
      //    text instead of re-reading the whole video every time one is asked.
      //    Queued after the video is already searchable, so indexing never
      //    delays the first question — it only makes the later ones cheap.
      if (!env.INDEXING_ENABLED) {
        await setIndexStatus(videoId, 'unavailable', { error: 'Indexing is disabled' });
      } else {
        try {
          await setIndexStatus(videoId, 'queued');
          await enqueueIndexing({ videoId });
        } catch (error) {
          // The video stays searchable; questions simply read the footage
          // until something queues this again.
          log.error('could not queue indexing', { err: error });
          await setIndexStatus(videoId, 'failed', {
            error: `Could not queue indexing: ${errorMessage(error)}`,
          });
        }
      }
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('preprocessing failed', { err: error });
    await setVideoStatus(videoId, 'failed', message);
    throw error;
  }
}
