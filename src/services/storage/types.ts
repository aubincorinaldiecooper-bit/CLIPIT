export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType?: string;
}

/**
 * Minimal object-storage surface used by the pipeline. Implemented today by the
 * S3-compatible adapter (AWS S3, Railway buckets, MinIO, R2, ...).
 */
export interface StorageAdapter {
  /** Presigned PUT URL handed to the client so uploads bypass the API server. */
  createUploadUrl(key: string, contentType: string, expiresInSeconds?: number): Promise<string>;
  /** Presigned GET URL for playback / download. */
  createDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  uploadFile(key: string, filePath: string, contentType: string): Promise<StoredObject>;
  downloadToFile(key: string, destinationPath: string): Promise<void>;
  head(key: string): Promise<StoredObject | null>;
  remove(key: string): Promise<void>;
  /**
   * Allows `origins` to PUT directly to the bucket. Optional: an adapter whose
   * backing store has no CORS concept simply omits it.
   */
  ensureUploadCors?(origins: string[]): Promise<void>;
}

export const StoragePrefix = {
  originals: 'originals',
  proxies: 'proxies',
  clips: 'clips',
} as const;

/** Strips characters that make object keys awkward, keeping the extension. */
export function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().replace(/^.*[\\/]/, '');
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 120) || 'source';
}

export function originalKey(videoId: string, filename: string): string {
  return `${StoragePrefix.originals}/${videoId}/${sanitizeFilename(filename)}`;
}

export function proxyKey(videoId: string): string {
  return `${StoragePrefix.proxies}/${videoId}/proxy.mp4`;
}

export function chunkKey(videoId: string, chunkIndex: number): string {
  return `${StoragePrefix.proxies}/${videoId}/chunks/${String(chunkIndex).padStart(4, '0')}.mp4`;
}

export function clipKey(videoId: string, clipId: string): string {
  return `${StoragePrefix.clips}/${videoId}/${clipId}.mp4`;
}
