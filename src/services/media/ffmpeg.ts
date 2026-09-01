import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';

export interface ProbeResult {
  durationSeconds: number;
  sizeBytes: number | null;
  /** DISPLAY width — the coded width swapped with the height when the file says it is turned. */
  width: number | null;
  height: number | null;
  /** Degrees the file asks players to turn it by, normalised to 0, 90, 180 or 270. */
  rotation: number;
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
  /** Older muxers wrote the phone's orientation here as a string of degrees. */
  tags?: Record<string, string>;
  /** Newer files carry it as a display matrix; ffprobe reports its rotation. */
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
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

/**
 * The orientation a file asks to be shown at. A phone held upright records
 * 1920x1080 and marks the stream "turn me 90°"; every player honours the
 * mark, and so does ffmpeg when it decodes — but the CODED width and height
 * still say landscape. Reading those raw would plan a landscape crop for a
 * portrait video. Both ways the mark has been written are read here.
 */
export function probeRotation(stream: FfprobeStream | undefined): number {
  if (!stream) return 0;
  const fromMatrix = stream.side_data_list?.find((entry) => typeof entry.rotation === 'number')?.rotation;
  const fromTag = stream.tags?.rotate !== undefined ? Number(stream.tags.rotate) : undefined;
  const raw = fromMatrix ?? fromTag;
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  // A display matrix reports counter-clockwise (−90 for the common portrait
  // case); the tag reported clockwise. Only the quadrant matters here.
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** Exported for the tests: the probe, minus the process. */
export function interpretProbe(parsed: FfprobeOutput): ProbeResult {
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const duration = toNumber(parsed.format?.duration) ?? toNumber(video?.duration) ?? 0;
  const rotation = probeRotation(video);
  const turned = rotation === 90 || rotation === 270;

  return {
    durationSeconds: duration,
    sizeBytes: toNumber(parsed.format?.size),
    width: (turned ? video?.height : video?.width) ?? null,
    height: (turned ? video?.width : video?.height) ?? null,
    rotation,
    fps: parseFrameRate(video?.avg_frame_rate) ?? parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasAudio: Boolean(audio),
    bitRate: toNumber(parsed.format?.bit_rate),
    formatName: parsed.format?.format_name ?? null,
    raw: parsed as unknown as Record<string, unknown>,
  };
}

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  const { stdout } = await run(
    env.FFPROBE_PATH,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs: 120_000 },
  );
  return interpretProbe(JSON.parse(stdout) as FfprobeOutput);
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
      '-map', '0:v:0',
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
      '-sn',
      '-dn',
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
      '-map', '0:v:0',
      '-an',
      '-sn',
      '-dn',
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
      '-map', '0:a:0',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', env.TRANSCRIBE_AUDIO_BITRATE,
      '-sn',
      '-dn',
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

/**
 * The proxy a PERSON watches. The analysis proxy is built for a model: 360p,
 * two frames a second, silent. Review cards were playing the original
 * instead — a multi-gigabyte 4K file, in a browser — and cutting thumbnails
 * from the model's proxy at 320px. This is the middle: short side capped
 * (720 by default), real frame rate up to 30, with sound, and streamable
 * from the first byte.
 */
export async function createPlaybackProxy(inputPath: string, outputPath: string): Promise<void> {
  const side = Math.max(2, Math.floor(env.PLAYBACK_PROXY_SHORT_SIDE / 2) * 2);
  // A one-pixel side rounds to zero, which ffmpeg reads as "keep the
  // input" — and 1 is odd. Such a video is not footage; it is scaled to the
  // two pixels the encoder needs rather than left with no proxy at all.
  const shortLandscape = `max(2,min(${side},trunc(ih/2)*2))`;
  const shortPortrait = `max(2,min(${side},trunc(iw/2)*2))`;
  const proxyWidth = `if(gt(iw,ih),trunc(iw*${shortLandscape}/ih/2)*2,${shortPortrait})`;
  const proxyHeight = `if(gt(iw,ih),${shortLandscape},trunc(ih*${shortPortrait}/iw/2)*2)`;
  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      // Shorter side to `side`, never upscaling, whichever way the frame is
      // turned — ffmpeg has already applied the file's rotation by here.
      // Both sides come out even and neither exceeds its source side: the
      // shorter side is min(side, source rounded DOWN to even), because a
      // 1280x719 recording is under the cap and would otherwise reach the
      // encoder at 719 lines, which 4:2:0 H.264 refuses; the longer side is
      // derived from it and floored, because ffmpeg's `-2` rounds to the
      // nearest even and would make a 1279-wide source 1280.
      '-vf', `scale='${proxyWidth}':'${proxyHeight}',fps=fps='min(30,source_fps)'`,
      '-c:v', 'libx264',
      '-preset', env.PROXY_PRESET,
      '-crf', String(env.PLAYBACK_PROXY_CRF),
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-sn',
      '-dn',
      '-movflags', '+faststart',
      outputPath,
    ],
    { timeoutMs: 60 * 60 * 1000 },
  );
}

export interface CutClipOptions {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  hasAudio: boolean;
  /** Extra -vf filters (e.g. burned-in captions), applied in order. */
  videoFilters?: string[];
}

