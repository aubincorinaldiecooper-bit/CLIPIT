import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rules the evaluation layer's rows depend on, verified at the SQL seam:
 * what these repository functions actually send to the database. The tests
 * mock the pool, not the functions — a regression that stops a reason being
 * cleared, starts overwriting a prediction, or drops attribution changes the
 * statement or its parameters, and these assertions are shaped to catch
 * exactly that.
 */

const queryOne = vi.fn();
const queryRows = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: (...args: unknown[]) => queryRows(...args),
}));

const matchRow = {
  id: 'match-1',
  clip_request_id: 'request-1',
  chunk_id: 'chunk-1',
  local_start_seconds: 1,
  local_end_seconds: 2,
  global_start_seconds: 1,
  global_end_seconds: 2,
  description: 'a moment',
  confidence: 0.9,
  source: 'visual',
  quote: null,
  thumbnail_key: null,
  feedback: 'rejected',
  feedback_reason: 'missed_moment',
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  prompt_version: 'abc123def456',
  created_at: new Date('2026-08-30T00:00:00Z'),
};

beforeEach(() => {
  queryOne.mockReset();
  queryRows.mockReset();
});

describe('setMatchFeedback', () => {
  it('stores the reason only alongside a rejection', async () => {
    queryOne.mockResolvedValue(matchRow);
    const { setMatchFeedback } = await import('../src/db/repositories/clipRequests.js');

    await setMatchFeedback('request-1', 'match-1', 'rejected', 'missed_moment');
    expect(queryOne.mock.calls[0]![1]).toEqual(['request-1', 'match-1', 'rejected', 'missed_moment']);
  });

  it('drops a reason handed in with an approval — that state must not exist', async () => {
    queryOne.mockResolvedValue({ ...matchRow, feedback: 'approved', feedback_reason: null });
    const { setMatchFeedback } = await import('../src/db/repositories/clipRequests.js');

    await setMatchFeedback('request-1', 'match-1', 'approved', 'missed_moment');
    expect(queryOne.mock.calls[0]![1]).toEqual(['request-1', 'match-1', 'approved', null]);
  });

  it('clearing the verdict clears the reason with it', async () => {
    queryOne.mockResolvedValue({ ...matchRow, feedback: null, feedback_reason: null });
    const { setMatchFeedback } = await import('../src/db/repositories/clipRequests.js');

    await setMatchFeedback('request-1', 'match-1', null, 'missed_moment');
    expect(queryOne.mock.calls[0]![1]).toEqual(['request-1', 'match-1', null, null]);
  });

  it('surfaces the stored reason and attribution on the way back out', async () => {
    queryOne.mockResolvedValue(matchRow);
    const { setMatchFeedback } = await import('../src/db/repositories/clipRequests.js');

    const match = await setMatchFeedback('request-1', 'match-1', 'rejected', 'missed_moment');
    expect(match?.feedbackReason).toBe('missed_moment');
    expect(match?.provider).toBe('modal');
    expect(match?.model).toBe('openbmb/MiniCPM-V-4.6');
    expect(match?.promptVersion).toBe('abc123def456');
  });
});

describe('insertMatches attribution', () => {
  it('writes provider, model and prompt version with every row', async () => {
    queryRows.mockResolvedValue([matchRow]);
    const { insertMatches } = await import('../src/db/repositories/clipRequests.js');

    await insertMatches('request-1', [
      {
        chunkId: 'chunk-1',
        localStartSeconds: 1,
        localEndSeconds: 2,
        globalStartSeconds: 1,
        globalEndSeconds: 2,
        description: 'a moment',
        confidence: 0.9,
        source: 'visual',
        quote: null,
        provider: 'modal',
        model: 'openbmb/MiniCPM-V-4.6',
        promptVersion: 'abc123def456',
      },
    ]);

    const [sql, params] = queryRows.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('provider, model, prompt_version');
    expect(params).toContain('modal');
    expect(params).toContain('openbmb/MiniCPM-V-4.6');
    expect(params).toContain('abc123def456');
  });

  it('stores NULL attribution for a caller that has none, never a guess', async () => {
    queryRows.mockResolvedValue([matchRow]);
    const { insertMatches } = await import('../src/db/repositories/clipRequests.js');

    await insertMatches('request-1', [
      {
        chunkId: 'chunk-1',
        localStartSeconds: 1,
        localEndSeconds: 2,
        globalStartSeconds: 1,
        globalEndSeconds: 2,
        description: 'a moment',
        confidence: 0.9,
        source: 'visual',
      },
    ]);

    const [, params] = queryRows.mock.calls[0]! as [string, unknown[]];
    // The last three parameters of the single row are the attribution slots.
    expect(params.slice(-3)).toEqual([null, null, null]);
  });
});

