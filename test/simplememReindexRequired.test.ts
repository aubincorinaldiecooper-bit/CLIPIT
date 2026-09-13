import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A memory written under an older embedding contract is not a memory of the
 * video. The sidecar refuses to answer from one (409, "reindex required");
 * the worker must turn that into a row that says so, not into a query that
 * fails the same way on every question — and never into "nothing matches".
 */

vi.mock('../src/config/env.js', () => ({
  env: {
    SIMPLEMEM_URL: 'http://sidecar.test',
    SIMPLEMEM_INTERNAL_TOKEN: 'k'.repeat(40),
    SIMPLEMEM_REQUEST_TIMEOUT_MS: 5_000,
    SIMPLEMEM_INDEX_TIMEOUT_MS: 5_000,
  },
}));

const { SimpleMemReindexRequired, simplememQuery } = await import('../src/services/retrieval/simplemem/client.js');
const { ExternalServiceError } = await import('../src/lib/errors.js');

const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an outdated memory', () => {
  it('is reported as "re-index me", not retried and not "nothing found"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ detail: 'video memory embedding identity changed; reindex required' }), { status: 409 }),
    ));
    const failure = await simplememQuery({ videoId: 'video-1', query: 'the dunk', topK: 5 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SimpleMemReindexRequired);
    expect(failure).toBeInstanceOf(ExternalServiceError);
    expect((failure as ExternalServiceError).retryable).toBe(false);
    expect((failure as Error).message).toContain('re-indexed');
    expect((failure as Error).message).toContain('reindex required');
  });

  it('is still an ordinary failure when the sidecar answers anything else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const failure = await simplememQuery({ videoId: 'video-1', query: 'the dunk', topK: 5 }).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(SimpleMemReindexRequired);
    expect((failure as ExternalServiceError).retryable).toBe(true);
  });

  it('marks the index row unavailable with the reason, so the next question does not ask again', async () => {
    const handler = await read('src/worker/handlers/clipSearch.ts');
    const memory = handler.slice(handler.indexOf('async function answerFromSimpleMem'));
    expect(memory).toContain('if (error instanceof SimpleMemReindexRequired) {');
    expect(memory).toContain("await setSimpleMemIndexStatus(input.video.id, 'unavailable', { error: detail });");
    expect(memory).toContain("fallback: 'index_unavailable'");
  });

  it('is what every memory written before the transformers pin became', async () => {
    const sidecar = await read('tools/simplemem/sidecar.py');
    expect(sidecar).toContain('EMBEDDING_VERSION = os.environ.get("SIMPLEMEM_EMBEDDING_VERSION", "v2").strip() or "v2"');
    expect(sidecar).toContain('detail="video memory embedding identity changed; reindex required"');
  });
});
