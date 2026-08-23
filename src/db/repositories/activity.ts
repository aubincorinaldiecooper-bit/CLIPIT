import { queryOne } from '../pool.js';

/**
 * What the caller has actually done here, counted from their own rows.
 *
 * These numbers go on the home screen, so the same discipline applies as in
 * the performance log: every figure is a count of things that happened, owned
 * by the person (or, for a guest, the tab) asking. Nothing aggregate, nothing
 * estimated, nothing about anyone else.
 */
export interface ActivitySummary {
  videos: number;
  minutesOfVideo: number;
  questionsAnswered: number;
  clipsCut: number;
}

export async function summariseActivity(principal: {
  sessionId: string | null;
  userId: string | null;
  workspaceId?: string | null;
}): Promise<ActivitySummary> {
  // The numbers count the room's work — the same rows the library lists, so
  // the home screen and the library never disagree about what "ours" means.
  const scope = principal.workspaceId
    ? 'workspace_id = $1'
    : principal.userId
      ? 'user_id = $1'
      : 'session_id = $1';
  const owner = principal.workspaceId ?? principal.userId ?? principal.sessionId;
  if (!owner) return { videos: 0, minutesOfVideo: 0, questionsAnswered: 0, clipsCut: 0 };

  const [videos, questions, clips] = await Promise.all([
    queryOne<{ count: number; seconds: string | null }>(
      `SELECT count(*)::int AS count, COALESCE(SUM(duration_seconds), 0) AS seconds
         FROM videos WHERE ${scope}`,
      [owner],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM clip_requests WHERE ${scope} AND status = 'completed'`,
      [owner],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM clips WHERE ${scope} AND status = 'ready'`,
      [owner],
    ),
  ]);

  return {
    videos: videos?.count ?? 0,
    minutesOfVideo: Math.round(Number(videos?.seconds ?? 0) / 60),
    questionsAnswered: questions?.count ?? 0,
    clipsCut: clips?.count ?? 0,
  };
}
