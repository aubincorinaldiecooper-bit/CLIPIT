import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fromName = vi.fn();
const construct = vi.fn();

/** The validated config is read once at startup, so it is stood in for here. */
const config = { MODAL_TOKEN_ID: 'token-id', MODAL_TOKEN_SECRET: 'token-secret', MODAL_ENVIRONMENT: 'main' };
vi.mock('../src/config/env.js', () => ({ env: new Proxy({}, { get: (_t, key: string) => config[key as keyof typeof config] }) }));

vi.mock('modal', () => ({
  ModalClient: class {
    readonly functions = { fromName };
    constructor(params: unknown) {
      construct(params);
    }
  },
}));

const { ganderUrl, forgetGanderUrl } = await import('../src/services/scout/ganderAddress.js');

/** A Modal function handle, as the SDK hands one back. */
function webFunction(url: string | undefined) {
  return { getWebUrl: async () => url };
}

const saved = { ...process.env };

beforeEach(() => {
  fromName.mockReset();
  construct.mockReset();
  forgetGanderUrl();
  delete process.env.GANDER_URL;
  delete process.env.GANDER_MODAL_APP;
  delete process.env.GANDER_MODAL_FUNCTION;
  config.MODAL_TOKEN_ID = 'token-id';
  config.MODAL_TOKEN_SECRET = 'token-secret';
});

afterEach(() => {
  process.env = { ...saved };
});

describe('finding the Gander runtime', () => {
  it('asks Modal where it deployed the runtime', async () => {
    fromName.mockResolvedValue(webFunction('https://workspace--clipit-gander-thinker-gander-server.modal.run'));

    await expect(ganderUrl()).resolves.toBe('https://workspace--clipit-gander-thinker-gander-server.modal.run');
    // The names come from the vendored modal/gander.py.
    expect(fromName).toHaveBeenCalledWith('clipit-gander-thinker', 'gander_server');
  });

  it('follows the app wherever it is deployed', async () => {
    // A rename — CLIPIT#134 moves it to clipit-gnsis-runtime-test — is a
    // setting, not a new address to work out by hand.
    process.env.GANDER_MODAL_APP = 'clipit-gnsis-runtime-test';
    process.env.GANDER_MODAL_FUNCTION = 'gnsis_server';
    fromName.mockResolvedValue(webFunction('https://workspace--clipit-gnsis-runtime-test-gnsis-server.modal.run'));

    await expect(ganderUrl()).resolves.toContain('gnsis-runtime-test');
    expect(fromName).toHaveBeenCalledWith('clipit-gnsis-runtime-test', 'gnsis_server');
  });

  it('lets an explicit address win, and does not go looking', async () => {
    // The way to point at a runtime that is not on Modal at all.
    process.env.GANDER_URL = 'http://localhost:7975/';

    await expect(ganderUrl()).resolves.toBe('http://localhost:7975');
    expect(fromName).not.toHaveBeenCalled();
  });

  it('remembers the answer rather than asking for every page', async () => {
    fromName.mockResolvedValue(webFunction('https://workspace--app-fn.modal.run'));

    await ganderUrl();
    await ganderUrl();

    expect(fromName).toHaveBeenCalledTimes(1);
  });

  it('tries again after a lookup that failed', async () => {
    // The app may simply not be deployed yet. The next search should find out
    // for itself rather than inherit an hour-old failure.
    fromName.mockRejectedValueOnce(new Error('not found'));
    await expect(ganderUrl()).rejects.toThrow('clipit-gander-thinker/gander_server');

    fromName.mockResolvedValue(webFunction('https://workspace--app-fn.modal.run'));
    await expect(ganderUrl()).resolves.toBe('https://workspace--app-fn.modal.run');
  });

  it('says what it went looking for when it cannot find it', async () => {
    fromName.mockRejectedValue(new Error('App not found'));

    // A deployment under another name is the likeliest reason to be here, and
    // an error that does not name the app makes that guesswork.
    await expect(ganderUrl()).rejects.toThrow(/clipit-gander-thinker\/gander_server/);
  });

  it('says so when the app is deployed but is not a web server', async () => {
    fromName.mockResolvedValue(webFunction(undefined));

    await expect(ganderUrl()).rejects.toThrow(/no web address/);
  });

  it('asks for credentials rather than failing obscurely without them', async () => {
    config.MODAL_TOKEN_ID = '';

    await expect(ganderUrl()).rejects.toThrow(/GANDER_URL|MODAL_TOKEN_ID/);
    expect(fromName).not.toHaveBeenCalled();
  });
});
