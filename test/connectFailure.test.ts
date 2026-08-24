import { describe, expect, it } from 'vitest';
import { connectFailure } from '../src/api/routes/social.js';
import { ZernioApiError } from '../src/services/zernio/client.js';

/**
 * What a person is told when connecting an account fails.
 *
 * This exists because a real user spent a session looking at "Something went
 * wrong handling this request" on every Connect button. That message is true
 * and useless: it does not say whether the platform is down, whether CLIPIT
 * is at fault, or whether waiting would help.
 *
 * Two things must hold for every branch, and they are what these tests are
 * really guarding: the upstream body is never quoted (it can carry tokens and
 * billing identifiers), and the publishing provider is never named to the
 * browser.
 */

const CONTEXT = 'YouTube could not be reached for sign-in';

// A body of the shape a provider error really carries, so a leak would show.
const SECRET_BODY = {
  access_token: 'sk-live-SHOULD-NEVER-APPEAR',
  billing_account: 'acct_SHOULD-NEVER-APPEAR',
  detail: 'internal upstream detail',
};

const messageFor = (status: number) =>
  connectFailure(new ZernioApiError(`upstream failed with ${status}`, status, SECRET_BODY), CONTEXT).message;

describe('connectFailure', () => {
  it('names a plan upgrade for a payment-required refusal', () => {
    const error = connectFailure(new ZernioApiError('nope', 402, SECRET_BODY), CONTEXT);
    expect(error.message).toMatch(/plan upgrade/i);
  });

  it('says it is our fault, not theirs, when our own credentials are refused', () => {
    for (const status of [401, 403]) {
      expect(messageFor(status)).toMatch(/on our side/i);
    }
  });

  it('tells someone to wait when the provider is rate limiting', () => {
    expect(messageFor(429)).toMatch(/wait a minute|too many/i);
  });

  it('says the service is down, and that it usually clears, on a 5xx', () => {
    for (const status of [500, 502, 503]) {
      expect(messageFor(status)).toMatch(/isn't responding/i);
      expect(messageFor(status)).toMatch(/try again/i);
    }
  });

  it('blames us, not the platform, when the failure is not the provider at all', () => {
    // A database fault, a bug, anything of ours. Implying the platform is
    // down would send someone off checking a service that was never at fault.
    const error = connectFailure(new Error('null value in column violates not-null constraint'), CONTEXT);
    expect(error.message).toMatch(/on us/i);
  });

  it('always keeps the context, so a person knows WHICH step failed', () => {
    const causes: unknown[] = [
      new Error('boom'),
      new ZernioApiError('x', 401, SECRET_BODY),
      new ZernioApiError('x', 429, SECRET_BODY),
      new ZernioApiError('x', 500, SECRET_BODY),
      new ZernioApiError('x', 418, SECRET_BODY),
    ];
    for (const cause of causes) {
      expect(connectFailure(cause, CONTEXT).message).toContain(CONTEXT);
    }
  });

  it('never leaks the upstream body — no token, no billing id, no raw detail', () => {
    const statuses = [400, 401, 402, 403, 404, 409, 418, 429, 500, 502, 503];
    for (const status of statuses) {
      const message = connectFailure(new ZernioApiError('raw upstream text', status, SECRET_BODY), CONTEXT).message;
      expect(message).not.toContain('SHOULD-NEVER-APPEAR');
      expect(message).not.toContain('access_token');
      expect(message).not.toContain('billing_account');
      expect(message).not.toContain('internal upstream detail');
      // The provider's own error string must not be passed through either.
      expect(message).not.toContain('raw upstream text');
    }
  });

  it('never names the publishing provider to the browser', () => {
    // The owner asked for the provider to be completely scrubbed from
    // everything a user can see. An error message is the easiest place for
    // that to slip back in.
    const statuses = [400, 401, 402, 403, 429, 500, 503];
    for (const status of statuses) {
      const message = connectFailure(new ZernioApiError('x', status, SECRET_BODY), CONTEXT).message;
      expect(message.toLowerCase()).not.toContain('zernio');
    }
    expect(connectFailure(new Error('zernio exploded'), CONTEXT).message.toLowerCase()).not.toContain('zernio');
  });

  it('still answers usefully for a status nobody planned for', () => {
    const message = messageFor(418);
    expect(message).toContain(CONTEXT);
    expect(message).toMatch(/try again/i);
  });
});
