import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The stale threshold is not a number, it is a relationship.
 *
 * A read is judged dead by its silence, and the longest silence a LIVE read
 * can produce is one full request timeout: a single embedding call may run for
 * all of it, and progress is only written once that batch returns. So the
 * threshold must outlast the timeout, or a healthy call gets reported as a
 * read that stopped.
 *
 * It shipped as a fixed 2700, which was correct only while the timeout sat at
 * its own default of 900. The timeout is independently configurable up to
 * 3600. Raising just that one would have left searches calling a legally
 * running first call stopped — while the comment above it promised "a working
 * read can never trip it". These pin the relationship instead of the number.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

/** Load a fresh copy of the config under the given overrides. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import('../src/config/env.js')).env;
}

/**
 * The silence a healthy batch may produce, computed here independently of the
 * config so the test is a second opinion rather than an echo. Mirrors the
 * retry loop in services/modal/invoke.ts: maxRetries + 1 attempts, each up to
 * the full request timeout, with min(30s, 2^attempt) between them.
 */
function worstHealthySilence(requestTimeout: number, maxRetries: number): number {
  let backoff = 0;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) backoff += Math.min(30, 2 ** attempt);
  return (maxRetries + 1) * requestTimeout + backoff;
}

describe('the stale threshold outlasts every silence a healthy read can produce', () => {
  it('counts the retries inside a batch, not just one timeout', async () => {
    // The trap. A batch is ONE invokeModal call, and that call retries inside
    // itself — so a healthy batch that times out twice and succeeds on the
    // third attempt says nothing for three timeouts plus backoff. A plain
    // "three times the timeout" would have put the threshold at 2700 against a
    // worst case of 2703 and accused a live read by three seconds.
    const env = await loadEnv({
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: undefined,
      MEDIA_INDEX_MAX_RETRIES: undefined,
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    expect(env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS).toBe(900);
    expect(env.MEDIA_INDEX_MAX_RETRIES).toBe(2);
    // 3 attempts × 900s + (1s + 2s) of backoff.
    expect(worstHealthySilence(900, 2)).toBe(2703);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(5406);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBeGreaterThan(worstHealthySilence(900, 2));
  });

  it('follows the timeout up, rather than staying where it was', async () => {
    // The reviewer's case: raising only the request timeout used to leave a
    // fixed threshold behind it.
    const env = await loadEnv({
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '3600',
      MEDIA_INDEX_MAX_RETRIES: undefined,
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(worstHealthySilence(3600, 2) * 2);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBeGreaterThan(worstHealthySilence(3600, 2));
  });

  it('follows the retry count up too — the setting the first fix forgot', async () => {
    // MEDIA_INDEX_MAX_RETRIES goes to 5. Six attempts of 900s plus 31s of
    // backoff is 5431s of legal silence, against the 2700 a timeout-only
    // derivation would still have produced. This is the same mistake one
    // level down, found by asking where else the argument applied.
    const env = await loadEnv({
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '900',
      MEDIA_INDEX_MAX_RETRIES: '5',
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    expect(worstHealthySilence(900, 5)).toBe(5431);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(10_862);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBeGreaterThan(2700);
  });

  it('follows the timeout down too', async () => {
    const env = await loadEnv({
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '60',
      MEDIA_INDEX_MAX_RETRIES: '0',
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    // No retries: one attempt, no backoff.
    expect(worstHealthySilence(60, 0)).toBe(60);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(120);
  });

  it('still honours an explicit value that respects the relationship', async () => {
    // Tighter than the derived default, but still clear of the worst healthy
    // silence: an operator who knows their footage may want faster detection.
    const env = await loadEnv({
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '900',
      MEDIA_INDEX_MAX_RETRIES: '2',
      MEDIA_INDEX_STALE_AFTER_SECONDS: '3000',
    });

    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(3000);
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBeGreaterThan(worstHealthySilence(900, 2));
  });

  it('refuses to start on an explicit value that would accuse a live call', async () => {
    // Deriving the default is not enough on its own: an operator can still set
    // both. A threshold at or under the timeout is not a tuning choice, it is
    // a guarantee that healthy reads get reported as dead ones — so it is
    // refused at startup, where it is one message, rather than discovered as
    // wrong answers.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    const errors: unknown[][] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    // 2700 clears one timeout comfortably and is still under the 2703 a
    // healthy retrying batch can take — exactly the value the first fix would
    // have chosen for itself.
    await expect(
      loadEnv({
        MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '900',
        MEDIA_INDEX_MAX_RETRIES: '2',
        MEDIA_INDEX_STALE_AFTER_SECONDS: '2700',
      }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.flat().join(' ')).toContain('MEDIA_INDEX_STALE_AFTER_SECONDS');
    // The message has to say WHY, and name the arithmetic, not just that a
    // rule was broken.
    expect(errors.flat().join(' ')).toContain('2703');
    expect(errors.flat().join(' ')).toContain('reported as a read that stopped');

    consoleError.mockRestore();
    exit.mockRestore();
  });
});
