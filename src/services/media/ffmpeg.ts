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

  return measureSegments(outputDir, chunkSeconds);
}


/**
 * Reads the segments the muxer produced and gives each one its place on the
 * source timeline.
 *
 * Boundaries are measured from the files rather than assumed, because the
 * segment muxer only cuts on keyframes: a chunk's real duration drifts from
 * the target, and a grid built from arithmetic would slowly diverge from the
 * footage every later stage maps back to.
 *
 * Shared by both preprocessing paths — the single-decode pass writes these
 * files directly, the older two-pass route writes them with a copy — so the
 * grid, its clamping and its keyframe guard cannot differ between them.
 */
/**
 * Orders segment files by the number in their name, never by the text of it.
 *
 * ffmpeg's %04d is a minimum width, not a maximum: the ten-thousandth chunk is
 * chunk_10000.mp4, and as text that sorts between chunk_1000 and chunk_1001.
 * Every segment after it would then be measured against the wrong neighbour,
 * and the global start seconds — the numbers every found moment is reported
 * against — would be wrong from that point to the end of the video. A long
 * enough source with a short enough chunk reaches this inside the supported
 * settings: 360000 seconds cut every 30 makes twelve thousand pieces.
 */
function inSegmentOrder(files: string[], pattern: RegExp): string[] {
  return files
    .map((file) => ({ file, position: Number(pattern.exec(file)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.position))
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.file);
}

/** How often the chunk directory is checked while ffmpeg runs. */
const SEGMENT_POLL_MS = 250;

/**
 * How many times a closed chunk is probed before it is called unreadable.
 *
 * A probe can fail for reasons that have nothing to do with the file — the
 * process could not be launched, or it timed out under load. measureSegments
 * probes again after the encode and may well succeed, so treating the first
 * failure as proof would silence progress on a video that is perfectly fine.
 */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_MS = 200;

/** A chunk with no playable content. measureSegments drops these. */
function isEmptyChunk(durationSeconds: number): boolean {
  return !Number.isFinite(durationSeconds) || durationSeconds <= 0;
}

/**
 * A chunk far longer than asked for, which means the muxer had nowhere to cut
 * and the model would receive several chunks' worth of video in one request.
 * measureSegments treats this as a hard failure.
 */
function isOversizedChunk(durationSeconds: number, chunkSeconds: number): boolean {
  return durationSeconds > chunkSeconds * 1.5;
}

/**
 * Reports each analysis segment as it finishes, while ffmpeg is still running.
 *
 * The segment muxer opens the next file at the moment it closes the current
 * one, so every file but the newest is complete. The newest is still being
 * written and is never probed or announced until the process exits, which is
 * what `flush` is for — and why a failed run calls `stop` instead: the file
 * ffmpeg died holding is not a finished segment.
 *
 * Only chunks that measureSegments would keep are announced, and under the
 * index it would give them, so a caller acting on progress never sees a chunk
 * that is missing from the final result. A chunk that would make
 * measureSegments fail — unreadable, or far longer than the target — ends the
 * announcements altogether rather than being skipped, because that run is over
 * and every later chunk goes with it. That costs one probe per chunk which
 * measureSegments later repeats; the duplicate is worth the guarantee.
 *
 * A caller's callback can never take an encode down with it. Both a throw and
 * a rejected promise are caught and logged, and the callbacks are awaited
 * before this resolves, so nothing is left running after the job is reported
 * done. Losing a whole preprocessing job to a bad progress handler would be
 * absurd: the job is worth more than the reporting.
 *
 * Exported for its own tests: stopping the watch while a probe is outstanding
 * has no deterministic route through createProxiesAndChunks, and it is the
 * case that decides whether a failed run can announce a chunk that is about to
 * be deleted.
 */
export function watchClosedSegments(
  chunkDir: string,
  chunkSeconds: number,
  onClosed: (index: number) => void | Promise<void>,
  /** Retry pacing. Only the tests pass this, to remove a race from a race test. */
  probe: { attempts?: number; retryMs?: number } = {},
) {
  const probeAttempts = probe.attempts ?? PROBE_ATTEMPTS;
  const probeRetryMs = probe.retryMs ?? PROBE_RETRY_MS;
  let nextIndex = 0;
  let stopped = false;
  // Set once a chunk is found that will make measureSegments fail the run.
  let doomed = false;
  const pending: Array<Promise<void>> = [];

  const announce = (index: number): void => {
    try {
      const outcome = onClosed(index);
      // `void` in the signature still accepts an async callback, so a
      // rejection here would otherwise escape as an unhandled rejection and
      // take the process with it.
      if (outcome && typeof (outcome as PromiseLike<void>).then === 'function') {
        pending.push(
          Promise.resolve(outcome).catch((cause: unknown) => {
            logger.warn('a segment progress callback rejected; the encode continues', {
              index,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }),
        );
      }
    } catch (cause) {
      logger.warn('a segment progress callback threw; the encode continues', {
        index,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  /**
   * Probes a closed chunk, giving a failed probe a couple more chances before
   * calling the file unreadable. A blip costs 400ms; a genuinely broken chunk
   * costs the same 400ms once, and then nothing, because the run is over.
   */
  const probeUntilSure = async (
    filePath: string,
  ): Promise<{ readable: boolean; seconds: number }> => {
    for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
      const probed = await ffprobe(filePath).then(
        (probe) => ({ readable: true, seconds: probe.durationSeconds }),
        () => null,
      );
      if (probed) return probed;
      if (stopped || attempt === probeAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, probeRetryMs));
      // The run can fail while we are waiting to try again. Without this the
      // next probe launches anyway, and a stray ffprobe on a file that is
      // about to be deleted can sit there until its own timeout.
      if (stopped) break;
    }
    return { readable: false, seconds: Number.NaN };
  };

  /**
   * Considers each closed file in order. `includeFinal` is only true once the
   * process has exited, when the newest file is closed too.
   */
  const drain = async (includeFinal: boolean): Promise<void> => {
    const files = inSegmentOrder(
      await readdir(chunkDir).catch(() => [] as string[]),
      /^chunk_(\d+)\.mp4$/,
    );
    const limit = includeFinal ? files.length : files.length - 1;

    while (!stopped && !doomed && nextIndex < limit) {
      const index = nextIndex;
      nextIndex += 1;
      const probed = await probeUntilSure(path.join(chunkDir, files[index]!));
      // The run can fail while that probe is outstanding. Clearing the timer
      // does not cancel a poll already in flight, and the fallback deletes
      // this directory — so without this check a caller could be handed a
      // chunk from a failed run that is about to stop existing.
      if (stopped) return;

      // measureSegments probes without catching, and throws on an oversized
      // segment, so either of these fails the whole job — and by here the
      // probe has been retried, so an unreadable file really is unreadable. Every later chunk is
      // then doomed too, however healthy it looks: the fallback deletes the
      // lot. Skipping just this one and carrying on would announce chunks
      // from a run that is already over.
      if (!probed.readable || isOversizedChunk(probed.seconds, chunkSeconds)) {
        doomed = true;
        return;
      }
      // A chunk that probed cleanly with nothing in it. measureSegments drops
      // this one and keeps going, so it is a silent skip, not a failure.
      if (isEmptyChunk(probed.seconds)) continue;
      announce(index);
    }
  };

  // Drains run one at a time. Two overlapping polls — easy once a probe takes
  // longer than the poll interval — could otherwise announce out of order.
  let inFlight: Promise<void> = Promise.resolve();
  const enqueue = (includeFinal: boolean): Promise<void> => {
    inFlight = inFlight
      .then(() => (stopped || doomed ? undefined : drain(includeFinal)))
      .catch(() => undefined);
    return inFlight;
  };

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void enqueue(false);
  }, SEGMENT_POLL_MS);
  timer.unref?.();

  const halt = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    /**
     * Abandons the watch without claiming the segment still being written, and
     * without letting a poll already in flight announce anything more.
     */
    stop(): void {
      stopped = true;
      halt();
    },
    /** Reports the final segment, which closes with the process, then settles. */
    async flush(): Promise<void> {
      halt();
      // Let a poll that is already running finish before the last look, so
      // indices stay in order.
      await inFlight;
      await drain(true);
      await Promise.all(pending);
    },
  };
}

export async function measureSegments(outputDir: string, chunkSeconds: number): Promise<ProxySegment[]> {
  const files = inSegmentOrder(await readdir(outputDir), /^chunk_(\d+)\.mp4$/);

  const segments: ProxySegment[] = [];
  let cursor = 0;

  for (const [index, file] of files.entries()) {
    const filePath = path.join(outputDir, file);
    const probe = await ffprobe(filePath);
    const duration = probe.durationSeconds;

    if (isEmptyChunk(duration)) {
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
  const oversized = segments.find((segment) => isOversizedChunk(segment.durationSeconds, chunkSeconds));
  if (oversized) {
    throw new Error(
      `Chunking produced a ${Math.round(oversized.durationSeconds)}s segment for a ${chunkSeconds}s target — ` +
        'the proxy has no keyframe at the chunk boundary',
    );
  }

  return segments;
}


export interface SinglePassOutputs {
  /** The whole analysis proxy, still the artefact Re-clip and posters read. */
  proxyPath: string;
  /** The playback proxy, or null when only its branch failed. */
  playbackPath: string | null;
  /** The analysis grid, measured from the files the muxer wrote. */
  segments: ProxySegment[];
}

/**
 * Every derived output from ONE decode of the source.
 *
 * Preprocessing used to decode the original twice: once to build the analysis
 * proxy and once to build the playback proxy, then a third pass to copy the
 * analysis proxy into chunks. On a 4096x2160 master that is two full 4K
 * decodes, and on 2026-09-02 production spent 4 minutes on the first and 6
 * minutes 39 on the second for one 12-minute video.
 *
 * `split` clones frame REFERENCES, not pixels, so the decoder runs once and
 * both branches read the same frames. `fps` is placed BEFORE `scale` on the
 * analysis branch: at 2 frames a second that is 15x fewer frames to scale
 * than scaling first and dropping after.
 *
 * The analysis branch splits again after it has been made small, so the whole
 * proxy and the chunks are both written here. That second encode costs a few
 * hundred 640x360 frames — nothing beside a 4K decode — and it means the
 * chunks land progressively, one finished file at a time, while the playback
 * proxy is still being written. Nothing downstream has to wait for the whole
 * video any more.
 *
 * Quality settings, the keyframe grid and the rotation handling are the same
 * expressions the separate passes used, so the outputs are the ones the rest
 * of the system already expects.
 */
export async function createProxiesAndChunks(input: {
  sourcePath: string;
  proxyPath: string;
  playbackPath: string;
  chunkDir: string;
  chunkSeconds?: number;
  /**
   * Fires with the chunk index as each one is finished, while the encode is
   * still running — not in a batch at the end. A chunk is announced only once
   * the muxer has closed it and it has passed the same checks the returned
   * segments pass, so every index announced appears in `segments` and the file
   * it names is complete and safe to read.
   *
   * May be async: this call does not resolve until every callback has settled,
   * and neither a throw nor a rejection can fail the encode.
   */
  onSegmentClosed?: (index: number) => void | Promise<void>;
}): Promise<SinglePassOutputs> {
  const chunkSeconds = input.chunkSeconds ?? env.ANALYSIS_CHUNK_SECONDS;
  const gopFrames = Math.max(1, Math.round(chunkSeconds * env.PROXY_FPS));
  const decodeThreads = env.PREPROCESS_DECODE_THREADS;

  // The playback proxy's shorter side, never upscaled, whichever way the
  // frame is turned. ffmpeg has applied the file's rotation before the graph
  // sees it, so iw/ih are already the displayed dimensions — the same
  // reasoning, and the same expressions, the separate pass used.
  const side = Math.max(2, Math.floor(env.PLAYBACK_PROXY_SHORT_SIDE / 2) * 2);
  const shortLandscape = `max(2,min(${side},trunc(ih/2)*2))`;
  const shortPortrait = `max(2,min(${side},trunc(iw/2)*2))`;
  const playWidth = `if(gt(iw,ih),trunc(iw*${shortLandscape}/ih/2)*2,${shortPortrait})`;
  const playHeight = `if(gt(iw,ih),${shortLandscape},trunc(ih*${shortPortrait}/iw/2)*2)`;

  const graph = [
    `[0:v]split=2[srcan][srcpl]`,
    `[srcan]fps=${env.PROXY_FPS},scale=-2:${env.PROXY_HEIGHT}:flags=bicubic,split=2[anwhole][anseg]`,
    `[srcpl]scale='${playWidth}':'${playHeight}',fps=fps='min(30,source_fps)'[play]`,
  ].join(';');

  // Shared by the whole proxy and the segments: identical pictures either way,
  // and a keyframe exactly where the muxer needs to cut.
  const analysisEncode = [
    '-c:v', 'libx264',
    '-preset', env.PROXY_PRESET,
    '-crf', String(env.PROXY_CRF),
    '-pix_fmt', 'yuv420p',
    '-force_key_frames', `expr:gte(t,n_forced*${chunkSeconds})`,
    '-g', String(gopFrames),
    '-keyint_min', String(gopFrames),
    '-sc_threshold', '0',
    '-an', '-sn', '-dn',
  ];

  // Nothing polls unless somebody is listening.
  const watcher = input.onSegmentClosed
    ? watchClosedSegments(input.chunkDir, chunkSeconds, input.onSegmentClosed)
    : null;

  try {
    await run(
      env.FFMPEG_PATH,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        // Frame threading holds a full-resolution frame per thread, so at 4K
        // this is the single biggest lever on the decoder's memory. 0 leaves
        // ffmpeg to choose, which is one frame per core.
        ...(decodeThreads > 0 ? ['-threads', String(decodeThreads)] : []),
        '-i', input.sourcePath,
        '-filter_complex', graph,

        // 1. The whole analysis proxy.
        '-map', '[anwhole]',
        ...analysisEncode,
        '-movflags', '+faststart',
        input.proxyPath,

        // 2. The same pictures as chunks, written progressively.
        '-map', '[anseg]',
        ...analysisEncode,
        '-f', 'segment',
        '-segment_time', String(chunkSeconds),
        // Rounding between the forced keyframe and the muxer's cut point: the
        // documented allowance is half a frame interval.
        '-segment_time_delta', String(1 / (2 * Math.max(1, env.PROXY_FPS))),
        '-reset_timestamps', '1',
        '-segment_format', 'mp4',
        '-segment_format_options', 'movflags=+faststart',
        path.join(input.chunkDir, 'chunk_%04d.mp4'),

        // 3. The proxy a person watches, with its audio.
        '-map', '[play]',
        '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', env.PROXY_PRESET,
        '-crf', String(env.PLAYBACK_PROXY_CRF),
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-level', '4.1',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-sn', '-dn',
        '-movflags', '+faststart',
        input.playbackPath,
      ],
      { timeoutMs: 6 * 60 * 60 * 1000 },
    );
  } catch (cause) {
    watcher?.stop();
    throw cause;
  }
  await watcher?.flush();

  const segments = await measureSegments(input.chunkDir, chunkSeconds);

  return { proxyPath: input.proxyPath, playbackPath: input.playbackPath, segments };
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

  const files = inSegmentOrder(await readdir(outputDir), /^audio_(\d+)\.mp3$/);

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
 * The cap itself is rounded DOWN to even first. H.264 with 4:2:0 chroma
 * cannot encode an odd dimension, so an odd CLIP_MAX_SHORT_SIDE would not
 * deliver slightly smaller clips — it would fail every oversized cut at the
 * encoder ("height not divisible by 2") and deliver nothing.
 *
 * Exported for the tests only; the cut applies it itself.
 */
export function clipResolutionCap(maxShortSide: number = env.CLIP_MAX_SHORT_SIDE): string {
  const cap = Math.max(2, Math.floor(maxShortSide / 2) * 2);
  // Both sides come out even, and neither ever exceeds its input side.
  //
  // The SHORTER side is min(cap, source rounded DOWN to even): a 1279x719
  // original is under the cap and would otherwise reach the encoder at 719
  // lines, which it refuses just as it refused an odd cap. The LONGER side
  // is then computed from it and rounded down too — ffmpeg's `-2` rounds to
  // the NEAREST even, which turns a 1279-wide source into 1280 and breaks
  // the promise that nothing is ever upscaled, even by a pixel.
  //
  // The one exception to "never larger": a side of a single pixel rounds
  // down to zero, which ffmpeg reads as "keep the input" — and 1 is odd, so
  // the encoder refuses. A one-pixel video is not footage; it is scaled up
  // to the two pixels the encoder needs, aspect kept, rather than failing
  // three times and delivering nothing.
  const shortLandscape = `max(2,min(${cap},trunc(ih/2)*2))`;
  const shortPortrait = `max(2,min(${cap},trunc(iw/2)*2))`;
  const width = `if(gt(iw,ih),trunc(iw*${shortLandscape}/ih/2)*2,${shortPortrait})`;
  const height = `if(gt(iw,ih),${shortLandscape},trunc(ih*${shortPortrait}/iw/2)*2)`;
  return `scale='${width}':'${height}'`;
}

/**
 * Cuts a clip from the ORIGINAL source and re-encodes to MP4 / H.264 / AAC.
 *
 * Reports the delivered file's own width and height, probed after the cut.
 * The resolution cap can shrink what a caller's crop filter produced, so a
 * caller that recorded its planned frame size would be describing a file
 * that does not exist. renderVerticalDerivative already reports this way.
 */
export async function cutClip(
  options: CutClipOptions,
): Promise<{ sizeBytes: number; durationSeconds: number; width: number; height: number }> {
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
  return {
    sizeBytes: info.size,
    durationSeconds: probe.durationSeconds,
    width: probe.width ?? 0,
    height: probe.height ?? 0,
  };
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
