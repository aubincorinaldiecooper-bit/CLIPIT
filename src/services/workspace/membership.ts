import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  getOwnWorkspace,
  insertWorkspace,
  setMemberEmail,
  type WorkspaceRow,
} from '../../db/repositories/workspaces.js';

/**
 * A person always has somewhere to work — their own room, created the first
 * time they sign in, so nobody is ever in the awkward state of owning work
 * that belongs to no workspace. Joining a team adds a room; it never replaces
 * this one.
 */
export async function ensureWorkspace(userId: string, email: string | null): Promise<WorkspaceRow> {
  const own = await getOwnWorkspace(userId);
  if (own) {
    // A returning member may have signed in with an address we did not know
    // when they were invited; keep the team list honest about who is who.
    if (email) await setMemberEmail(userId, email);
    return own;
  }
  const name = email ? `${email.split('@')[0]}'s workspace` : 'My workspace';
  const workspace = await insertWorkspace({ name, ownerUserId: userId, email });
  logger.info('workspace created', { workspaceId: workspace.id });
  return workspace;
}

/**
 * The invitation email, through Resend — the same service the sign-in links
 * use. Without a key configured the invite is still created and the link
 * still works; the caller is told plainly that the email could not be sent
 * rather than being left to assume it arrived.
 */
export async function sendInviteEmail(input: {
  to: string;
  acceptUrl: string;
  workspaceName: string;
  invitedByEmail: string | null;
}): Promise<{ sent: boolean; reason?: string }> {
  const key = env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'email_not_configured' };

  const from = env.RESEND_FROM ?? 'CLIPIT <onboarding@resend.dev>';
  const inviter = input.invitedByEmail ?? 'Someone';
  const body = [
    `${inviter} invited you to join ${input.workspaceName} on CLIPIT.`,
    '',
    'Joining means you see the clips people send to this room, and you can send your own there. Your library stays yours.',
    '',
    input.acceptUrl,
    '',
    'The invitation works once and expires in 7 days. If you did not expect it, ignore this email.',
  ].join('\n');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: `${inviter} invited you to ${input.workspaceName} on CLIPIT`,
        text: body,
        html: [
          `<p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(input.workspaceName)}</strong> on CLIPIT.</p>`,
          `<p>Joining means you see the clips people send to <strong>${escapeHtml(input.workspaceName)}</strong>, and you can send your own there. Your library stays yours.</p>`,
          `<p><a href="${escapeHtml(input.acceptUrl)}">Join the room</a></p>`,
          `<p style="color:#666;font-size:13px">The invitation works once and expires in 7 days. If you did not expect it, ignore this email.</p>`,
        ].join('\n'),
      }),
    });
    if (!response.ok) {
      // Only the status: a provider error body can carry account details, and
      // is never worth forwarding or logging wholesale.
      logger.warn('invite email refused', { status: response.status });
      return { sent: false, reason: response.status === 403 ? 'email_domain_unverified' : 'email_send_failed' };
    }
    return { sent: true };
  } catch (cause) {
    logger.warn('invite email failed', { error: cause instanceof Error ? cause.name : 'unknown' });
    return { sent: false, reason: 'email_send_failed' };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
