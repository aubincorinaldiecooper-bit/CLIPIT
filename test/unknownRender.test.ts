import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A render whose outcome could not be learned on its job's last attempt is
 * settled by the sweep from the row's evidence: left alone if its write
 * landed or something later has taken the row, rolled back exactly as a
 * failed render if the row has waited since — so nothing stays
 * "generating" forever. Devin's finding on #81, and two more on #83.
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
/** The row's version as the attempt's own "generating" write set it: the mark on the record. */
const MARK = 7;
/** A row not written since the attempt marked it: it has waited for a write that never came. */
const WAITING = { rowVersion: MARK };
/** A row written since the mark — by the render's own commit, or by something later that owns it now. */
const SINCE = { rowVersion: MARK + 1 };
/** For records from before the counter (035, 036): when the render was written down, and rows before and after that. */
const RECORDED_AT = new Date('2026-09-02T17:00:00Z');
const BEFORE = new Date('2026-09-02T16:59:00Z');
const AFTER = new Date('2026-09-02T17:30:00Z');
const render = (job: object, storageKey = NEW_KEY, previousStorageKey: string | null = OLD_KEY, rowVersion: number | null = MARK) =>
  ({ id: 'ur-1', clipId: 'clip-1', storageKey, previousStorageKey, job, recordedAt: RECORDED_AT, rowVersion } as never);

beforeEach(() => {
  for (const mock of [...Object.values(clips), markReclipFailed, enqueueObjectRelease]) mock.mockReset();
  clips.restoreClipBoundaries.mockResolvedValue(undefined);
  clips.setClipStatus.mockResolvedValue(true);
  markReclipFailed.mockResolvedValue(undefined);
  enqueueObjectRelease.mockResolvedValue(undefined);
});

