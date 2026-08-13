export type SourceType = 'upload' | 'youtube';

export type VideoStatus = 'pending_upload' | 'queued' | 'ingesting' | 'preprocessing' | 'ready' | 'failed';

export type TranscriptStatus = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export type TranscriptSource = 'youtube_captions' | 'openrouter_stt';

export type ClipRequestStatus = 'pending' | 'searching' | 'completed' | 'failed';

export type ClipStatus = 'pending' | 'generating' | 'ready' | 'failed';

/** What the user (or config) asked us to search. */
export type SearchMode = 'auto' | 'visual' | 'transcript' | 'both';

/** What the search actually ran, after classification and availability checks. */
export type ResolvedSearchMode = 'visual' | 'transcript' | 'both';

export type MatchSource = 'visual' | 'transcript' | 'multimodal';

export interface Session {
  id: string;
  userId: string | null;
  label: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** The authenticated actor behind a request. `userId` is reserved for real auth. */
export interface Principal {
  sessionId: string;
  userId: string | null;
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
  createdAt: Date;
  updatedAt: Date;
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
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkError {
  chunkIndex: number;
  chunkId: string;
  message: string;
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
