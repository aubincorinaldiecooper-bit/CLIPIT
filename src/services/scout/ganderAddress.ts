import { ModalClient } from 'modal';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Where the Gander runtime is.
 *
 * Modal decides the address of a web function — workspace, app name and
 * function name, run together into a hostname. Writing that address down by
 * hand means writing down something Modal already knows, and it goes stale
 * the moment the app is renamed or redeployed under another name. So it is
 * asked for rather than configured: the worker already holds Modal
 * credentials for the video model, and the same client can say where a web
 * function is listening.
 *
 * `GANDER_URL` still wins when it is set. It is the way to point at a runtime
 * that is not on Modal at all — a local one while developing, or a stand-in
 * during a test — and an explicit setting should never be quietly overruled
 * by a lookup.
 */

/** The vendored deployment in `modal/gander.py`. */
const DEFAULT_APP = 'clipit-gander-thinker';
const DEFAULT_FUNCTION = 'gander_server';

let cached: Promise<string> | null = null;

function setting(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function askModal(): Promise<string> {
  const app = setting('GANDER_MODAL_APP', DEFAULT_APP);
  const name = setting('GANDER_MODAL_FUNCTION', DEFAULT_FUNCTION);

  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new Error(
      'Cannot find the Gander runtime: set GANDER_URL, or give this service '
        + 'MODAL_TOKEN_ID and MODAL_TOKEN_SECRET so its address can be looked up.',
    );
  }

  const client = new ModalClient({
    tokenId: env.MODAL_TOKEN_ID,
    tokenSecret: env.MODAL_TOKEN_SECRET,
    environment: env.MODAL_ENVIRONMENT,
  });

  let url: string | undefined;
  try {
    const fn = await client.functions.fromName(app, name);
    url = await fn.getWebUrl();
  } catch (cause) {
    // Name the app and function that were looked for. A deployment under
    // another name is the likeliest reason to be here, and an error that does
    // not say what it went looking for makes that guesswork.
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not find Modal function ${app}/${name} to reach the Gander runtime: ${reason}`);
  }

  if (!url) {
    throw new Error(
      `Modal function ${app}/${name} has no web address. `
        + 'It is deployed, but not as a web server, so there is nothing to connect to.',
    );
  }

  logger.info('resolved the Gander runtime address from Modal', { app, function: name });
  return url.replace(/\/$/, '');
}

/**
 * The runtime's base address, resolved once and remembered.
 *
 * Remembered because it does not change while the process lives, and a lookup
 * on every candidate would put a network round trip in front of every page a
 * scout watches. A failed lookup is not remembered: the app may simply not be
 * deployed yet, and the next search should try again rather than inherit a
 * failure from an hour ago.
 */
export function ganderUrl(): Promise<string> {
  const explicit = process.env.GANDER_URL?.trim();
  if (explicit) return Promise.resolve(explicit.replace(/\/$/, ''));

  cached ??= askModal().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

/** Forget the resolved address. For tests, and for a redeploy that moves it. */
export function forgetGanderUrl(): void {
  cached = null;
}
