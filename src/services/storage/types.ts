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

  /**
   * A large file arrives in pieces. One presigned PUT caps at 5GB — S3's own
   * ceiling for a single request — and real footage at hours of runtime is
   * bigger, so the browser asks for a part-by-part upload instead: start it,
   * PUT each numbered slice to its own URL, then complete it with the ETags
   * storage returned.
   */
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  /**
   * One part's URL, signed fresh when the browser is about to send it —
   * presigning the whole set up front stranded any upload slower than the
   * URLs' shared expiry. `contentLength` is signed into the URL, so storage
   * itself refuses a part bigger than the slice the server agreed to.
   */
  createPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
    expiresInSeconds?: number,
  ): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void>;
  /** Walk away cleanly: parts already uploaded stop being stored and billed. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  /** A lifecycle rule that sweeps multipart uploads nobody ever completed. */
  ensureAbandonedUploadLifecycle?(): Promise<void>;
  /** Presigned GET URL for playback / download. */
  /**
   * `downloadFilename` makes the object arrive as a save rather than a
   * navigation. The HTML `download` attribute is ignored cross-origin, so a
   * link to a plain presigned URL opens the video in a tab instead of saving
   * it — the disposition has to be signed into the URL itself.
   */
  createDownloadUrl(
    key: string,
    options?: { expiresInSeconds?: number; downloadFilename?: string },
  ): Promise<string>;
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
