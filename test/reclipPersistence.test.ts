import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The version-history rules Re-clip stands on, verified at the SQL seam.
 * The one that matters most: the original prediction is never overwritten —
 * version rows are only ever INSERTed, and the match row's own boundaries
 * appear in no UPDATE here.
 */

const queryOne = vi.fn();
const queryRows = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: (...args: unknown[]) => queryRows(...args),
}));

beforeEach(() => {
  queryOne.mockReset();
  queryRows.mockReset();
});

const match = {
  id: 'match-1',
  clipRequestId: 'request-1',
  chunkId: 'chunk-1',
  localStartSeconds: 10,
  localEndSeconds: 30,
  globalStartSeconds: 130,
  globalEndSeconds: 150,
  description: 'a moment',
  confidence: 0.9,
  source: 'visual' as const,
  quote: null,
  thumbnailKey: null,
  feedback: null,
  feedbackReason: null,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'abc123',
  reclipStatus: null,
  reclipError: null,
  createdAt: new Date('2026-08-29T00:00:00Z'),
};

describe('ensureInitialVersion', () => {
  it('copies the first-pass prediction as version 1, idempotently, and never updates', async () => {
    queryOne.mockResolvedValue(null);
    const { ensureInitialVersion } = await import('../src/db/repositories/reclips.js');

    await ensureInitialVersion(match as never);
    const [sql, params] = queryOne.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('INSERT INTO moment_versions');
    expect(sql).toContain("'initial'");
    // A second ask must be a no-op, not a duplicate and not an overwrite.
    expect(sql).toContain('ON CONFLICT (match_id, version) DO NOTHING');
    expect(sql).not.toContain('DO UPDATE');
    expect(params).toEqual(['match-1', 130, 150, 'modal', 'openbmb/MiniCPM-V-4.6', 'abc123']);
  });
});

describe('appendReclipVersion', () => {
  it('computes the next version number inside the INSERT — no racing read', async () => {
    queryOne.mockResolvedValue({
      id: 'v2',
      match_id: 'match-1',
      version: 2,
      trigger: 'reclip',
      start_seconds: '128.4',
      end_seconds: '151.2',
      provider: 'modal',
      model: 'openbmb/MiniCPM-V-4.6',
      prompt_version: 'reclip-v1',
      created_at: new Date(),
    });
    const { appendReclipVersion } = await import('../src/db/repositories/reclips.js');

    const version = await appendReclipVersion({
      matchId: 'match-1',
      startSeconds: 128.4,
      endSeconds: 151.2,
      provider: 'modal',
      model: 'openbmb/MiniCPM-V-4.6',
      promptVersion: 'reclip-v1',
    });
    const [sql] = queryOne.mock.calls[0]! as [string];
    expect(sql).toContain("COALESCE(MAX(version), 0) + 1");
    expect(sql).toContain("'reclip'");
    expect(sql).not.toContain('UPDATE');
    expect(version.version).toBe(2);
    expect(version.startSeconds).toBe(128.4);
  });
});

describe('claimReclip', () => {
  it('claims atomically: only a moment not already pending can start a run', async () => {
    queryOne.mockResolvedValue(null);
    const { claimReclip } = await import('../src/db/repositories/reclips.js');

    const claimed = await claimReclip('match-1');
    const [sql] = queryOne.mock.calls[0]! as [string];
    // Two taps race to this UPDATE; the WHERE lets exactly one through.
    expect(sql.slice(sql.indexOf('WHERE'))).toContain("reclip_status IS NULL OR reclip_status = 'failed'");
    expect(claimed).toBe(false);
  });
});

describe('markReclipFailed', () => {
  it('stores a bounded, showable message — a failure must survive a reload', async () => {
    queryOne.mockResolvedValue({});
    const { markReclipFailed } = await import('../src/db/repositories/reclips.js');

    await markReclipFailed('match-1', 'x'.repeat(600));
    const [sql, params] = queryOne.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain("reclip_status = 'failed'");
    expect((params[1] as string).length).toBe(500);
  });
});
