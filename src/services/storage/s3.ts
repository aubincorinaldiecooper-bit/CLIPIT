import { createReadStream, createWriteStream } from 'node:fs';
import { stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import type { StorageAdapter, StoredObject } from './types.js';

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

  async createDownloadUrl(key: string, expiresInSeconds = env.SIGNED_URL_EXPIRY_SECONDS): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
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
