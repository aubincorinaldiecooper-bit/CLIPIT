import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { baseArgs, describeYtdlpFailure, isBotCheck, isSupportedYoutubeUrl } from '../src/services/media/ytdlp.js';

/**
 * YouTube's bot check is the failure this codebase is most likely to hit in
 * production — hosted platforms egress from datacenter IPs that YouTube
 * challenges — so both the detection and the advice it produces are pinned.
 */

const mutableEnv = env as {
  YTDLP_COOKIES_CONTENT?: string;
  YTDLP_COOKIES_FILE?: string;
  YTDLP_POT_BASE_URL?: string;
  YTDLP_PROXY?: string;
};

afterEach(() => {
  delete mutableEnv.YTDLP_COOKIES_CONTENT;
  delete mutableEnv.YTDLP_COOKIES_FILE;
  delete mutableEnv.YTDLP_POT_BASE_URL;
  delete mutableEnv.YTDLP_PROXY;
});

describe('isBotCheck', () => {
  it('matches the wording yt-dlp actually emits', () => {
    expect(
      isBotCheck(
        "yt-dlp failed (exit 1): ERROR: [youtube] aw7d2AScD4M: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe(true);
  });

  it('matches the variants of the same refusal', () => {
    expect(isBotCheck('Please confirm you are not a bot')).toBe(true);
    expect(isBotCheck("confirm you're not a bot")).toBe(true);
    expect(isBotCheck('Use --cookies-from-browser')).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isBotCheck('ERROR: [youtube] xyz: Video unavailable')).toBe(false);
    expect(isBotCheck('yt-dlp failed (exit 1): HTTP Error 404: Not Found')).toBe(false);
    expect(isBotCheck('Command timed out after 120000ms')).toBe(false);
  });
});

describe('describeYtdlpFailure', () => {
  const botCheck = "ERROR: [youtube] id: Sign in to confirm you're not a bot. Use --cookies";

  it('passes unrelated failures through untouched', () => {
    const message = 'ERROR: [youtube] id: Video unavailable';
    expect(describeYtdlpFailure(message)).toBe(message);
  });

  it('offers every remedy when nothing is configured', () => {
    const described = describeYtdlpFailure(botCheck);
    expect(described).toMatch(/upload the file directly/i);
    expect(described).toMatch(/YTDLP_POT_BASE_URL/);
    expect(described).toMatch(/YTDLP_COOKIES_CONTENT/);
    expect(described).toMatch(/YTDLP_PROXY/);
  });

  it('leads with the token provider, which is the purpose-built remedy', () => {
    const described = describeYtdlpFailure(botCheck);
    expect(described.indexOf('YTDLP_POT_BASE_URL')).toBeLessThan(described.indexOf('YTDLP_COOKIES_CONTENT'));
    expect(described.indexOf('YTDLP_COOKIES_CONTENT')).toBeLessThan(described.indexOf('YTDLP_PROXY'));
  });

  it('stops suggesting what is already configured', () => {
    mutableEnv.YTDLP_POT_BASE_URL = 'http://pot.railway.internal:4416';
    mutableEnv.YTDLP_PROXY = 'socks5://127.0.0.1:1080';
    const described = describeYtdlpFailure(botCheck);
    expect(described).not.toMatch(/YTDLP_POT_BASE_URL/);
    expect(described).not.toMatch(/YTDLP_PROXY/);
  });

  it('tells an operator who already has cookies that they expire', () => {
    mutableEnv.YTDLP_COOKIES_CONTENT = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tX\ty';
    const described = describeYtdlpFailure(botCheck);
    expect(described).toMatch(/refresh the configured cookies/i);
    expect(described).not.toMatch(/YTDLP_COOKIES_CONTENT/);
  });

  it('treats a cookie file path the same as inline cookie contents', () => {
    mutableEnv.YTDLP_COOKIES_FILE = '/etc/clipit/cookies.txt';
    expect(describeYtdlpFailure(botCheck)).toMatch(/refresh the configured cookies/i);
  });
});

describe('baseArgs', () => {
  /** Reads the value following `flag`, or null when the flag is absent. */
  const valueAfter = (args: string[], flag: string): string | null => {
    const index = args.indexOf(flag);
    return index === -1 ? null : (args[index + 1] ?? null);
  };

  it('always names a JS runtime, without which YouTube extraction cannot work', async () => {
    expect(valueAfter(await baseArgs(), '--js-runtimes')).toBe('node');
  });

  it('omits the proxy and token provider when neither is configured', async () => {
    const args = await baseArgs();
    expect(args).not.toContain('--proxy');
    expect(args.join(' ')).not.toMatch(/bgutilhttp/);
  });

  it('wires the provider URL into the plugin extractor-args', async () => {
    mutableEnv.YTDLP_POT_BASE_URL = 'http://pot.railway.internal:4416';
    expect(await baseArgs()).toContain('youtubepot-bgutilhttp:base_url=http://pot.railway.internal:4416');
  });

  it('passes the proxy through', async () => {
    mutableEnv.YTDLP_PROXY = 'socks5://user:pass@host:1080';
    expect(valueAfter(await baseArgs(), '--proxy')).toBe('socks5://user:pass@host:1080');
  });

  it('keeps an operator override in its own flag so it cannot corrupt the provider wiring', async () => {
    mutableEnv.YTDLP_POT_BASE_URL = 'http://pot.railway.internal:4416';
    const args = await baseArgs();
    const extractorArgs = args.filter((_, index) => args[index - 1] === '--extractor-args');
    // Two separate values, not one concatenated string.
    expect(extractorArgs).toHaveLength(1);
    expect(extractorArgs[0]).toBe('youtubepot-bgutilhttp:base_url=http://pot.railway.internal:4416');
  });
});

describe('isSupportedYoutubeUrl', () => {
  it('accepts the public YouTube hosts', () => {
    expect(isSupportedYoutubeUrl('https://www.youtube.com/watch?v=aw7d2AScD4M')).toBe(true);
    expect(isSupportedYoutubeUrl('https://youtu.be/aw7d2AScD4M')).toBe(true);
    expect(isSupportedYoutubeUrl('https://m.youtube.com/watch?v=aw7d2AScD4M')).toBe(true);
  });

  it('rejects other hosts, schemes, and malformed input', () => {
    expect(isSupportedYoutubeUrl('https://vimeo.com/123')).toBe(false);
    expect(isSupportedYoutubeUrl('file:///etc/passwd')).toBe(false);
    expect(isSupportedYoutubeUrl('not a url')).toBe(false);
    // A lookalike host must not pass on a suffix match.
    expect(isSupportedYoutubeUrl('https://youtube.com.evil.test/watch?v=x')).toBe(false);
  });
});
