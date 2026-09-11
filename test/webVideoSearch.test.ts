import { describe, expect, it } from 'vitest';
import {
  canonicalizeVideoUrl,
  classifyVideoPlatform,
  mergeDiscoveredCandidates,
} from '../src/services/webSearch/normalize.js';
import type { ProviderVideoResult } from '../src/services/webSearch/types.js';

function result(url: string, rank = 1, title = 'example'): ProviderVideoResult {
  return {
    url,
    title,
    description: null,
    thumbnailUrl: null,
    duration: null,
    views: null,
    creator: null,
    publisher: null,
    publishedAt: null,
    age: null,
    requiresSubscription: null,
    rank,
  };
}

describe('web video URL normalization', () => {
  it('removes fragments and common tracking parameters without changing the source URL path', () => {
    expect(
      canonicalizeVideoUrl('https://www.youtube.com/watch?v=abc123&utm_source=test&fbclid=tracking#comments'),
    ).toEqual({
      canonicalUrl: 'https://youtube.com/watch?v=abc123',
      hostname: 'youtube.com',
    });
  });

  it('classifies the main video platforms without pretending an unknown host is supported', () => {
    expect(classifyVideoPlatform('youtube.com')).toBe('youtube');
    expect(classifyVideoPlatform('vm.tiktok.com')).toBe('tiktok');
    expect(classifyVideoPlatform('instagram.com')).toBe('instagram');
    expect(classifyVideoPlatform('x.com')).toBe('x');
    expect(classifyVideoPlatform('example.com')).toBe('other');
  });

  it('does not classify lookalike domains as a known video platform', () => {
    expect(classifyVideoPlatform('notyoutube.com')).toBe('other');
    expect(classifyVideoPlatform('eviltiktok.com')).toBe('other');
    expect(classifyVideoPlatform('fakeinstagram.com')).toBe('other');
    expect(classifyVideoPlatform('notfacebook.com')).toBe('other');
    expect(classifyVideoPlatform('copyvimeo.com')).toBe('other');
  });
});

describe('web video result merging', () => {
  it('deduplicates the same canonical URL across subqueries and preserves query coverage', () => {
    const merged = mergeDiscoveredCandidates([
      {
        provider: 'brave-video',
        query: 'humanoid robots at work',
        results: [result('https://youtube.com/watch?v=robot&utm_source=a', 3)],
      },
      {
        provider: 'brave-video',
        query: 'humanoid robots warehouse',
        results: [result('https://www.youtube.com/watch?v=robot#watch', 1)],
      },
    ]);

    expect(merged.duplicatesRemoved).toBe(1);
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]).toMatchObject({
      canonicalUrl: 'https://youtube.com/watch?v=robot',
      platform: 'youtube',
      rank: 1,
      evidenceStatus: 'unverified_search_result',
      analyzed: false,
      access: { status: 'discovered_only', ingestible: false },
    });
    expect(merged.candidates[0]!.discoveredBy).toEqual([
      'humanoid robots at work',
      'humanoid robots warehouse',
    ]);
  });

  it('ranks candidates found by more independent queries before one-off results', () => {
    const merged = mergeDiscoveredCandidates([
      {
        provider: 'brave-video',
        query: 'q1',
        results: [result('https://vimeo.com/one', 1), result('https://vimeo.com/two', 2)],
      },
      {
        provider: 'brave-video',
        query: 'q2',
        results: [result('https://vimeo.com/two', 8)],
      },
    ]);

    expect(merged.candidates.map((candidate) => candidate.canonicalUrl)).toEqual([
      'https://vimeo.com/two',
      'https://vimeo.com/one',
    ]);
  });
});
