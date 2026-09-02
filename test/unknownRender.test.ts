import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A render whose outcome could not be learned on its job's last attempt is
 * settled by the sweep from the row's evidence: left alone if its write
 * landed, rolled back exactly as a failed render if it did not — so
 * nothing stays "generating" forever. Devin's finding on #81.
 */

const clips = { getClip: vi.fn(), restoreClipBoundaries: vi.fn(), setClipStatus: vi.fn() };
const markReclipFailed = vi.fn();
const enqueueObjectRelease = vi.fn();
vi.mock('../src/db/repositories/clips.js', () => clips);
vi.mock('../src/db/repositories/reclips.js', () => ({ markReclipFailed }));
vi.mock('../src/queues/index.js', () => ({ enqueueObjectRelease }));

const { settleUnknownRender, RECLIP_FAILED_MESSAGE, RENDER_FAILED_MESSAGE } = await import('../src/services/media/unknownRender.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const NEW_KEY = 'clips/video-1/clip-1-0ddba11a.mp4';
const OLD_KEY = 'clips/video-1/clip-1.mp4';
const reclipJob = {
  clipId: 'clip-1',
  reclip: {
    matchId: 'match-1', startSeconds: 128, endSeconds: 151, provider: 'modal', model: 'm', promptVersion: 'v1',
    previous: { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' as const },
  },
};
const render = (job: object, storageKey = NEW_KEY, previousStorageKey: string | null = OLD_KEY) =>
  ({ id: 'ur-1', clipId: 'clip-1', storageKey, previousStorageKey, job } as never);

beforeEach(() => {
  for (const mock of [...Object.values(clips), markReclipFailed, enqueueObjectRelease]) mock.mockReset();
  clips.restoreClipBoundaries.mockResolvedValue(undefined);
  clips.setClipStatus.mockResolvedValue(true);
  markReclipFailed.mockResolvedValue(undefined);
  enqueueObjectRelease.mockResolvedValue(undefined);
});

describe('settleUnknownRender', () => {
  it('leaves a render alone whose write landed: the row names its file', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'ready', storageKey: NEW_KEY });
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('landed');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('rolls a Re-clip back that never landed: previous boundaries and status, the failure on record — in the caller\'s transaction', async () => {
    // Devin's finding on #81: the two writes ran in their own transactions,
    // so a failure between them left the boundaries restored, the Re-clip
    // pending forever, and the next sweep reading the row as moved on.
    const client = { query: vi.fn() } as never;
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY });
    await expect(settleUnknownRender(render(reclipJob), log, client)).resolves.toBe('rolled_back');
    expect(clips.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' }, client);
    expect(markReclipFailed).toHaveBeenCalledWith('match-1', RECLIP_FAILED_MESSAGE, client);
  });

  it('hands objects nothing else took on record to the queue before anything else, and stops if the queue refuses', async () => {
    // Devin's finding on #81: the last attempt's unreleased objects rode on
    // the record, and settling deleted the record without queuing them.
    clips.getClip.mockResolvedValue({ id: 'clip-1', videoId: 'video-1', status: 'ready', storageKey: NEW_KEY });
    await expect(settleUnknownRender(render({ ...reclipJob, unresolvedKeys: [OLD_KEY, 'posters/video-1/clip-1.jpg'] }), log)).resolves.toBe('landed');
    expect(enqueueObjectRelease).toHaveBeenCalledWith([OLD_KEY, 'posters/video-1/clip-1.jpg'], { videoId: 'video-1', clipId: 'clip-1', reason: 'render_outcome_unknown' });

    enqueueObjectRelease.mockRejectedValueOnce(new Error('redis refused'));
    clips.getClip.mockResolvedValue({ id: 'clip-1', videoId: 'video-1', status: 'generating', storageKey: OLD_KEY });
    await expect(settleUnknownRender(render({ ...reclipJob, unresolvedKeys: [OLD_KEY] }), log)).rejects.toThrow('redis refused');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
  });

  it('hands a Replace that never landed its previous file back, with the failure to report', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY });
    await expect(settleUnknownRender(render({ clipId: 'clip-1', captions: [] }), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);
  });

  it('marks a first render that never landed as failed', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: null });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, null), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'failed', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);
  });

  it('does not mistake a retried first render for landed because the row already named its plain key', async () => {
    // Devin's finding on #81: the key proves nothing when the row had it
    // before the attempt; the status is the evidence there.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);

    clips.setClipStatus.mockClear();
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'ready', storageKey: OLD_KEY });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('leaves a row alone that has moved on since, and one whose clip is gone', async () => {
    clips.getClip.mockResolvedValueOnce({ id: 'clip-1', status: 'ready', storageKey: 'clips/video-1/clip-1-later.mp4' });
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('moved_on');
    clips.getClip.mockResolvedValueOnce(null);
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('gone');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });
});
