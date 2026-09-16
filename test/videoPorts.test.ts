import { describe, expect, it, vi } from 'vitest';
import type { VideoModelAdapter } from '../src/services/video/model.js';
import { verifyVideo, watchVideo } from '../src/services/video/model.js';
import type { FrameStreamVideoSource, StoredVideoSource } from '../src/services/video/source.js';

const stored: StoredVideoSource = {
  kind: 'stored-video', id: 'upload-1', videoUrl: 'https://example.test/video.mp4', videoKey: 'videos/upload-1.mp4',
};
const live: FrameStreamVideoSource = {
  kind: 'frame-stream', id: 'page-1',
  completion: Promise.resolve({ exhausted: true, reason: 'video ended', watchedThroughSeconds: 2 }),
  async *open() { yield { timestampMs: 1_250, durationMs: 1_000, encoding: 'jpeg', image: Buffer.from('frame') }; },
};

describe('video source/model ports', () => {
  it('passes a compatible source and query through without source-specific orchestration', async () => {
    const watch = vi.fn(async () => ({ model: 'fake-model', revision: 'r1', durationSeconds: 10, watchedThroughSeconds: 10, moments: [{ startSeconds: 1, endSeconds: 2, description: 'match' }], metrics: {} }));
    const model: VideoModelAdapter = { id: 'fake', sourceKinds: new Set(['stored-video']), watch };
    const result = await watchVideo({ model, source: stored, query: 'find the match' });
    expect(result.moments).toHaveLength(1);
    expect(watch).toHaveBeenCalledWith(expect.objectContaining({ source: stored, query: 'find the match' }));
  });

  it('forwards progressive moments through the common model port', async () => {
    const watch: VideoModelAdapter['watch'] = async ({ onMoment }) => {
      await onMoment?.({ startSeconds: 1, endSeconds: 2, description: 'live match' });
      return { model: 'fake-live', revision: 'r1', durationSeconds: 2, watchedThroughSeconds: 2, exhausted: true, moments: [{ startSeconds: 1, endSeconds: 2, description: 'live match' }], metrics: {} };
    };
    const model: VideoModelAdapter = { id: 'fake-live', sourceKinds: new Set(['frame-stream']), watch };
    const onMoment = vi.fn();
    await watchVideo({ model, source: live, query: 'find it', onMoment });
    expect(onMoment).toHaveBeenCalledWith(expect.objectContaining({ description: 'live match' }));
  });

  it('fails before a model call when the source representation is incompatible', async () => {
    const watch = vi.fn();
    const model: VideoModelAdapter = { id: 'file-only', sourceKinds: new Set(['stored-video']), watch };
    await expect(watchVideo({ model, source: live, query: 'find it' })).rejects.toThrow('file-only cannot read video source kind "frame-stream"');
    expect(watch).not.toHaveBeenCalled();
  });

  it('keeps verification behind the same model/source boundary', async () => {
    const verify = vi.fn(async () => ({ model: 'fake-model', revision: 'r1', results: [{ id: 'candidate-1', startSeconds: 3, endSeconds: 4, match: true, confidence: 0.9, description: 'verified' }], failed: [], metrics: {} }));
    const model: VideoModelAdapter = { id: 'fake', sourceKinds: new Set(['stored-video']), watch: vi.fn(), verify };
    const result = await verifyVideo({ model, source: stored, query: 'find it', candidates: [{ id: 'candidate-1', start: 3, end: 4 }] });
    expect(result.results[0]?.match).toBe(true); expect(verify).toHaveBeenCalledOnce();
  });

  it('does not pretend every watcher supports a second verification pass', async () => {
    const model: VideoModelAdapter = { id: 'watch-only', sourceKinds: new Set(['stored-video']), watch: vi.fn() };
    await expect(verifyVideo({ model, source: stored, query: 'find it', candidates: [] })).rejects.toThrow('watch-only does not expose interval verification');
  });
});
