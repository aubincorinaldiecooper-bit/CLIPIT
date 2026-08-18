import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';
import { planFrameTimestamps } from '../timestamps.js';

export interface ProbeResult {
  durationSeconds: number;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  bitRate: number | null;
  formatName: string | null;
  raw: Record<string, unknown>;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; size?: string; bit_rate?: string; format_name?: string; tags?: Record<string, string> };
}

function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [numerator, denominator] = value.split('/');
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null;
  const fps = top / bottom;
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(4)) : null;
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(
    env.FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 120_000 },
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const duration = toNumber(parsed.format?.duration) ?? toNumber(video?.duration) ?? 0;

  return {
    durationSeconds: duration,
    sizeBytes: toNumber(parsed.format?.size),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitRate: toNumber(parsed.format?.bit_rate),
    formatName: parsed.format?.format_name ?? null,
    raw: parsed as unknown as Record<string, unknown>,
  };
}

/**
 * Builds the low-resolution, low-framerate copy used for analysis. The original
 * is never sent to the model, and clip cutting always goes back to the original.
 *
 * Keyframes are forced at every chunk boundary. The segment muxer can only cut
 * on a keyframe, and at this framerate the default GOP is far longer than a
 * chunk — without this the "split" silently returns one segment containing the
 * entire video, which would send a multi-hour VOD to the model in one request.
 */
export async function createAnalysisProxy(
  inputPath: string,
  outputPath: string,
  chunkSeconds: number = env.ANALYSIS_CHUNK_SECONDS,
): Promise<void> {
  const gopFrames = Math.max(1, Math.round(chunkSeconds * env.PROXY_FPS));

  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vf', `scale=-2:${env.PROXY_HEIGHT}:flags=bicubic`,
      '-r', String(env.PROXY_FPS),
      '-c:v', 'libx264',
      '-preset', env.PROXY_PRESET,
      '-crf', String(env.PROXY_CRF),
      '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${chunkSeconds})`,
      '-g', String(gopFrames),
      '-keyint_min', String(gopFrames),
      '-sc_threshold', '0',
      '-an',
      '-movflags', '+faststart',
      outputPath,
    ],
    { timeoutMs: 6 * 60 * 60 * 1000 },
  );
}

export interface ProxySegment {
  index: number;
  filePath: string;
  durationSeconds: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
}

/**
 * Splits the proxy into fixed-length analysis chunks. Boundaries are read back
 * from the produced files rather than assumed, because the segment muxer only
 * cuts on keyframes — so a chunk's real duration can drift from the target.
 */
export async function splitIntoChunks(
  proxyPath: string,
  outputDir: string,
  chunkSeconds: number,
): Promise<ProxySegment[]> {
  const pattern = path.join(outputDir, 'chunk_%04d.mp4');

  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', proxyPath,
      '-c', 'copy',
      '-map', '0',
      '-f', 'segment',
      '-segment_time', String(chunkSeconds),
      '-reset_timestamps', '1',
      '-segment_format_options', 'movflags=+faststart',
      pattern,
    ],
    { timeoutMs: 2 * 60 * 60 * 1000 },
  );

  const files = (await readdir(outputDir))
    .filter((file) => /^chunk_\d+\.mp4$/.test(file))
    .sort();

  const segments: ProxySegment[] = [];
  let cursor = 0;

  for (const [index, file] of files.entries()) {
    const filePath = path.join(outputDir, file);
    const probe = await ffprobe(filePath);
    const duration = probe.durationSeconds;

    if (!Number.isFinite(duration) || duration <= 0) {
      logger.warn('skipping zero-length chunk', { file });
      continue;
    }

    segments.push({
      index,
      filePath,
      durationSeconds: Number(duration.toFixed(3)),
      globalStartSeconds: Number(cursor.toFixed(3)),
      globalEndSeconds: Number((cursor + duration).toFixed(3)),
    });
    cursor += duration;
  }

  // Guard against a silent regression in keyframe placement: an oversized
  // segment means the muxer had nowhere to cut, and the model would receive far
  // more than one chunk's worth of video in a single request.
  const oversized = segments.find((segment) => segment.durationSeconds > chunkSeconds * 1.5);
  if (oversized) {
    throw new Error(
      `Chunking produced a ${Math.round(oversized.durationSeconds)}s segment for a ${chunkSeconds}s target — ` +
        'the proxy has no keyframe at the chunk boundary',
    );
  }

  return segments;
}

