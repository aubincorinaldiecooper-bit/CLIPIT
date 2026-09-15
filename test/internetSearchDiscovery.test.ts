import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertPublicInternetUrl,
  normalizeSearxResults,
  search,
} from '../src/services/discovery/searxng.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SEARXNG_URL;
  delete process.env.WEB_SEARCH_MAX_CANDIDATES;
  vi.restoreAllMocks();
});

describe('search candidates', () => {
  it('deduplicates by page URL and ignores the fragment', () => {
    const results = normalizeSearxResults('find the red car', {
      results: [
        {
          url: 'https://publisher.example/watch/9#t=30',
          title: 'Red car',
          thumbnail: 'https://img.example/car.jpg',
          engine: 'example-video',
        },
        { url: 'https://publisher.example/watch/9', title: 'Duplicate' },
      ],
    }, 20);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Red car',
      pageUrl: 'https://publisher.example/watch/9',
      thumbnailUrl: 'https://img.example/car.jpg',
      source: 'example-video',
      query: 'find the red car',
    });
  });

  it('keeps only http and https results', () => {
    const results = normalizeSearxResults('q', {
      results: [
        { url: 'javascript:alert(1)', title: 'xss' },
        { url: 'file:///etc/passwd', title: 'local' },
        { url: 'not a url', title: 'junk' },
        { url: 'https://ok.example/watch', title: 'fine' },
      ],
    }, 20);

    expect(results.map((row) => row.pageUrl)).toEqual(['https://ok.example/watch']);
  });

  it('respects the candidate ceiling', () => {
    const results = normalizeSearxResults('q', {
      results: Array.from({ length: 10 }, (_, index) => ({
        url: `https://example.com/watch/${index}`,
        title: String(index),
      })),
    }, 3);
    expect(results).toHaveLength(3);
  });

  it('describes a page, not a file to download', () => {
    const [candidate] = normalizeSearxResults('q', {
      results: [{ url: 'https://cdn.example.com/clip.mp4', title: 'Clip' }],
    }, 20);

    // The browser plays the page; nothing here resolves it to media.
    expect(candidate).not.toHaveProperty('mediaUrl');
    expect(candidate).not.toHaveProperty('resolvedBy');
    expect(candidate!.pageUrl).toBe('https://cdn.example.com/clip.mp4');
  });

  it('falls back to the URL when a result has no title', () => {
    const [candidate] = normalizeSearxResults('q', {
      results: [{ url: 'https://example.com/watch/1' }],
    }, 20);
    expect(candidate!.title).toBe('https://example.com/watch/1');
  });

  it('survives a reply that is not shaped like one', () => {
    expect(normalizeSearxResults('q', null, 20)).toEqual([]);
    expect(normalizeSearxResults('q', { results: 'nope' }, 20)).toEqual([]);
  });
});

describe('refusing to reach inside our own network', () => {
  it('rejects anything that is not http or https', async () => {
    await expect(assertPublicInternetUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('rejects URLs carrying credentials', async () => {
    await expect(assertPublicInternetUrl('https://user:pw@example.com/')).rejects.toThrow(/credentials/);
  });

  it('rejects a host that resolves to a private address', async () => {
    await expect(assertPublicInternetUrl('http://127.0.0.1/admin')).rejects.toThrow(/private/);
    await expect(assertPublicInternetUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private/);
  });
});

describe('asking the provider', () => {
  it('refuses an empty query rather than searching for nothing', async () => {
    await expect(search('   ')).rejects.toThrow(/must not be empty/);
  });

  it('says it could not look, rather than reporting nothing found', async () => {
    process.env.SEARXNG_URL = 'http://searx.internal';
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 502 })) as typeof fetch;

    // "We could not look" and "there is nothing out there" are different
    // answers and must never be returned as the same one.
    await expect(search('red car')).rejects.toThrow(/HTTP 502/);
  });

  it('is unusable rather than silently empty when unconfigured', async () => {
    await expect(search('red car')).rejects.toThrow(/SEARXNG_URL is required/);
  });

  it('passes the query through verbatim and returns its candidates', async () => {
    process.env.SEARXNG_URL = 'http://searx.internal';
    const fetchMock = vi.fn(async () => Response.json({
      results: [{ url: 'https://publisher.example/watch/1', title: 'A clip' }],
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const candidates = await search('  a man walking a dog  ');

    const requested = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requested.searchParams.get('q')).toBe('a man walking a dog');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.query).toBe('a man walking a dog');
  });
});
