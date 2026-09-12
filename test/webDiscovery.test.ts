import { describe, expect, it } from 'vitest';
import { looksLikePlayableMedia, normalizeSearxResults } from '../src/services/retrieval/webDiscovery.js';

describe('web video discovery', () => {
  it('recognizes direct media without treating ordinary pages as playable', () => {
    expect(looksLikePlayableMedia('https://cdn.example.com/video.mp4?token=abc')).toBe(true);
    expect(looksLikePlayableMedia('https://cdn.example.com/master.m3u8')).toBe(true);
    expect(looksLikePlayableMedia('https://example.com/watch/123')).toBe(false);
  });

  it('normalizes and deduplicates SearXNG results', () => {
    const results = normalizeSearxResults('find the red car', {
      results: [
        {
          url: 'https://cdn.example.com/car.mp4#fragment',
          title: 'Car',
          thumbnail: 'https://img.example.com/car.jpg',
          engine: 'example-video',
        },
        {
          url: 'https://cdn.example.com/car.mp4',
          title: 'Duplicate',
        },
        {
          url: 'https://publisher.example/watch/9',
          title: 'Page result',
          engines: ['another-video'],
        },
        { url: 'javascript:alert(1)', title: 'invalid' },
      ],
    }, 20);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Car',
      pageUrl: 'https://cdn.example.com/car.mp4',
      mediaUrl: 'https://cdn.example.com/car.mp4',
      resolvedBy: 'direct',
      source: 'example-video',
    });
    expect(results[1]).toMatchObject({
      pageUrl: 'https://publisher.example/watch/9',
      mediaUrl: null,
      resolvedBy: 'unresolved',
      source: 'another-video',
    });
  });

  it('respects the candidate ceiling', () => {
    const results = normalizeSearxResults('query', {
      results: Array.from({ length: 10 }, (_, index) => ({
        url: `https://example.com/watch/${index}`,
        title: String(index),
      })),
    }, 3);
    expect(results).toHaveLength(3);
  });
});
