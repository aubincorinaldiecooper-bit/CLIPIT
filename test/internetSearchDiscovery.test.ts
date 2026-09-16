import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DNS is stubbed so the guard can be exercised without the network: a host in
 * this table resolves to whatever it says, an IP literal resolves to itself,
 * and anything else is a public address.
 */
const LOOKUP: Record<string, string> = {};

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: async (hostname: string) => {
      const address = LOOKUP[hostname] ?? (net.isIP(hostname) ? hostname : '93.184.216.34');
      return [{ address, family: net.isIP(address) === 6 ? 6 : 4 }];
    },
  },
}));

const {
  assertPublicInternetUrl,
  canonicalizeCandidateUrl,
  normalizeSearxResults,
  search,
} = await import('../src/services/discovery/searxng.js');

const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of Object.keys(LOOKUP)) delete LOOKUP[key];
});

const SETTING_NAMES = [
  'SEARXNG_URL',
  'WEB_SEARCH_MAX_CANDIDATES',
  'WEB_SEARCH_TIMEOUT_MS',
  'WEB_SEARCH_SAFESEARCH',
  'WEB_SEARCH_LANGUAGE',
  'WEB_VIDEO_MAX_CANDIDATES',
  'WEB_VIDEO_SEARCH_TIMEOUT_MS',
  'WEB_VIDEO_DEFAULT_SAFESEARCH',
  'WEB_VIDEO_DEFAULT_LANGUAGE',
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of SETTING_NAMES) delete process.env[name];
  vi.restoreAllMocks();
});

describe('search candidates', () => {
  it('canonicalizes unambiguous tracking variants into one candidate identity', () => {
    expect(
      canonicalizeCandidateUrl(
        'https://www.Publisher.Example/watch/9/?b=2&utm_source=test&a=1&fbclid=tracking#t=30',
      ),
    ).toBe('https://publisher.example/watch/9?a=1&b=2');
  });

  it('uses the canonical URL for dedupe while preserving the browser destination', () => {
    const results = normalizeSearxResults('find the red car', {
      results: [
        {
          url: 'https://www.publisher.example/watch/9/?utm_source=feed#t=30',
          title: 'Red car',
          thumbnail: 'https://img.example/car.jpg',
          engine: 'example-video',
        },
        {
          url: 'https://publisher.example/watch/9',
          title: 'Duplicate',
        },
      ],
    }, 20);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Red car',
      pageUrl: 'https://www.publisher.example/watch/9/?utm_source=feed',
      thumbnailUrl: 'https://img.example/car.jpg',
      source: 'example-video',
      query: 'find the red car',
    });
  });

  it('preserves generic source and ref parameters because they may select different content', () => {
    expect(canonicalizeCandidateUrl('https://video.example/watch?source=camera-a&ref=one')).toBe(
      'https://video.example/watch?ref=one&source=camera-a',
    );
    expect(canonicalizeCandidateUrl('https://video.example/watch?source=camera-b&ref=two')).toBe(
      'https://video.example/watch?ref=two&source=camera-b',
    );

    const results = normalizeSearxResults('q', {
      results: [
        { url: 'https://video.example/watch?source=camera-a', title: 'a' },
        { url: 'https://video.example/watch?source=camera-b', title: 'b' },
      ],
    }, 20);

    expect(results.map((row) => row.title)).toEqual(['a', 'b']);
  });

  it('keeps distinct functional query parameters distinct', () => {
    const results = normalizeSearxResults('q', {
      results: [
        { url: 'https://youtube.com/watch?v=one&utm_source=a', title: 'one' },
        { url: 'https://www.youtube.com/watch?v=two&utm_source=b', title: 'two' },
      ],
    }, 20);

    expect(results.map((row) => row.title)).toEqual(['one', 'two']);
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

describe('the guard runs on what is actually handed out', () => {
  beforeEach(() => {
    process.env.SEARXNG_URL = 'http://searx.internal';
  });

  const reply = (results: unknown[]) => {
    globalThis.fetch = vi.fn(async () => Response.json({ results })) as unknown as typeof fetch;
  };

  it('discards a result that resolves inside our own network', async () => {
    // The browser runtime navigates to whatever comes back from here, so a
    // search engine naming an internal host must not reach it.
    LOOKUP['intranet.example'] = '10.0.0.5';
    reply([
      { url: 'https://intranet.example/admin', title: 'Internal' },
      { url: 'https://publisher.example/watch/1', title: 'A clip' },
    ]);

    const candidates = await search('anything');
    expect(candidates.map((row) => row.pageUrl)).toEqual(['https://publisher.example/watch/1']);
  });

  it('discards loopback and link-local results', async () => {
    reply([
      { url: 'http://127.0.0.1/admin', title: 'Loopback' },
      { url: 'http://169.254.169.254/latest/meta-data/', title: 'Metadata' },
      { url: 'https://publisher.example/watch/1', title: 'A clip' },
    ]);

    const candidates = await search('anything');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.pageUrl).toBe('https://publisher.example/watch/1');
  });

  it('discards a result carrying credentials', async () => {
    reply([
      { url: 'https://user:pw@publisher.example/watch/1', title: 'Creds' },
      { url: 'https://publisher.example/watch/2', title: 'A clip' },
    ]);

    const candidates = await search('anything');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.pageUrl).toBe('https://publisher.example/watch/2');
  });

  it('keeps a good page but drops a thumbnail pointing inside', async () => {
    LOOKUP['thumbs.internal'] = '192.168.1.9';
    reply([
      {
        url: 'https://publisher.example/watch/1',
        title: 'A clip',
        thumbnail: 'https://thumbs.internal/pic.jpg',
      },
    ]);

    const candidates = await search('anything');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.thumbnailUrl).toBeNull();
  });

  it('keeps public thumbnails as they are', async () => {
    reply([
      {
        url: 'https://publisher.example/watch/1',
        title: 'A clip',
        thumbnail: 'https://img.example/pic.jpg',
      },
    ]);

    const candidates = await search('anything');
    expect(candidates[0]!.thumbnailUrl).toBe('https://img.example/pic.jpg');
  });
});