describe('clip boundary persistence', () => {
  const clipRow = {
    id: 'clip-1',
    video_id: 'video-1',
    clip_match_id: 'match-1',
    session_id: null,
    user_id: 'user-1',
    workspace_id: null,
    captions: null,
    derived_from_clip_id: null,
    focus_pct: 50,
    start_seconds: 8,
    end_seconds: 21,
    predicted_start_seconds: 10,
    predicted_end_seconds: 20,
    boundaries_edited_at: new Date('2026-08-30T01:00:00Z'),
    storage_key: null,
    status: 'pending',
    error_message: null,
    duration_seconds: null,
    size_bytes: null,
    created_at: new Date('2026-08-30T00:00:00Z'),
    updated_at: new Date('2026-08-30T01:00:00Z'),
  };

  it('setClipBoundaries never touches the prediction columns', async () => {
    queryOne.mockResolvedValue(clipRow);
    const { setClipBoundaries } = await import('../src/db/repositories/clips.js');

    await setClipBoundaries('clip-1', 8, 21);
    const [sql] = queryOne.mock.calls[0]! as [string];
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
    // The one write predicted_* must never see. If someone adds it to this
    // statement, timestamp accuracy loses its ground truth silently.
    expect(setClause).not.toContain('predicted_start_seconds');
    expect(setClause).not.toContain('predicted_end_seconds');
    expect(setClause).toContain('boundaries_edited_at = now()');
  });

  it('setClipBoundaries refuses captioned copies at the SQL level', async () => {
    queryOne.mockResolvedValue(null);
    const { setClipBoundaries } = await import('../src/db/repositories/clips.js');

    const result = await setClipBoundaries('derived-clip', 8, 21);
    const [sql] = queryOne.mock.calls[0]! as [string];
    expect(sql).toContain('derived_from_clip_id IS NULL');
    expect(result).toBeNull();
  });

  it('regenerating a match keeps boundaries someone has already moved', async () => {
    queryOne.mockResolvedValue(clipRow);
    const { upsertClipForMatch } = await import('../src/db/repositories/clips.js');

    await upsertClipForMatch({
      videoId: 'video-1',
      clipMatchId: 'match-1',
      sessionId: null,
      userId: 'user-1',
      startSeconds: 10,
      endSeconds: 20,
    });

    const [sql] = queryOne.mock.calls[0]! as [string];
    // The conflict branch must guard both boundary writes behind "was never
    // edited", and must not list predicted_* at all.
    const conflict = sql.slice(sql.indexOf('ON CONFLICT'));
    expect(conflict).toContain("start_seconds = CASE WHEN clips.boundaries_edited_at IS NULL");
    expect(conflict).toContain("end_seconds = CASE WHEN clips.boundaries_edited_at IS NULL");
    expect(conflict).not.toContain('predicted_start_seconds =');
    expect(conflict).not.toContain('predicted_end_seconds =');
  });

  it('a new clip freezes the prediction from the same values it renders', async () => {
    queryOne.mockResolvedValue(clipRow);
    const { upsertClipForMatch } = await import('../src/db/repositories/clips.js');

    await upsertClipForMatch({
      videoId: 'video-1',
      clipMatchId: 'match-1',
      sessionId: null,
      userId: 'user-1',
      startSeconds: 10,
      endSeconds: 20,
    });

    const [sql] = queryOne.mock.calls[0]! as [string];
    expect(sql).toContain('predicted_start_seconds, predicted_end_seconds');
    const insertClause = sql.slice(0, sql.indexOf('ON CONFLICT'));
    // Rendered bounds and predicted bounds come from the same two params.
    expect(insertClause).toContain('$5, $6, $5, $6');
  });
});

describe('recordModelUsage', () => {
  it('persists Modal metrics, departure time and prompt version when given', async () => {
    queryOne.mockResolvedValue({});
    const { recordModelUsage } = await import('../src/db/repositories/usage.js');

    const startedAt = new Date('2026-08-30T02:00:00Z');
    await recordModelUsage({
      videoId: 'video-1',
      provider: 'modal',
      model: 'openbmb/MiniCPM-V-4.6',
      stage: 'search',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: null,
      latencyMs: 41_000,
      metrics: { download_ms: 2000, inference_ms: 38_000, total_ms: 40_500 },
      startedAt,
      promptVersion: 'abc123def456',
    });

    const [sql, params] = queryOne.mock.calls[0]! as [string, unknown[]];
    expect(sql).toContain('metrics, started_at, prompt_version');
    expect(params).toContain(JSON.stringify({ download_ms: 2000, inference_ms: 38_000, total_ms: 40_500 }));
    expect(params).toContain(startedAt);
    expect(params).toContain('abc123def456');
  });

  it('writes NULLs, not fabrications, when a provider measured nothing', async () => {
    queryOne.mockResolvedValue({});
    const { recordModelUsage } = await import('../src/db/repositories/usage.js');

    await recordModelUsage({
      provider: 'openrouter.ai',
      model: 'qwen/qwen3.6-flash',
      stage: 'search',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });

    const [, params] = queryOne.mock.calls[0]! as [string, unknown[]];
    expect(params.slice(-3)).toEqual([null, null, null]);
  });
});
