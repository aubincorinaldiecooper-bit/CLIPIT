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

/**
 * Why a moment was waved away, when the person cared to say. Optional and
 * only ever attached to a rejection: the interaction stays two buttons.
 * 'missed_moment' is the one that matters most — a moment the model never
 * returned has no card to thumbs-down, so "the thing I wanted isn't here"
 * said on the wrong card is the closest live signal recall gets.
 */
export type MatchFeedbackReason =
  | 'wrong_moment'
  | 'missed_moment'
  | 'bad_start'
  | 'bad_end'
  | 'bad_boundaries'
  | 'not_relevant'
  | 'duplicate'
  | 'low_quality'
  | 'other';

export const MATCH_FEEDBACK_REASONS: readonly MatchFeedbackReason[] = [
  'wrong_moment',
  'missed_moment',
  'bad_start',
  'bad_end',
  'bad_boundaries',
  'not_relevant',
  'duplicate',
  'low_quality',
  'other',
] as const;

export interface Session {
  id: string;
  userId: string | null;
  label: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The authenticated actor behind a request, and the rooms they can act in.
 *
 * A person has one personal room and belongs to any number of shared ones.
 * "May I see this" is answered by the rooms a thing is in — its own library
 * plus wherever it has been sent — never by a mode the caller is in. For a
 * guest both are empty and ownership falls back to the session.
 */
export interface Principal {
  sessionId: string;
  userId: string | null;
  /**
   * Their personal room: where their uploads land and their library lives.
   * Nothing moves it — there is no "currently in" state. Null for guests.
   */
  ownWorkspaceId: string | null;
  /**
   * Every room they belong to, personal and shared. Opening something by its
   * id works from any of them, so a clip sent to a room opens for everyone in
   * that room.
   */
  workspaceIds: string[];
  /** What they signed in as, when known — used to name people on a team. */
  email: string | null;
}

export interface Video {
  id: string;
  sessionId: string | null;
  userId: string | null;
  /** The workspace this was added to; null for a guest's upload. */
  workspaceId: string | null;
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
  /** One frame of the video itself, for the library's card. */
  posterStorageKey: string | null;
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
  /** Inherited from the video it was asked about. */
  workspaceId: string | null;
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
  /** Only ever present alongside a rejection. See `MatchFeedbackReason`. */
  feedbackReason: MatchFeedbackReason | null;
  /**
   * Which call produced this moment. Null on rows written before the
   * evaluation layer existed — reported as unsegmented, never guessed.
   */
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  /**
   * The Re-clip lifecycle. Null when nothing is happening; 'pending' while a
   * re-evaluation is queued or running (it can take minutes on a cold GPU);
   * 'failed' when the last attempt produced no new version. Success clears
   * the status — the new version row is the record of success.
   */
  reclipStatus: 'pending' | 'failed' | null;
  /** Why the last Re-clip failed, in words safe to show. */
  reclipError: string | null;
  /** Paid re-evaluation attempts spent, successful or not. Bounds GPU spend. */
  reclipAttempts: number;
  createdAt: Date;
}

/**
 * One version of where a moment's boundaries sit. Version 1 is the model's
 * first-pass prediction, copied from the match row the first time a Re-clip
 * is requested; each Re-clip appends the next version. The match row itself
 * is never updated — this table is why.
 */
export interface MomentVersion {
  id: string;
  matchId: string;
  version: number;
  trigger: 'initial' | 'reclip';
  startSeconds: number;
  endSeconds: number;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  createdAt: Date;
}

export interface Clip {
  id: string;
  videoId: string;
  clipMatchId: string;
  sessionId: string | null;
  userId: string | null;
  /** Inherited from the video it was cut from. */
  workspaceId: string | null;
  /** The caption spec burned into this render, if any. */
  captions: unknown;
  /** Set when this clip is a captioned copy of another. */
  derivedFromClipId: string | null;
  /** Where to look when this clip is cut to a platform's shape: the % position of the crop window's centre along the axis being cut. 50 until moved. */
  focusPct: number;
  startSeconds: number;
  endSeconds: number;
  /**
   * The boundaries the model predicted, frozen at generation time and never
   * updated. start/end above become the person's final answer the moment
   * they adjust the clip; the distance between the two is the timestamp
   * accuracy measurement, so overwriting the prediction would destroy the
   * only ground truth this product collects.
   */
  predictedStartSeconds: number | null;
  predictedEndSeconds: number | null;
  /** Set the first time someone moves this clip's boundaries. */
  boundariesEditedAt: Date | null;
  storageKey: string | null;
  status: ClipStatus;
  errorMessage: string | null;
  durationSeconds: number | null;
  /**
   * How this moment is presented, as opposed to what it is. Everything below
   * describes a SEPARATE 9:16 file and a still from it; the canonical clip
   * above keeps its own framing and its own key, and nothing here can change
   * which seconds of footage the moment covers.
   */
  derivativeStorageKey: string | null;
  derivativeStatus: 'pending' | 'ready' | 'failed' | null;
  posterStorageKey: string | null;
  posterTimestampSeconds: number | null;
  compositionMode: string | null;
  /** Measured, so the shape a client is told is the file's real shape. */
  sourceWidth: number | null;
  sourceHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  /** True when the media was made before anyone chose this moment. */
  preRendered: boolean;
  /** Set on Keep. Null means nobody has chosen it. */
  approvedAt: Date | null;
  retentionClass: 'temporary' | 'owned';
  sizeBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}
