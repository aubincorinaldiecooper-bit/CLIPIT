import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drain of unknown renders: the settling runs inside the drain's
 * transaction with its client, and the row goes only in that same
 * transaction — so a settling that fails leaves the row for the next sweep.
 */

const client = { query: vi.fn() };
vi.mock('../src/db/pool.js', () => ({
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(client),
  queryOne: vi.fn(),
}));

const { drainUnknownRenders } = await import('../src/db/repositories/unknownRenders.js');

const recordedAt = new Date('2026-09-02T17:00:00Z');
const row = { id: 'ur-1', clip_id: 'clip-1', storage_key: 'clips/video-1/clip-1-0ddba11a.mp4', previous_storage_key: 'clips/video-1/clip-1.mp4', row_version: 7, job: { clipId: 'clip-1' }, created_at: recordedAt };

beforeEach(() => {
  client.query.mockReset();
  client.query.mockImplementation(async (sql: string) => (sql.includes('SELECT') ? { rows: [row] } : { rows: [] }));
});

describe('drainUnknownRenders', () => {
  it('settles each row with the transaction\'s client, then deletes it', async () => {
    const settle = vi.fn(async () => undefined);
    await expect(drainUnknownRenders(10, settle)).resolves.toBe(1);
    expect(settle).toHaveBeenCalledWith(
      { id: 'ur-1', clipId: 'clip-1', storageKey: row.storage_key, previousStorageKey: row.previous_storage_key, job: row.job, recordedAt, rowVersion: 7 },
      client,
    );
    const deletes = client.query.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(settle.mock.invocationCallOrder[0]!).toBeLessThan(client.query.mock.invocationCallOrder[1]!);
  });

  it('deletes nothing when the settling fails: the transaction rejects and the row stays', async () => {
    const settle = vi.fn(async () => { throw new Error('match table locked'); });
    await expect(drainUnknownRenders(10, settle)).rejects.toThrow('match table locked');
    expect(client.query.mock.calls.filter(([sql]) => String(sql).startsWith('DELETE'))).toHaveLength(0);
  });
});
