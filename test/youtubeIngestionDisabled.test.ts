import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { IngestionJob } from '../src/queues/index.js';

/**
 * With YouTube ingestion off, a job for a YouTube row must fail with the
 * reason a person can act on — "upload the file instead" — and must never
 * reach yt-dlp, which is not installed when the feature is off.
 */

const video = {
  id: 'video-1',
  status: 'queued',
  sourceType: 'youtube',
  sourceUrl: 'https://youtube.com/watch?v=abc',
  originalStorageKey: null,
};

const setVideoStatus = vi.fn(async () => {});
const fetchYoutubeMetadata = vi.fn();
const downloadYoutubeVideo = vi.fn();
const enqueuePreprocessing = vi.fn(async () => {});

vi.mock('../src/db/repositories/videos.js', () => ({
  getVideo: async () => video,
  setVideoStatus: (...args: unknown[]) => setVideoStatus(...(args as [])),
  updateVideoMedia: async () => {},
}));

vi.mock('../src/services/media/ytdlp.js', () => ({
  fetchYoutubeMetadata,
  downloadYoutubeVideo,
}));

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ head: async () => null, upload: async () => {} }),
}));

vi.mock('../src/queues/index.js', () => ({
  enqueuePreprocessing,
}));

const { handleIngestion } = await import('../src/worker/handlers/ingestion.js');

function ingestionJob(): Job<IngestionJob> {
  return {
    data: { videoId: video.id },
    updateProgress: async () => {},
  } as unknown as Job<IngestionJob>;
}

describe('YouTube ingestion while disabled', () => {
  it('refuses the job and never calls yt-dlp', async () => {
    await expect(handleIngestion(ingestionJob())).rejects.toThrow(/upload the video file instead/);

    expect(fetchYoutubeMetadata).not.toHaveBeenCalled();
    expect(downloadYoutubeVideo).not.toHaveBeenCalled();
    expect(enqueuePreprocessing).not.toHaveBeenCalled();
  });

  it('records the reason on the video, so the person is told rather than left waiting', () => {
    expect(setVideoStatus).toHaveBeenCalledWith(
      video.id,
      'failed',
      expect.stringContaining('upload the video file instead'),
    );
  });
});