/**
 * Scale so the shorter side is at most CLIP_MAX_SHORT_SIDE, whichever way the
 * frame is turned: 4096x2160 becomes 2048x1080, 2160x4096 becomes 1080x2048,
 * and anything already inside the cap passes through untouched — `min()`
 * against the input size is what stops it ever upscaling. `-2` keeps the
 * aspect ratio and rounds to an even number, which H.264 requires.
 *
 * Exported for the tests only; the cut applies it itself.
 */
export function clipResolutionCap(maxShortSide: number = env.CLIP_MAX_SHORT_SIDE): string {
  const cap = Math.round(maxShortSide);
  return `scale='if(gt(iw,ih),-2,min(${cap},iw))':'if(gt(iw,ih),min(${cap},ih),-2)'`;
}

/** Cuts a clip from the ORIGINAL source and re-encodes to MP4 / H.264 / AAC. */
export async function cutClip(options: CutClipOptions): Promise<{ sizeBytes: number; durationSeconds: number }> {
  const duration = Math.max(0.1, options.endSeconds - options.startSeconds);

  // Input-seek to a keyframe before the requested start, then output-seek to
  // the exact start. Without the output seek, `-t` measures from the keyframe,
  // so a clip starting a few seconds after a keyframe ends a few seconds early
  // — which cuts speakers off mid-sentence.
  const preRollSeconds = Math.min(options.startSeconds, 10);
  const coarseStartSeconds = Math.max(0, options.startSeconds - preRollSeconds);
  const outputOffsetSeconds = options.startSeconds - coarseStartSeconds;

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', coarseStartSeconds.toFixed(3),
    '-i', options.inputPath,
    '-ss', outputOffsetSeconds.toFixed(3),
    // `-t` enforces the minimum-duration clamp (the `Math.max(0.1, …)`
    // above) and still stops at the exact end when no clamp was applied.
    '-t', duration.toFixed(3),
    '-map', '0:v:0',
    '-c:v', 'libx264',
    '-preset', env.CLIP_PRESET,
    '-crf', String(env.CLIP_VIDEO_CRF),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
  ];

  // Caller filters first, the cap last. Burned captions are sized against
  // the ORIGINAL frame, so they must be drawn before it is scaled down or a
  // 4K caption lands on a 1080p canvas at four times the intended size.
  args.push('-vf', [...(options.videoFilters ?? []), clipResolutionCap()].join(','));

  if (options.hasAudio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', env.CLIP_AUDIO_BITRATE, '-ac', '2');
  } else {
    args.push('-an');
  }

  args.push('-sn', '-dn', '-movflags', '+faststart', options.outputPath);

  await run(env.FFMPEG_PATH, args, { timeoutMs: 60 * 60 * 1000 });

  const [info, probe] = await Promise.all([stat(options.outputPath), ffprobe(options.outputPath)]);
  return { sizeBytes: info.size, durationSeconds: probe.durationSeconds };
}

/**
 * Grabs one frame at a given moment, for a match thumbnail.
 *
 * `-ss` before `-i` seeks by keyframe before decoding, which is fast enough to
 * run per match, and imprecise by at most a keyframe interval — irrelevant for
 * a preview still, and the reason this is not reused for anything that needs
 * an exact frame.
 *
 * Returns false when nothing was written. Seeking past the last decodable
 * frame exits 0 without producing a file, so the result has to be confirmed
 * rather than assumed.
 */
export async function extractFrameAt(
  inputPath: string,
  seconds: number,
  outputPath: string,
  maxWidth = 320,
  options: {
    /** Applied BEFORE the scale: the same crop window the export will use. */
    cropFilter?: string | null;
    /** JPEG quality, 2 (best) to 31. The default is a preview; a thumbnail asks for 2. */
    quality?: number;
  } = {},
): Promise<boolean> {
  const filters = [...(options.cropFilter ? [options.cropFilter] : []), `scale='min(${maxWidth},iw)':-2`];
  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', Math.max(0, seconds).toFixed(3),
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', filters.join(','),
      '-q:v', String(options.quality ?? 5),
      outputPath,
    ],
    { timeoutMs: 60_000 },
  );

  const info = await stat(outputPath).catch(() => null);
  return info !== null && info.size > 0;
}

/**
 * Builds the smallest clip a provider will still accept as video.
 *
 * Used by the routing preflight, which needs a throwaway MP4 rather than any
 * particular content. It was a 32x32 single frame embedded as a base64
 * literal, which Alibaba rejected outright — "The video modality input does
 * not meet the requirements" — leaving the preflight permanently inconclusive
 * and therefore useless. Generating it means the dimensions can be raised
 * again for the next provider that has a floor, without regenerating and
 * re-pasting kilobytes of base64.
 */
