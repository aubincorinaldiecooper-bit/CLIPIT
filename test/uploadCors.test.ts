import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { uploadCorsOrigins } from '../src/services/storage/cors.js';

/**
 * A wrong origin list here fails in the browser with no HTTP status and no
 * server-side trace, so the parsing is worth pinning.
 */

const mutableEnv = env as { BUCKET_CORS_ORIGINS?: string; API_CORS_ORIGIN: string };
const originalApiCors = env.API_CORS_ORIGIN;

afterEach(() => {
  delete mutableEnv.BUCKET_CORS_ORIGINS;
  mutableEnv.API_CORS_ORIGIN = originalApiCors;
});

describe('uploadCorsOrigins', () => {
  it('falls back to the API origin, since that is who uploads', () => {
    mutableEnv.API_CORS_ORIGIN = 'https://clipit.example';
    expect(uploadCorsOrigins()).toEqual(['https://clipit.example']);
  });

  it('prefers an explicit override', () => {
    mutableEnv.API_CORS_ORIGIN = 'https://clipit.example';
    mutableEnv.BUCKET_CORS_ORIGINS = 'https://uploads.example';
    expect(uploadCorsOrigins()).toEqual(['https://uploads.example']);
  });

  it('splits a comma-separated list and trims each entry', () => {
    mutableEnv.BUCKET_CORS_ORIGINS = 'https://a.example, https://b.example ,https://c.example';
    expect(uploadCorsOrigins()).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });

  it('drops empty entries from trailing or doubled commas', () => {
    mutableEnv.BUCKET_CORS_ORIGINS = 'https://a.example,,https://b.example,';
    expect(uploadCorsOrigins()).toEqual(['https://a.example', 'https://b.example']);
  });

  it('passes a wildcard through as a single origin', () => {
    mutableEnv.BUCKET_CORS_ORIGINS = '*';
    expect(uploadCorsOrigins()).toEqual(['*']);
  });

  it('yields nothing when the configuration is blank, so the caller can warn', () => {
    mutableEnv.BUCKET_CORS_ORIGINS = '  ,  ';
    expect(uploadCorsOrigins()).toEqual([]);
  });
});
