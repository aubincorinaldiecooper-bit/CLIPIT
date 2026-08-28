import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import type { StorageAdapter, StoredObject } from './types.js';

/**
 * Keeps a filename usable on every OS and safe inside a quoted header.
 * Colons in particular are illegal on Windows, which rules out raw timecodes.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'clip.mp4';
}

function buildClient(): S3Client {
  return new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL, forcePathStyle: env.S3_FORCE_PATH_STYLE } : {}),
  });
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(client: S3Client = buildClient(), bucket: string = env.BUCKET_NAME) {
    this.client = client;
    this.bucket = bucket;
  }

  async createUploadUrl(key: string, contentType: string, expiresInSeconds = env.UPLOAD_URL_EXPIRY_SECONDS): Promise<string> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * A presigned PUT is only half the story: the browser is on the app's origin
   * and the bucket is on another, so without a CORS rule the request never
   * leaves the browser and the failure carries no HTTP status to explain
   * itself. `PutBucketCors` replaces the whole policy, so one rule covers it.
   */
  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const started = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!started.UploadId) throw new Error('storage did not return a multipart upload id');
    return started.UploadId;
  }

  async createPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = env.UPLOAD_URL_EXPIRY_SECONDS,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
    );
  }

  async ensureUploadCors(origins: string[]): Promise<void> {
    try {
      await this.client.send(
        new PutBucketCorsCommand({
          Bucket: this.bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                // HEAD and GET cover playback of clips through signed URLs.
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
    } catch (error) {
      throw new ExternalServiceError('storage', `Failed to configure CORS on ${this.bucket}`, { cause: error });
    }
  }

  async createDownloadUrl(
    key: string,
    options: { expiresInSeconds?: number; downloadFilename?: string } = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      // Signed into the URL because the browser cannot add it: the `download`
      // attribute has no effect cross-origin, so without this the link
      // navigates to the video rather than saving it.
      ...(options.downloadFilename
        ? { ResponseContentDisposition: `attachment; filename="${sanitizeFilename(options.downloadFilename)}"` }
        : {}),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: options.expiresInSeconds ?? env.SIGNED_URL_EXPIRY_SECONDS,
    });
  }

  async uploadFile(key: string, filePath: string, contentType: string): Promise<StoredObject> {
    const info = await stat(filePath);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: contentType,
          ContentLength: info.size,
        }),
      );
    } catch (error) {
      throw new ExternalServiceError('storage', `Failed to upload ${key}`, { cause: error });
    }
    return { key, sizeBytes: info.size, contentType };
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    await mkdir(path.dirname(destinationPath), { recursive: true });
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) throw new Error('empty response body');
      await pipeline(response.Body as Readable, createWriteStream(destinationPath));
    } catch (error) {
      throw new ExternalServiceError('storage', `Failed to download ${key}`, { cause: error });
    }
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        sizeBytes: Number(response.ContentLength ?? 0),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NotFound') return null;
      throw new ExternalServiceError('storage', `Failed to stat ${key}`, { cause: error });
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new ExternalServiceError('storage', `Failed to delete ${key}`, { cause: error });
    }
  }
}

let cached: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (!cached) cached = new S3StorageAdapter();
  return cached;
}
