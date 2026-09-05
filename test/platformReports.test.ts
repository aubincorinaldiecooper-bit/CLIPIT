import { describe, expect, it } from 'vitest';
import { formatIssue, reportSchema, snapshotContext } from '../src/services/reports/platformReports.js';
import type { PlatformReport } from '../src/db/repositories/platformReports.js';

/**
 * A report made from the page carries the context a fix needs — and only
 * ids and states, never an address or a name.
 */

const report = (over: Partial<PlatformReport> = {}): PlatformReport => ({
  id: 'r-1',
  createdAt: new Date('2026-09-05T03:08:44Z'),
  sessionId: 'sess-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  page: '/start',
  message: 'I kept video 4 and it never cut.\nThe card just said cutting.',
  videoId: 'v-1',
  clipRequestId: 'q-1',
  context: {},
  userAgent: 'Safari/17',
  handedOffTo: null,
  resolvedAt: null,
  ...over,
});

describe('reportSchema', () => {
  it('needs words, trims them, and caps them', () => {
    expect(reportSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(reportSchema.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);
    const parsed = reportSchema.parse({ message: '  the clip never cut  ', page: '/start' });
    expect(parsed.message).toBe('the clip never cut');
    expect(parsed.videoId).toBeUndefined();
    expect(parsed.userAgent).toBe('');
  });

  it('takes ids only as ids', () => {
    expect(reportSchema.safeParse({ message: 'x', videoId: 'not-a-uuid' }).success).toBe(false);
    expect(reportSchema.safeParse({ message: 'x', videoId: null, clipRequestId: null }).success).toBe(true);
  });
});

describe('snapshotContext', () => {
  it('copies the states a fix needs and nothing else', () => {
    const snapshot = snapshotContext({
      viewport: '1280x800',
      video: { id: 'v-1', status: 'ready', errorMessage: null, durationSeconds: 765.9, width: 4096, height: 2160, indexStatus: 'ready', transcriptStatus: 'ready', ownerEmail: 'x@y' } as never,
      clipRequest: { id: 'q-1', instruction: 'top 5 funniest moments', status: 'completed', errorMessage: null, resolvedMode: 'visual', answeredFrom: 'notes', requestedResultCount: 5, availableCandidateCount: 4, effectiveDeckTarget: 4 },
      clips: [{ id: 'c-1', clipMatchId: 'm-1', status: 'generating', errorMessage: null, presentation: 'vertical', derivativeStatus: 'pending' }],
    });
    expect(snapshot.video).toEqual({ id: 'v-1', status: 'ready', error: null, durationSeconds: 765.9, width: 4096, height: 2160, indexStatus: 'ready', transcriptStatus: 'ready' });
    expect(snapshot.clipRequest?.requestedResultCount).toBe(5);
    expect(snapshot.clips).toEqual([{ id: 'c-1', matchId: 'm-1', status: 'generating', error: null, presentation: 'vertical', derivativeStatus: 'pending' }]);
    expect(JSON.stringify(snapshot)).not.toContain('x@y');
  });

  it('is honest about nothing on screen', () => {
    expect(snapshotContext({ viewport: '', video: null, clipRequest: null, clips: [] })).toEqual({ viewport: '', video: null, clipRequest: null, clips: [] });
  });
});

describe('formatIssue', () => {
  it('leads with the words, then where and what, and names no person', () => {
    const issue = formatIssue(report({
      context: snapshotContext({
        viewport: '1280x800',
        video: { id: 'v-1', status: 'ready', errorMessage: null, durationSeconds: 765.9, width: 4096, height: 2160, indexStatus: 'ready', transcriptStatus: 'ready' },
        clipRequest: { id: 'q-1', instruction: 'top 5 funniest moments', status: 'completed', errorMessage: null, resolvedMode: 'visual', answeredFrom: 'notes', requestedResultCount: 5, availableCandidateCount: 4, effectiveDeckTarget: 4 },
        clips: [{ id: 'c-1', clipMatchId: 'm-1', status: 'failed', errorMessage: 'ffmpeg exited 1', presentation: 'vertical', derivativeStatus: 'failed' }],
      }) as unknown as Record<string, unknown>,
    }));
    expect(issue.title).toBe('Report: I kept video 4 and it never cut.');
    expect(issue.body).toContain('> I kept video 4 and it never cut.');
    expect(issue.body).toContain('> The card just said cutting.');
    expect(issue.body).toContain('- Page: `/start`');
    expect(issue.body).toContain('- Asked: "top 5 funniest moments"');
    expect(issue.body).toContain('asked 5, found 4, shown 4');
    expect(issue.body).toContain('`c-1` (moment `m-1`): failed — ffmpeg exited 1');
    expect(issue.body).not.toMatch(/@/);
  });

  it('shortens a long first line into the title', () => {
    const issue = formatIssue(report({ message: 'a'.repeat(100) }));
    expect(issue.title.length).toBeLessThanOrEqual('Report: '.length + 72);
    expect(issue.title.endsWith('…')).toBe(true);
  });
});