export interface ExtractedFrame {
  /** Seconds from the start of the file the frame was taken from. */
  localSeconds: number;
  filePath: string;
}

/**
 * Samples evenly spaced frames from a chunk in ONE ffmpeg pass.
 *
 * The previous implementation spawned a separate ffmpeg per frame; at 128
 * frames × 2 concurrent chunks that was a 256-process storm which exhausted
 * the container's threads (`ff_frame_thread_encoder_init failed`) and got
 * individual extractions SIGKILLed at their timeout. One decode of the
 * low-fps proxy writing every frame is drastically cheaper and cannot storm.
 *
 * Sampling matches planFrameTimestamps: seeking to step/2 and emitting at
 * 1/step fps lands each frame at the centre of its slice, `(i + 0.5) * step`.
 */
export async function extractFrames(
  inputPath: string,
  durationSeconds: number,
  frameCount: number,
  outputDir: string,
): Promise<ExtractedFrame[]> {
  const timestamps = planFrameTimestamps(durationSeconds, frameCount);
  if (timestamps.length === 0) return [];

  const step = durationSeconds / timestamps.length;
  const pattern = path.join(outputDir, 'frame_%04d.jpg');

  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', (step / 2).toFixed(3),
      '-i', inputPath,
      '-vf', `fps=${(1 / step).toFixed(6)},scale='min(${env.MINICPM_FRAME_MAX_WIDTH},iw)':-2`,
      '-frames:v', String(timestamps.length),
      '-q:v', String(env.MINICPM_FRAME_JPEG_QUALITY),
      pattern,
    ],
    // One pass over a whole chunk, so the budget scales with the chunk rather
    // than with a single frame.
    { timeoutMs: 10 * 60 * 1000 },
  );

  // A source that runs slightly short writes fewer frames than planned; report
  // only frames that verifiably exist so a missing file can never be uploaded.
  const frames: ExtractedFrame[] = [];
  for (const [index, seconds] of timestamps.entries()) {
    // ffmpeg's image2 muxer numbers output from 1.
    const filePath = path.join(outputDir, `frame_${String(index + 1).padStart(4, '0')}.jpg`);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size === 0) {
      logger.warn('frame extraction failed', { index, seconds, err: 'no frame was written' });
      continue;
    }
    frames.push({ localSeconds: seconds, filePath });
  }

  return frames;
}

/**
 * Samples frames from ONE window of a file, for verifying a candidate moment
 * against what is actually on screen there. Same single-pass, slice-centre
 * sampling as extractFrames, scoped to [startSeconds, endSeconds].
 */
export async function extractWindowFrames(
  inputPath: string,
  startSeconds: number,
  endSeconds: number,
  frameCount: number,
  outputDir: string,
): Promise<ExtractedFrame[]> {
  const window = endSeconds - startSeconds;
  if (!(window > 0) || frameCount < 1) return [];

  const count = Math.max(1, Math.floor(frameCount));
  const step = window / count;
  const pattern = path.join(outputDir, 'vframe_%04d.jpg');

  // ffmpeg does not create output directories; without this every extraction
  // into a fresh directory fails, and a lenient caller can mask that.
  await mkdir(outputDir, { recursive: true });

  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', (startSeconds + step / 2).toFixed(3),
      '-i', inputPath,
      '-vf', `fps=${(1 / step).toFixed(6)},scale='min(${env.MINICPM_FRAME_MAX_WIDTH},iw)':-2`,
      '-frames:v', String(count),
      '-q:v', String(env.MINICPM_FRAME_JPEG_QUALITY),
      pattern,
    ],
    { timeoutMs: 5 * 60 * 1000 },
  );

  const frames: ExtractedFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const seconds = startSeconds + step / 2 + index * step;
    const filePath = path.join(outputDir, `vframe_${String(index + 1).padStart(4, '0')}.jpg`);
    const info = await stat(filePath).catch(() => null);
    if (!info || info.size === 0) continue;
    frames.push({ localSeconds: Number(seconds.toFixed(3)), filePath });
  }

  return frames;
}

