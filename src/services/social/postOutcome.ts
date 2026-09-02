import { z } from 'zod';

/**
 * What a post's status word says about where the post is, in three words
 * a person can act on: it is still on its way, it is up, or it is not
 * going up.
 *
 * The column keeps the provider's own word (see submitRecordedPost and the
 * webhook intake), so the vocabulary is theirs plus CLIPIT's two
 * ('submitting', 'rendering'). A word this code does not know is 'posting':
 * saying "published" of a post nobody confirmed is the one thing this must
 * never do — the Publish button says Published only on the platform's
 * word, and "Sent" until then. The scheduled list (deriveOutcome in the
 * scheduled-posts repository) is more generous, counting an accepted post
 * as posted; that is its standing behaviour and is not changed here.
 */
export type PostOutcome = 'posting' | 'posted' | 'failed';

const POSTED = new Set(['published', 'posted', 'success', 'succeeded', 'completed', 'complete', 'live', 'done']);
const FAILED = new Set(['failed', 'failure', 'error', 'errored', 'rejected', 'canceled', 'cancelled', 'expired']);

export function postOutcome(status: string): PostOutcome {
  const word = status.trim().toLowerCase();
  if (FAILED.has(word)) return 'failed';
  if (POSTED.has(word)) return 'posted';
  return 'posting';
}

/** The targets a post row carries, as stored: platform and account; anything else is dropped rather than guessed at. */
const targetsSchema = z.array(z.object({ platform: z.string(), accountId: z.string() }).passthrough());

export function targetsOfPost(targets: unknown): Array<{ platform: string; accountId: string }> {
  const parsed = targetsSchema.safeParse(targets);
  if (!parsed.success) return [];
  return parsed.data.map((target) => ({ platform: target.platform, accountId: target.accountId }));
}

export interface ClipPostView {
  id: string;
  clipId: string | null;
  status: string;
  outcome: PostOutcome;
  targets: Array<{ platform: string; accountId: string }>;
  createdAt: string;
}

export function serializeClipPost(row: {
  id: string;
  clip_id: string | null;
  status: string;
  targets: unknown;
  created_at: Date;
}): ClipPostView {
  return {
    id: row.id,
    clipId: row.clip_id,
    status: row.status,
    outcome: postOutcome(row.status),
    targets: targetsOfPost(row.targets),
    createdAt: row.created_at.toISOString(),
  };
}
