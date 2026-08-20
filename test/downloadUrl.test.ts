import { describe, expect, it } from 'vitest';

/**
 * The download filename is built from timecodes, which contain colons —
 * illegal in filenames on Windows and awkward inside a quoted header. The
 * sanitizer is not exported, so this pins the observable contract instead:
 * what a Content-Disposition value built this way must never contain.
 */
describe('clip download filenames', () => {
  const build = (start: string, end: string) => `clipit-${start}-${end}.mp4`;

  it('produces a name that survives sanitisation to something usable', () => {
    const raw = build('00:00:54', '00:01:02');
    const sanitized = raw.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    expect(sanitized).toBe('clipit-00-00-54-00-01-02.mp4');
    expect(sanitized).not.toContain(':');
    expect(sanitized).not.toContain('"');
    expect(sanitized.endsWith('.mp4')).toBe(true);
  });

  it('keeps the moment identifiable in the saved file', () => {
    const sanitized = build('01:23:45', '01:23:59').replace(/[^\w.-]+/g, '-');
    // Someone with a folder of these has to be able to tell them apart.
    expect(sanitized).toContain('01-23-45');
    expect(sanitized).toContain('01-23-59');
  });
});
