import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The pure halves of Zernio webhook intake, separated from the route so both
 * can be tested without a server: signature verification over the raw bytes,
 * and defensive mapping of Zernio's varied payload shapes into the two events
 * CLIPIT's publishing actually consumes. populr's intake handles comments and
 * DMs too; none of that machinery exists here — posts and account health only.
 */

/**
 * HMAC-SHA256 of the raw request body, keyed with the secret configured on
 * the Zernio webhook, compared in constant time. The header may carry a
 * "sha256=" prefix. Verification happens before any payload parsing.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  const provided = (value ?? '').replace(/^sha256=/i, '').trim();
  if (!provided) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

export type ZernioWebhookEvent =
  | { kind: 'post_status'; zernioPostId: string; status: string }
  | { kind: 'account_status'; accountId: string; status: 'connected' | 'reconnect_required' }
  | { kind: 'ignore'; reason: string };

function pick(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * Map a webhook body into a normalized event. Anything unrecognized is
 * ignored with a reason, never an error — webhook endpoints must not
 * error-loop the sender, and CLIPIT deliberately handles only the publishing
 * subset of what Zernio can send.
 */
export function mapZernioWebhook(body: unknown): ZernioWebhookEvent {
  if (!body || typeof body !== 'object') return { kind: 'ignore', reason: 'not an object' };
  const root = body as Record<string, unknown>;
  const data = (root.data && typeof root.data === 'object' ? root.data : root) as Record<string, unknown>;
  const type = String(root.type ?? root.event ?? data.type ?? '').toLowerCase();

  if (type.includes('post') || type.includes('publish')) {
    const zernioPostId = pick(data, ['postId', 'post_id', 'id']);
    const status = pick(data, ['status', 'state']);
    if (!zernioPostId || !status) return { kind: 'ignore', reason: 'post event without id/status' };
    // The status column is text; keep Zernio's own word, bounded and folded.
    return { kind: 'post_status', zernioPostId, status: status.toLowerCase().slice(0, 64) };
  }

  if (type.includes('account')) {
    const accountId = pick(data, ['accountId', 'account_id', 'id']);
    const status = (pick(data, ['status', 'state']) ?? '').toLowerCase();
    if (!accountId) return { kind: 'ignore', reason: 'account event without id' };
    if (['disconnected', 'expired', 'revoked', 'token_expired', 'reconnect_required'].includes(status)) {
      // Surface the Reconnect button rather than hiding the row: the account
      // still belongs to the user; its authorization lapsed.
      return { kind: 'account_status', accountId, status: 'reconnect_required' };
    }
    if (['connected', 'active', 'reconnected'].includes(status)) {
      return { kind: 'account_status', accountId, status: 'connected' };
    }
    return { kind: 'ignore', reason: `unhandled account status "${status}"` };
  }

  return { kind: 'ignore', reason: `unhandled type "${type}"` };
}