describe('settleUnknownRender', () => {
  it('leaves a render alone whose write landed: the row names its file — read and locked through the caller\'s transaction', async () => {
    // Devin's finding on #82: a read through the pool from inside the
    // drain's transaction waits for the pool's one connection when there is
    // only one.
    const client = { query: vi.fn() } as never;
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'ready', storageKey: NEW_KEY, ...SINCE, updatedAt: AFTER });
    await expect(settleUnknownRender(render(reclipJob), log, client)).resolves.toBe('landed');
    expect(clips.getClip).toHaveBeenCalledWith('clip-1', client);
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('rolls a Re-clip back that never landed: previous boundaries and status, the failure on record — in the caller\'s transaction', async () => {
    // Devin's finding on #81: the two writes ran in their own transactions,
    // so a failure between them left the boundaries restored, the Re-clip
    // pending forever, and the next sweep reading the row as moved on.
    const client = { query: vi.fn() } as never;
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, ...WAITING, updatedAt: BEFORE });
    await expect(settleUnknownRender(render(reclipJob), log, client)).resolves.toBe('rolled_back');
    expect(clips.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' }, client);
    expect(markReclipFailed).toHaveBeenCalledWith('match-1', RECLIP_FAILED_MESSAGE, client);
  });

  it('hands objects nothing else took on record to the queue before anything else, and stops if the queue refuses', async () => {
    // Devin's finding on #81: the last attempt's unreleased objects rode on
    // the record, and settling deleted the record without queuing them.
    clips.getClip.mockResolvedValue({ id: 'clip-1', videoId: 'video-1', status: 'ready', storageKey: NEW_KEY, ...SINCE, updatedAt: AFTER });
    await expect(settleUnknownRender(render({ ...reclipJob, unresolvedKeys: [OLD_KEY, 'posters/video-1/clip-1.jpg'] }), log)).resolves.toBe('landed');
    expect(enqueueObjectRelease).toHaveBeenCalledWith([OLD_KEY, 'posters/video-1/clip-1.jpg'], { videoId: 'video-1', clipId: 'clip-1', reason: 'render_outcome_unknown' });

    enqueueObjectRelease.mockRejectedValueOnce(new Error('redis refused'));
    clips.getClip.mockResolvedValue({ id: 'clip-1', videoId: 'video-1', status: 'generating', storageKey: OLD_KEY, ...WAITING, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ ...reclipJob, unresolvedKeys: [OLD_KEY] }), log)).rejects.toThrow('redis refused');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
  });

  it('hands a Replace that never landed its previous file back, with the failure to report', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, ...WAITING, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1', captions: [] }), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);
  });

  it('marks a first render that never landed as failed', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: null, ...WAITING, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, null), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'failed', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);
  });

  it('does not mistake a retried first render for landed because the row already named its plain key', async () => {
    // Devin's finding on #81: the key proves nothing when the row had it
    // before the attempt; the row's version and status are the evidence.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, ...WAITING, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);

    clips.setClipStatus.mockClear();
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'ready', storageKey: OLD_KEY, ...SINCE, updatedAt: AFTER });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('trusts the status alone for a record with no previous key — one the 035 code wrote before the column existed', async () => {
    // Devin's finding on #82: a null previous key made an unchanged plain
    // key look new, and a retried first render that never landed would
    // have been read as landed. Such a record carries no mark either.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, rowVersion: 3, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, null, null), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);

    clips.setClipStatus.mockClear();
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'ready', storageKey: NEW_KEY, rowVersion: 3, updatedAt: BEFORE });
    await expect(settleUnknownRender(render(reclipJob, NEW_KEY, null, null), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('a landed render whose row has since taken a newer render is still landed — never rolled back over it', async () => {
    // Codex's finding on #83: a landed render's row is ready and can take a
    // Replace or a Re-clip before the sweep runs, which makes it generating
    // again with this render's file still on it; the status alone would
    // have rolled the newer render back.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: NEW_KEY, ...SINCE, updatedAt: AFTER });
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('landed');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('leaves a row alone that something took between the attempt and the record: a first render that landed and took a Replace before it was written down', async () => {
    // Devin's first finding on #83: the record is written after the
    // re-reads and their retries, so a Replace or Re-clip that a LANDED
    // render's row took in between was older than the record and looked
    // like a row that had waited; with a key that proves nothing (a first
    // render at its plain key) the newer render was rolled back. The mark
    // is the row's version as the attempt set it; the row has moved past.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'pending', storageKey: OLD_KEY, ...SINCE, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, null), log)).resolves.toBe('moved_on');
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, ...SINCE, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(markReclipFailed).not.toHaveBeenCalled();
  });

  it('orders the writes by the counter, never by a time: a Replace that reached the row after the mark with an older time is still later', async () => {
    // Devin's second finding on #83: now() is a transaction's START, so a
    // Replace whose write began a hair before the attempt's "generating"
    // write and reached the row after it lands with the older time. The
    // counter is bumped against the row as it stands when the write takes
    // effect, so it has moved past the mark.
    const beforeTheMark = new Date('2026-09-02T16:00:00Z');
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'pending', storageKey: OLD_KEY, ...SINCE, updatedAt: beforeTheMark });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('rolls back only a row whose counter has not moved since the mark, whatever any time says', async () => {
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, ...WAITING, updatedAt: AFTER });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY), log)).resolves.toBe('rolled_back');
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, undefined);
  });

  it('reads a record from before the counter against the time it was recorded — the best it has', async () => {
    // Records the 035 and 036 code wrote carry no mark.
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, rowVersion: 3, updatedAt: BEFORE });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY, null), log)).resolves.toBe('rolled_back');
    clips.setClipStatus.mockClear();
    clips.getClip.mockResolvedValue({ id: 'clip-1', status: 'generating', storageKey: OLD_KEY, rowVersion: 3, updatedAt: AFTER });
    await expect(settleUnknownRender(render({ clipId: 'clip-1' }, OLD_KEY, OLD_KEY, null), log)).resolves.toBe('moved_on');
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });

  it('leaves a row alone that has moved on since, and one whose clip is gone', async () => {
    clips.getClip.mockResolvedValueOnce({ id: 'clip-1', status: 'ready', storageKey: 'clips/video-1/clip-1-later.mp4', ...SINCE, updatedAt: AFTER });
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('moved_on');
    clips.getClip.mockResolvedValueOnce(null);
    await expect(settleUnknownRender(render(reclipJob), log)).resolves.toBe('gone');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalled();
  });
});
