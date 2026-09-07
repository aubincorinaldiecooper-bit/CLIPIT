import { queryOne, queryRows } from '../pool.js';

/**
 * Problems reported from inside the product. One row per report, carrying
 * the context a fix needs (see migration 042): the page, the video and the
 * question on screen, and a snapshot of what the server knew about them.
 */

export interface PlatformReportInput {
  sessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  page: string;
  message: string;
  videoId: string | null;
  clipRequestId: string | null;
  context: Record<string, unknown>;
  userAgent: string;
}

export interface PlatformReport extends PlatformReportInput {
  id: string;
  createdAt: Date;
  /** Where it went to be fixed, e.g. "github:owner/repo#12"; null while it is only here. */
  handedOffTo: string | null;
  resolvedAt: Date | null;
}

interface Row {
  id: string;
  created_at: Date;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  page: string;
  message: string;
  video_id: string | null;
  clip_request_id: string | null;
  context: Record<string, unknown>;
  user_agent: string;
  handed_off_to: string | null;
  resolved_at: Date | null;
}

function fromRow(row: Row): PlatformReport {
  return {
    id: row.id,
    createdAt: row.created_at,
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    page: row.page,
    message: row.message,
    videoId: row.video_id,
    clipRequestId: row.clip_request_id,
    context: row.context ?? {},
    userAgent: row.user_agent,
    handedOffTo: row.handed_off_to,
    resolvedAt: row.resolved_at,
  };
}

export async function recordPlatformReport(input: PlatformReportInput): Promise<PlatformReport> {
  const row = await queryOne<Row>(
    `INSERT INTO platform_reports
       (session_id, user_id, workspace_id, page, message, video_id, clip_request_id, context, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING *`,
    [
      input.sessionId, input.userId, input.workspaceId, input.page, input.message,
      input.videoId, input.clipRequestId, JSON.stringify(input.context), input.userAgent,
    ],
  );
  if (!row) throw new Error('platform report was not written');
  return fromRow(row);
}

export async function markReportHandedOff(reportId: string, handedOffTo: string): Promise<void> {
  await queryOne(`UPDATE platform_reports SET handed_off_to = $2 WHERE id = $1 RETURNING id`, [reportId, handedOffTo]);
}

/** Newest first, for the owner's reading. */
export async function listPlatformReports(limit: number): Promise<PlatformReport[]> {
  const rows = await queryRows<Row>(
    `SELECT * FROM platform_reports ORDER BY created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(fromRow);
}
