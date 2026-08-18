import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { describeYtdlpFailure, isBotCheck, isSupportedYoutubeUrl } from '../src/services/media/ytdlp.js';

/**
 * YouTube's bot check is the failure this codebase is most likely to hit in
 * production — hosted platforms egress from datacenter IPs that YouTube
 * challenges — so both the detection and the advice it produces are pinned.
 */

const mutableEnv = env as { YTDLP_COOKIES_CONTENT?: string; YTDLP_COOKIES_FILE?: string };

afterEach(() => {
  delete mutableEnv.YTDLP_COOKIES_CONTENT;
  delete mutableEnv.YTDLP_COOKIES_FILE;
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

  it('tells an operator with no cookies configured what to do', () => {
    const described = describeYtdlpFailure(botCheck);
    expect(described).toMatch(/upload the file directly/i);
    expect(described).toMatch(/YTDLP_COOKIES_CONTENT/);
  });

  it('tells an operator who already has cookies that they may have expired', () => {
    mutableEnv.YTDLP_COOKIES_CONTENT = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tX\ty';
    const described = describeYtdlpFailure(botCheck);
    expect(described).toMatch(/expired/i);
    expect(described).not.toMatch(/YTDLP_COOKIES_CONTENT/);
  });

  it('treats a cookie file path the same as inline cookie contents', () => {
    mutableEnv.YTDLP_COOKIES_FILE = '/etc/clipit/cookies.txt';
    expect(describeYtdlpFailure(botCheck)).toMatch(/expired/i);
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