/**
 * Extracts the full audio track once, as mono 16 kHz — the format Whisper wants
 * — then splits it into upload-sized pieces. The split exists only to respect
 * the transcription API's request-size limit; it is unrelated to the analysis
 * chunk grid.
 */
export interface AudioSegment {
  index: number;
  filePath: string;
  globalStartSeconds: number;
  durationSeconds: number;
}

export async function extractAudioSegments(
  inputPath: string,
  outputDir: string,
  segmentSeconds: number,
): Promise<AudioSegment[]> {
  const pattern = path.join(outputDir, 'audio_%04d.mp3');

  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', env.TRANSCRIBE_AUDIO_BITRATE,
      '-f', 'segment',
      '-segment_time', String(segmentSeconds),
      '-reset_timestamps', '1',
      pattern,
    ],
    { timeoutMs: 6 * 60 * 60 * 1000 },
  );

  const files = (await readdir(outputDir))
    .filter((file) => /^audio_\d+\.mp3$/.test(file))
    .sort();

  const segments: AudioSegment[] = [];

  for (const [index, file] of files.entries()) {
    const filePath = path.join(outputDir, file);
    const probe = await ffprobe(filePath);
    const duration = probe.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) continue;

    segments.push({
      index,
      filePath,
      // Audio can be cut at any sample, so the muxer honours segment_time
      // exactly. The nominal boundary is used rather than the sum of measured
      // durations because the MP3 encoder pads each piece by a few
      // milliseconds, which would otherwise accumulate into real drift across
      // a multi-hour source.
      globalStartSeconds: Number((index * segmentSeconds).toFixed(3)),
      durationSeconds: Number(duration.toFixed(3)),
    });
  }

  return segments;
}

export interface CutClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  hasAudio: boolean;
}

/** Cuts a clip from the ORIGINAL source and re-encodes to MP4 / H.264 / AAC. */
export async function cutClip(options: CutClipOptions): Promise<{ sizeBytes: number; durationSeconds: number }> {
  const duration = Math.max(0.1, options.endSeconds - options.startSeconds);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    // Coarse input seek for speed, then an accurate output seek from the
    // keyframe: fast on long sources without drifting off the requested start.
    '-ss', options.startSeconds.toFixed(3),
    '-i', options.inputPath,
    '-t', duration.toFixed(3),
    '-c:v', 'libx264',
    '-preset', env.CLIP_PRESET,
    '-crf', String(env.CLIP_VIDEO_CRF),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
  ];

  if (options.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', env.CLIP_AUDIO_BITRATE, '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push('-movflags', '+faststart', options.outputPath);

  await run(env.FFMPEG_PATH, args, { timeoutMs: 60 * 60 * 1000 });

  const [info, probe] = await Promise.all([stat(options.outputPath), ffprobe(options.outputPath)]);
  return { sizeBytes: info.size, durationSeconds: probe.durationSeconds };
}

/** Verifies ffmpeg/ffprobe are present; called at worker startup. */
export async function assertFfmpegAvailable(): Promise<void> {
  await run(env.FFMPEG_PATH, ['-version'], { timeoutMs: 15_000 });
  await run(env.FFPROBE_PATH, ['-version'], { timeoutMs: 15_000 });
}
