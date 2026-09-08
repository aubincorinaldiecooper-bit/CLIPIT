import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * When is a run "gone"? Only the run can say.
 *
 * This started as arithmetic over the request timeout, and the arithmetic was
 * wrong twice. First it was a fixed 2700 seconds against a timeout an operator
 * can raise independently. Then it was derived from the timeout — and still
 * wrong, because a batch retries inside itself, so a healthy batch could be
 * silent for three timeouts plus backoff.
 *
 * The third answer is that no arithmetic works. A batch waits for a Modal
 * permit that searches compete for, and that wait is bounded by nothing at
 * all: any multiplier is a guess about contention dressed up as a calculation.
 *
 * So the run says it is alive on a timer, and this threshold only has to
 * outlast a few missed beats. These pin that, and pin that an operator cannot
 * configure it back into accusing a live run.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return (await import('../src/config/env.js')).env;
}

describe('the stale threshold is measured in missed heartbeats', () => {
  it('is three beats when nobody sets it', async () => {
    const env = await loadEnv({
      MEDIA_INDEX_HEARTBEAT_SECONDS: undefined,
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    expect(env.MEDIA_INDEX_HEARTBEAT_SECONDS).toBe(30);
    // Three, so one dropped write — a reset, a failover — is never a verdict,
    // while a process that actually died is noticed in a minute and a half.
    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(90);
  });

  it('follows the heartbeat, not the request timeout', async () => {
    // The whole point of the redesign. Timeout and retries no longer enter
    // into it, so moving them cannot break the threshold — which is how both
    // earlier versions broke.
    const env = await loadEnv({
      MEDIA_INDEX_HEARTBEAT_SECONDS: '10',
      MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS: '3600',
      MEDIA_INDEX_MAX_RETRIES: '5',
      MEDIA_INDEX_STALE_AFTER_SECONDS: undefined,
    });

    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(30);
  });

  it('still honours an explicit value clear of a beat', async () => {
    const env = await loadEnv({
      MEDIA_INDEX_HEARTBEAT_SECONDS: '30',
      MEDIA_INDEX_STALE_AFTER_SECONDS: '120',
    });

    expect(env.MEDIA_INDEX_STALE_AFTER_SECONDS).toBe(120);
  });

  it('refuses to start when set inside a single beat', async () => {
    // A threshold under the heartbeat calls every run stopped between two
    // beats it was always going to miss. Refused at startup, where it is one
    // message, rather than discovered as a stream of wrong reasons.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    const errors: unknown[][] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    await expect(
      loadEnv({ MEDIA_INDEX_HEARTBEAT_SECONDS: '30', MEDIA_INDEX_STALE_AFTER_SECONDS: '30' }),
    ).rejects.toThrow('process.exit');

    expect(exit).toHaveBeenCalledWith(1);
    const said = errors.flat().join(' ');
    expect(said).toContain('MEDIA_INDEX_STALE_AFTER_SECONDS');
    // The message has to say why, not just that a rule was broken.
    expect(said).toContain('between two beats it was always going to miss');

    consoleError.mockRestore();
    exit.mockRestore();
  });
});
