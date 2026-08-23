export type SourceType = 'upload' | 'youtube';

export type VideoStatus = 'pending_upload' | 'queued' | 'ingesting' | 'preprocessing' | 'ready' | 'failed';

export type TranscriptStatus = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export type TranscriptSource = 'youtube_captions' | 'openrouter_stt';

/** State of the ingest-time visual understanding (scene index) for a video. */
export type IndexStatus = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export type ClipRequestStatus = 'pending' | 'searching' | 'completed' | 'failed';

export type ClipStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** What the user (or config) asked us to search. */
export type SearchMode = 'auto' | 'visual' | 'transcript' | 'both';

/** What the search actually ran, after classification and availability checks. */
export type ResolvedSearchMode = 'visual' | 'transcript' | 'both';

export type MatchSource = 'visual' | 'transcript' | 'multimodal';

/**
 * Whether a question was answered from the notes taken at upload, or by
 * reading the footage again.
 *
 * Not a performance detail. The notes are a summary, so "the notes do not
 * mention it" is a weaker statement than "the video does not contain it", and
 * only one of the two paths can make the stronger claim.
 */
export type AnsweredFrom = 'notes' | 'footage';

/**
 * What a person thought of a match.
 *
 * Confidence is the model's opinion of its own answer; this is the only thing
 * in the system that disagrees with it. A rejected match is kept rather than
 * deleted — it is hidden from the user, but it is also the only record of the
 * model being wrong, which is what makes the confidence score checkable.
 */
export type MatchFeedback = 'approved' | 'rejected';

export interface Session {
  id: string;
  userId: string | null;
  label: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The authenticated actor behind a request.
 *
 * `userIds` is who this caller may act as: themselves, plus everyone who
 * shares their workspace. A workspace shares everything, so "may I see this
 * clip" is answered by asking whether its owner is one of these. For a guest
 * (no userId) the list is empty and ownership falls back to the session.
 */
export interface Principal {
  sessionId: string;
  userId: string | null;
  userIds: string[];
  /** What they signed in as, when known — used to name people on a team. */
  email: string | null;
}

export interface Video {
  id: string;
  sessionId: string | null;
  userId: string | null;
  sourceType: SourceType;
  sourceUrl: string | null;
  originalFilename: string | null;
  title: string | null;
  status: VideoStatus;
  errorMessage: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean | null;
  metadata: Record<string, unknown>;
  originalStorageKey: string | null;
  proxyStorageKey: string | null;
  captionsStorageKey: string | null;
  chunkSeconds: number | null;
  chunkCount: number;
  transcriptStatus: TranscriptStatus;
  transcriptSource: TranscriptSource | null;
  transcriptError: string | null;
  transcriptSegmentCount: number;
  /**
   * When the footage was removed because the session that uploaded it ended.
   * Null while the video is still whole. See `services/retention.ts`.
   */
  footageExpiredAt: Date | null;
  indexStatus: IndexStatus;
  /**
   * How far into the video the notes reach, in seconds. Zero unless the video
   * was loaded with `getVideoWithReadProgress`.
   */
  indexReadThroughSeconds: number;
  indexError: string | null;
  sceneCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One entry in a video's scene index: what the model saw during
 * [startSeconds, endSeconds] of the source, written at ingest time.
 */
export interface VideoScene {
  id: string;
  videoId: string;
  sceneIndex: number;
  startSeconds: number;
  endSeconds: number;
  description: string;
}

export interface VideoChunk {
  id: string;
  videoId: string;
  chunkIndex: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  durationSeconds: number;
  storageKey: string;
  createdAt: Date;
}

export interface TranscriptSegment {
  id: string;
  videoId: string;
  segmentIndex: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  source: TranscriptSource;
}

export interface ClipRequest {
  id: string;
  videoId: string;
  sessionId: string | null;
  userId: string | null;
  instruction: string;
  mode: SearchMode;
  resolvedMode: ResolvedSearchMode | null;
  status: ClipRequestStatus;
  errorMessage: string | null;
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  chunkErrors: ChunkError[];
  chunkDegradations: ChunkDegradation[];
  answeredFrom: AnsweredFrom | null;
  uncertainMatches: UncertainMatch[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Why a chunk was not searched. Distinguished because the answers differ: a
 * provider content filter will reject the same input every time, while a
 * timeout or transport failure is worth another attempt.
 */
export type ChunkFailureCode =
  /**
   * Not a failure of this search at all: the stretch was never described when
   * the video was read at upload, so an answer from the notes cannot speak for
   * it. Reported the same way as an unsearched chunk because it means the same
   * thing to the person reading it — nobody looked there.
   */
  | 'not_in_notes'
  /**
   * Not a failure at all: when this question was asked, the video had not been
   * read that far yet. Distinct from `not_in_notes`, which means the read
   * finished and that stretch is missing from it — one resolves itself in a
   * minute, the other never will, and telling a person "I couldn't look there"
   * about the first is simply untrue.
   */
  | 'not_read_yet'
  | 'provider_content_filter'
  | 'provider_error'
  | 'timeout'
  | 'transport'
  | 'unknown';

export interface ChunkError {
  chunkIndex: number;
  chunkId: string;
  message: string;
  code: ChunkFailureCode;
  /**
   * The source window this chunk covered. Without it the client can say that
   * something was missed but not *what* — and "chunk 7 failed" tells a user
   * nothing about whether the moment they asked for was inside it.
   */
  globalStartSeconds: number;
  globalEndSeconds: number;
}

/**
 * A chunk searched with less evidence than intended.
 *
 * A chunk recovered by dropping its transcript is not a failure, but it is not
 * full coverage either, and reporting it as clean would hide that a spoken
 * condition could not be checked there.
 */
export interface ChunkDegradation {
  chunkIndex: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  reason: 'transcript_omitted';
}

/**
 * A moment the model reported and our threshold discarded.
 *
 * Not a result — never generated into a clip, never counted, never ranked.
 * It exists so an answer can say "I saw something at 04:12 I wasn't sure
 * about" rather than reporting an absence we know to be untrue.
 */
export interface UncertainMatch {
  globalStartSeconds: number;
  globalEndSeconds: number;
  confidence: number;
  description: string;
}

export interface ClipMatch {
  id: string;
  clipRequestId: string;
  chunkId: string;
  localStartSeconds: number;
  localEndSeconds: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote: string | null;
  /**
   * Storage key of a still from this moment. Null when extraction failed or
   * has not run — a match without a picture is still a match.
   */
  thumbnailKey: string | null;
  /** Null until someone says. See `MatchFeedback`. */
  feedback: MatchFeedback | null;
  createdAt: Date;
}

export interface Clip {
  id: string;
  videoId: string;
  clipMatchId: string;
  sessionId: string | null;
  userId: string | null;
  startSeconds: number;
  endSeconds: number;
  storageKey: string | null;
  status: ClipStatus;
  errorMessage: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}
