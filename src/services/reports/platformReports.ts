import { z } from 'zod';
import { env } from '../../config/env.js';
import type { PlatformReport } from '../../db/repositories/platformReports.js';

/**
 * A report of a problem with Clipit, made from the page it happened on.
 *
 * The report's job is to be fixable without a search through the logs by
 * the clock: it carries the page, the video and the question on screen,
 * and a snapshot of what the server knew about them when it was made. Ids
 * and states only — never an address or a name.
 *
 * Where it goes to be fixed is configuration. With GITHUB_REPORTS_REPO and
 * GITHUB_REPORTS_TOKEN set, each report is filed as an issue in that
 * repository, labelled `platform-report`, where an agent or a person picks
 * it up. Unset, it stays in the database and the log, and the owner's
 * listing shows it.
 */

/** The most a report may say, counted the way a person counts. */
export const MAX_MESSAGE_CHARACTERS = 2000;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Characters as a person counts them: an emoji, a flag or an accented
 * letter is one. The product's report box shows this count beside its
 * limit, so the server has to count the same way — measured in storage
 * units instead, "1,998 of 2,000" on the box could be refused here as over.
 */
export function charactersIn(text: string): number {
  let count = 0;
  for (const _ of graphemes.segment(text)) count += 1;
  return count;
}

export const reportSchema = z.object({
  // The outer bound is storage: one perceived character can carry many
  // units (a joined emoji is eleven), and a string of combining marks is
  // one character of any length. The inner bound is the one the person sees.
  message: z
    .string()
    .trim()
    .min(1, 'Say what went wrong.')
    .max(20_000)
    .refine((text) => charactersIn(text) <= MAX_MESSAGE_CHARACTERS, `Say it in ${MAX_MESSAGE_CHARACTERS} characters or fewer.`),
  page: z.string().trim().max(500).default(''),
  videoId: z.string().uuid().nullish(),
  clipRequestId: z.string().uuid().nullish(),
  userAgent: z.string().trim().max(500).default(''),
  viewport: z.string().trim().max(40).default(''),
});

export type ReportBody = z.infer<typeof reportSchema>;

/** What the server knew about the video and the question, as the report was made. */
export interface ReportContextSnapshot {
  viewport: string;
  video: {
    id: string;
    status: string;
    error: string | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    indexStatus: string | null;
    transcriptStatus: string | null;
  } | null;
  clipRequest: {
    id: string;
    instruction: string;
    status: string;
    error: string | null;
    resolvedMode: string | null;
    answeredFrom: string | null;
    requestedResultCount: number | null;
    availableCandidateCount: number | null;
    effectiveDeckTarget: number | null;
  } | null;
  clips: Array<{
    id: string;
    matchId: string;
    status: string;
    error: string | null;
    presentation: string | null;
    derivativeStatus: string | null;
  }>;
}

/**
 * The snapshot, from the rows the route has already checked the person
 * owns. Structural on purpose: it names only the fields it copies, so it
 * cannot leak a column that was added later.
 */
export function snapshotContext(input: {
  viewport: string;
  video: {
    id: string;
    status: string;
    errorMessage: string | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    indexStatus: string | null;
    transcriptStatus: string | null;
  } | null;
  clipRequest: {
    id: string;
    instruction: string;
    status: string;
    errorMessage: string | null;
    resolvedMode: string | null;
    answeredFrom: string | null;
    requestedResultCount: number | null;
    availableCandidateCount: number | null;
    effectiveDeckTarget: number | null;
  } | null;
  clips: Array<{
    id: string;
    clipMatchId: string;
    status: string;
    errorMessage: string | null;
    presentation: string | null;
    derivativeStatus: string | null;
  }>;
}): ReportContextSnapshot {
  return {
    viewport: input.viewport,
    video: input.video
      ? {
          id: input.video.id,
          status: input.video.status,
          error: input.video.errorMessage,
          durationSeconds: input.video.durationSeconds,
          width: input.video.width,
          height: input.video.height,
          indexStatus: input.video.indexStatus,
          transcriptStatus: input.video.transcriptStatus,
        }
      : null,
    clipRequest: input.clipRequest
      ? {
          id: input.clipRequest.id,
          instruction: input.clipRequest.instruction,
          status: input.clipRequest.status,
          error: input.clipRequest.errorMessage,
          resolvedMode: input.clipRequest.resolvedMode,
          answeredFrom: input.clipRequest.answeredFrom,
          requestedResultCount: input.clipRequest.requestedResultCount,
          availableCandidateCount: input.clipRequest.availableCandidateCount,
          effectiveDeckTarget: input.clipRequest.effectiveDeckTarget,
        }
      : null,
    clips: input.clips.map((clip) => ({
      id: clip.id,
      matchId: clip.clipMatchId,
      status: clip.status,
      error: clip.errorMessage,
      presentation: clip.presentation,
      derivativeStatus: clip.derivativeStatus,
    })),
  };
}

