import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { extractAudioSegments } from '../../services/media/ffmpeg.js';
import { parseVttToSegments } from '../../services/transcription/vtt.js';
import { transcribeAudioFile } from '../../services/transcription/openrouter.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { getVideo, setTranscriptStatus } from '../../db/repositories/videos.js';
import { replaceTranscript, type NewTranscriptSegment } from '../../db/repositories/transcripts.js';
import type { TranscriptSource } from '../../domain/types.js';
import type { TranscriptionJob } from '../../queues/index.js';

/**
 * Produces one timestamped transcript per video.
 *
 * Audio is extracted ONCE from the full source and transcribed as a single
 * pass; the analysis chunk grid is never used as the transcription unit. The
 * audio is split only to satisfy the transcription API's request-size limit,
 * and each piece's offset is added back so all stored timestamps are global.
 *
 * For YouTube sources, creator or automatic captions downloaded by yt-dlp are
 * used when present, and OpenRouter STT is the fallback.
 */
/** Shortest span a stored segment may occupy, so it can still be matched. */
const MIN_SEGMENT_SECONDS = 0.5;

export async function handleTranscription(job: Job<TranscriptionJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'transcription', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping job');
    return;
  }

  if (!env.TRANSCRIPTION_ENABLED) {
    await setTranscriptStatus(videoId, 'unavailable', { error: 'Transcription is disabled' });
    return;
  }

  await setTranscriptStatus(videoId, 'running');
  await job.updateProgress({ stage: 'transcribing', percent: 5 });

  try {
    const captionsKey = job.data.captionsStorageKey ?? video.captionsStorageKey;

    if (env.YOUTUBE_PREFER_CAPTIONS && captionsKey) {
      const segments = await transcribeFromCaptions(captionsKey);
      if (segments.length > 0) {
        await store(videoId, segments, 'youtube_captions');
        log.info('transcript built from captions', { segments: segments.length });
        await job.updateProgress({ stage: 'done', percent: 100, source: 'youtube_captions' });
        return;
      }
      log.warn('caption file produced no usable segments, falling back to speech-to-text');
    }

    if (!video.originalStorageKey) throw new Error('No source file available to transcribe');

    const segments = await transcribeWithStt(job, videoId, video.originalStorageKey);
    if (segments.length === 0) {
      await setTranscriptStatus(videoId, 'unavailable', {
        error: 'No speech detected in the source',
        segmentCount: 0,
      });
      log.info('no speech detected');
      return;
    }

    await store(videoId, segments, 'openrouter_stt');
    log.info('transcript built with speech-to-text', { segments: segments.length });
    await job.updateProgress({ stage: 'done', percent: 100, source: 'openrouter_stt' });
  } catch (error) {
    const message = errorMessage(error);
    log.error('transcription failed', { err: error });
    // A failed transcript degrades search to visual-only; it never fails the video.
    await setTranscriptStatus(videoId, 'failed', { error: message });
    throw error;
  }
}

async function store(videoId: string, segments: NewTranscriptSegment[], source: TranscriptSource): Promise<void> {
  const count = await replaceTranscript(videoId, segments, source);
  await setTranscriptStatus(videoId, 'ready', { source, segmentCount: count });
}

async function transcribeFromCaptions(captionsKey: string): Promise<NewTranscriptSegment[]> {
  return withWorkDir('captions', async (dir) => {
    const filePath = path.join(dir, 'captions.vtt');
    await getStorage().downloadToFile(captionsKey, filePath);
    const content = await readFile(filePath, 'utf8');

    return parseVttToSegments(content).map((cue) => ({
      startSeconds: Number(cue.startSeconds.toFixed(3)),
      endSeconds: Number(cue.endSeconds.toFixed(3)),
      text: cue.text,
    }));
  });
}

async function transcribeWithStt(
  job: Job<TranscriptionJob>,
  videoId: string,
  originalStorageKey: string,
): Promise<NewTranscriptSegment[]> {
  return withWorkDir(`transcribe-${videoId}`, async (dir) => {
    const sourcePath = path.join(dir, `source${path.extname(originalStorageKey) || '.mp4'}`);
    await getStorage().downloadToFile(originalStorageKey, sourcePath);

    // One extraction pass over the whole source.
    const audioSegments = await extractAudioSegments(sourcePath, dir, env.TRANSCRIBE_SEGMENT_SECONDS);
    if (audioSegments.length === 0) return [];

    const collected: NewTranscriptSegment[] = [];

    // Sequential over pieces; the OpenRouter client caps real concurrency itself.
    for (const [index, audio] of audioSegments.entries()) {
      const transcribed = await transcribeAudioFile(audio.filePath, (usage) => {
        void recordModelUsage({ ...usage, stage: 'transcription', videoId, clipRequestId: null });
      });

      // A model that ignores the verbose-json contract returns flat text with
      // no timings, which the client surfaces as a single [0, 0] segment.
      const isUntimed =
        transcribed.length === 1 && transcribed[0]!.startSeconds === 0 && transcribed[0]!.endSeconds === 0;

      for (const segment of transcribed) {
        const start = audio.globalStartSeconds + segment.startSeconds;
        let end = audio.globalStartSeconds + Math.max(segment.endSeconds, segment.startSeconds);

        if (isUntimed) {
          // Span the audio piece it came from: a zero-length segment matches no
          // chunk range query, so the words would be stored but never searched.
          end = audio.globalStartSeconds + audio.durationSeconds;
        } else if (end - start < MIN_SEGMENT_SECONDS) {
          end = start + MIN_SEGMENT_SECONDS;
        }

        collected.push({
          startSeconds: Number(start.toFixed(3)),
          endSeconds: Number(end.toFixed(3)),
          text: segment.text,
        });
      }

      await job.updateProgress({
        stage: 'transcribing',
        percent: Math.round((100 * (index + 1)) / audioSegments.length),
        segmentsDone: index + 1,
        segmentsTotal: audioSegments.length,
      });
    }

    collected.sort((a, b) => a.startSeconds - b.startSeconds);
    return collected;
  });
}
