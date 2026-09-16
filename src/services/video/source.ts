/**
 * A video source is deliberately separate from whichever model will read it.
 *
 * Clipit has two source shapes today:
 * - stored media, which a model can fetch by URL;
 * - a live browser watch, which produces timestamped frames as playback happens.
 *
 * New sources should add a representation here rather than teaching every model
 * about uploads, browsers, storage, or page credentials.
 */
export type VideoSource = StoredVideoSource | FrameStreamVideoSource;

export interface StoredVideoSource {
  kind: 'stored-video';
  id: string;
  videoUrl: string;
  /** Storage identity when one exists. Models do not need to know how it was created. */
  videoKey?: string;
  expectedBytes?: number;
  durationSeconds?: number | null;
}

export interface VideoFrame {
  /** Position in the source video, not wall-clock time. */
  timestampMs: number;
  /** Source-time span represented by this frame. */
  durationMs: number;
  encoding: 'jpeg' | 'png';
  image: Buffer;
}

/** What the source itself knows when its frame stream stops. */
export interface FrameStreamCompletion {
  /** True only when playback reached the real end of the video. */
  exhausted: boolean;
  reason: string;
  watchedThroughSeconds: number;
}

/**
 * One consumable frame stream.
 *
 * `open` is a function rather than a bare AsyncIterable so a model adapter owns
 * exactly one lifecycle and can pass cancellation through to the source.
 * `completion` is separate because the model consumes pictures, while the
 * orchestration still needs to know whether the browser actually reached the
 * end instead of merely hitting a watch limit or failing halfway through.
 */
export interface FrameStreamVideoSource {
  kind: 'frame-stream';
  id: string;
  open(signal: AbortSignal): AsyncIterable<VideoFrame>;
  completion: Promise<FrameStreamCompletion>;
  durationSeconds?: number | null;
}

export type VideoSourceKind = VideoSource['kind'];

export function isStoredVideoSource(source: VideoSource): source is StoredVideoSource {
  return source.kind === 'stored-video';
}

export function isFrameStreamVideoSource(source: VideoSource): source is FrameStreamVideoSource {
  return source.kind === 'frame-stream';
}