/** The issue a report becomes: the person's words first, then everything a fix needs. */
export function formatIssue(report: PlatformReport): { title: string; body: string } {
  const firstLine = report.message.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const title = `Report: ${firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine}`;
  const context = report.context as Partial<ReportContextSnapshot>;
  const lines: string[] = [];
  lines.push('## What they said', '', ...report.message.split(/\r?\n/).map((line) => `> ${line}`), '');
  lines.push('## Where', '', `- Page: \`${report.page || '(unknown)'}\``, `- When: ${report.createdAt.toISOString()}`, `- Report: \`${report.id}\``);
  if (report.sessionId) lines.push(`- Session: \`${report.sessionId}\``);
  if (report.userId) lines.push(`- User: \`${report.userId}\``);
  if (context.viewport) lines.push(`- Viewport: ${context.viewport}`);
  if (report.userAgent) lines.push(`- Browser: ${report.userAgent}`);
  lines.push('');
  if (context.video) {
    const v = context.video;
    lines.push('## The video', '', `- Id: \`${v.id}\``, `- Status: ${v.status}${v.error ? ` — ${v.error}` : ''}`,
      `- Length: ${v.durationSeconds ?? '?'} s, ${v.width ?? '?'}×${v.height ?? '?'}`,
      `- Notes: ${v.indexStatus ?? '?'} · Transcript: ${v.transcriptStatus ?? '?'}`, '');
  }
  if (context.clipRequest) {
    const r = context.clipRequest;
    lines.push('## The question', '', `- Id: \`${r.id}\``, `- Asked: "${r.instruction}"`,
      `- Status: ${r.status}${r.error ? ` — ${r.error}` : ''}`,
      `- Answered: ${r.answeredFrom ?? 'not yet'} (${r.resolvedMode ?? 'mode undecided'})`,
      `- Count: asked ${r.requestedResultCount ?? 'no number'}, found ${r.availableCandidateCount ?? '?'}, shown ${r.effectiveDeckTarget ?? '?'}`, '');
  }
  if (context.clips && context.clips.length > 0) {
    lines.push('## The clips', '');
    for (const clip of context.clips) {
      lines.push(`- \`${clip.id}\` (moment \`${clip.matchId}\`): ${clip.status}${clip.error ? ` — ${clip.error}` : ''}; ${clip.presentation ?? 'presentation unset'}, 9:16 file ${clip.derivativeStatus ?? 'none'}`);
    }
    lines.push('');
  }
  lines.push('---', '_Filed from the report dock in the product. Ids only; no personal data._');
  return { title, body: lines.join('\n') };
}

/**
 * How long the hand-off may take. The report is already saved when this
 * runs, and the person is waiting on the response; a GitHub that stalls
 * must not hold them, or the request, for good (Devin's finding on #95).
 */
export const HANDOFF_TIMEOUT_MS = 10_000;

/**
 * Files the report as an issue where it can be fixed. Returns where it
 * went, or null when no repository is configured. Throws when GitHub
 * refused or did not answer in time — the caller logs and the report
 * stays in the database.
 */
export async function handOffToGitHub(report: PlatformReport): Promise<string | null> {
  const repo = env.GITHUB_REPORTS_REPO;
  const token = env.GITHUB_REPORTS_TOKEN;
  if (!repo || !token) return null;
  const issue = formatIssue(report);
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'clipit-reports',
    },
    body: JSON.stringify({ title: issue.title, body: issue.body, labels: ['platform-report'] }),
    signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when filing the report`);
  const created = (await response.json()) as { number: number };
  return `github:${repo}#${created.number}`;
}