describe('settings a deployment already had', () => {
  const captureRequest = () => {
    const fetchMock = vi.fn(async () => Response.json({ results: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return () => new URL(String(fetchMock.mock.calls[0]![0]));
  };

  beforeEach(() => {
    process.env.SEARXNG_URL = 'http://searx.internal';
  });

  it('honours the names the old discovery path used', async () => {
    // These are the names a deployment configured before this provider
    // existed. Ignoring them would silently replace deliberate settings
    // with the defaults below.
    process.env.WEB_VIDEO_DEFAULT_SAFESEARCH = '2';
    process.env.WEB_VIDEO_DEFAULT_LANGUAGE = 'en-GB';
    process.env.WEB_VIDEO_MAX_CANDIDATES = '7';
    const requested = captureRequest();

    await search('anything');

    const url = requested();
    expect(url.searchParams.get('safesearch')).toBe('2');
    expect(url.searchParams.get('language')).toBe('en-GB');
  });

  it('prefers the new name when both are set', async () => {
    process.env.WEB_SEARCH_SAFESEARCH = '1';
    process.env.WEB_VIDEO_DEFAULT_SAFESEARCH = '2';
    process.env.WEB_SEARCH_LANGUAGE = 'fr';
    process.env.WEB_VIDEO_DEFAULT_LANGUAGE = 'en-GB';
    const requested = captureRequest();

    await search('anything');

    const url = requested();
    expect(url.searchParams.get('safesearch')).toBe('1');
    expect(url.searchParams.get('language')).toBe('fr');
  });

  it('falls back to its own defaults when neither is set', async () => {
    const requested = captureRequest();

    await search('anything');

    const url = requested();
    expect(url.searchParams.get('safesearch')).toBe('0');
    expect(url.searchParams.has('language')).toBe(false);
  });

  it('applies an old candidate ceiling to what comes back', async () => {
    process.env.WEB_VIDEO_MAX_CANDIDATES = '2';
    globalThis.fetch = vi.fn(async () => Response.json({
      results: Array.from({ length: 6 }, (_, index) => ({
        url: `https://publisher.example/watch/${index}`,
        title: String(index),
      })),
    })) as unknown as typeof fetch;

    expect(await search('anything')).toHaveLength(2);
  });
});