export async function createProbeClip(outputPath: string): Promise<void> {
  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      // A moving test pattern rather than a flat colour: some providers reject
      // or specially handle a video with no change between frames.
      '-i', `testsrc=size=${PROBE_CLIP_SIZE}x${PROBE_CLIP_SIZE}:rate=${PROBE_CLIP_FPS}:duration=${PROBE_CLIP_SECONDS}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'baseline',
      '-movflags', '+faststart',
      '-y', outputPath,
    ],
    { timeoutMs: 30_000 },
  );
}

/** Comfortably above the smallest input Alibaba accepted, and still ~11KB. */
const PROBE_CLIP_SIZE = 256;
const PROBE_CLIP_FPS = 8;
const PROBE_CLIP_SECONDS = 2;

/** Verifies ffmpeg/ffprobe are present; called at worker startup. */
export async function assertFfmpegAvailable(): Promise<void> {
  await run(env.FFMPEG_PATH, ['-version'], { timeoutMs: 15_000 });
  await run(env.FFPROBE_PATH, ['-version'], { timeoutMs: 15_000 });
}

/**
 * Render the vertical publishing asset: a real 1080x1920 MP4.
 *
 * Two shapes, one encode path, so the delivery settings cannot drift apart
 * between them:
 *
 *  SMART CROP — MiniCPM judged a crop safe and planReframe computed WHICH
 *  source pixels survive. Those pixels are cut, then scaled to the delivery
 *  size. The scale adds no detail and this function does not pretend it does;
 *  it produces the file the platforms require.
 *
 *  BLURRED BACKGROUND — the whole frame is kept. A blurred, over-scaled copy
 *  fills the canvas behind it so no black bar survives, and the complete
 *  source frame sits centred and uncropped on top. This is the safe mode:
 *  nothing the camera recorded is discarded.
 *
 * Audio is carried through in both. A silent vertical clip would be a
 * different, useless artefact, and `-an` here would be an easy accident.
 *
 * setsar=1 is not decoration: a source with a non-square pixel aspect would
 * otherwise arrive at 1080x1920 storage dimensions while displaying as
 * something else, and every check downstream would read the right numbers off
 * a wrong-looking file.
 */
export interface VerticalRenderOptions {
  inputPath: string;
  outputPath: string;
  hasAudio: boolean;
  /** Output geometry. Fixed by the platform contract, passed in for testability. */
  delivery: { width: number; height: number };
  /** From planReframe. Null renders the blurred-background composition. */
  cropFilter: string | null;
  /** Blur strength for the background layer. */
  blurSigma?: number;
}

export async function renderVerticalDerivative(
  options: VerticalRenderOptions,
): Promise<{ sizeBytes: number; durationSeconds: number; width: number; height: number }> {
  const { width, height } = options.delivery;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', options.inputPath];

  if (options.cropFilter) {
    // Crop the chosen source window, then scale it up to delivery size.
    args.push('-vf', `${options.cropFilter},scale=${width}:${height},setsar=1`);
    args.push('-map', '0:v:0');
    if (options.hasAudio) args.push('-map', '0:a:0?');
  } else {
    const sigma = options.blurSigma ?? 24;
    args.push(
      '-filter_complex',
      [
        `[0:v:0]split=2[bg][fg]`,
        // increase=cover the canvas, crop the overflow, blur hard enough to
        // read as texture rather than as a second, confusing video.
        `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},gblur=sigma=${sigma}[bgblur]`,
        // decrease=the WHOLE frame fits. Nothing is cropped away.
        `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgfit]`,
        `[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`,
      ].join(';'),
      '-map', '[v]',
    );
    if (options.hasAudio) args.push('-map', '0:a:0?');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', env.CLIP_PRESET,
    '-crf', String(env.CLIP_VIDEO_CRF),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-level', '4.1',
  );

  if (options.hasAudio) args.push('-c:a', 'aac', '-b:a', env.CLIP_AUDIO_BITRATE, '-ac', '2');
  else args.push('-an');

  args.push('-sn', '-dn', '-movflags', '+faststart', options.outputPath);

  await run(env.FFMPEG_PATH, args, { timeoutMs: 60 * 60 * 1000 });

  const [info, probe] = await Promise.all([stat(options.outputPath), ffprobe(options.outputPath)]);
  // Report what was actually written, not what was requested — the caller
  // persists this as the file's geometry and must not record an intention.
  return {
    sizeBytes: info.size,
    durationSeconds: probe.durationSeconds,
    width: probe.width ?? width,
    height: probe.height ?? height,
  };
}

/**
 * Build a tiny synthetic source: colour bars with a tone, at a chosen size.
 *
 * For integration tests that need real footage without committing a media
 * fixture to the repository. Deterministic, a couple of kilobytes, and it
 * carries an audio stream so "audio survives the render" is actually testable
 * rather than assumed.
 */
export async function createSyntheticSource(
  outputPath: string,
  options: { width: number; height: number; seconds: number },
): Promise<void> {
  await run(
    env.FFMPEG_PATH,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${options.width}x${options.height}:rate=25:duration=${options.seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${options.seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-shortest',
      outputPath,
    ],
    { timeoutMs: 120_000 },
  );
}

/** Does this file carry an audio stream? Used to prove audio survived a render. */
export async function hasAudioStream(filePath: string): Promise<boolean> {
  const { stdout } = await run(
    env.FFPROBE_PATH,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath],
    { timeoutMs: 30_000 },
  );
  return stdout.trim().length > 0;
}
