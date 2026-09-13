import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * A frame whose caption never arrived must be counted, never disguised.
 *
 * Upstream Omni-SimpleMem stored "Image captured" for such a frame and
 * counted it as a success; a memory built that way describes nothing and
 * is reported as complete. The sidecar now routes captions through
 * tools/simplemem/captions.py (tested with plain unittest), and the counts
 * come back on the indexing reply so the worker's row and logs carry them.
 */

const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');

const { readIndexReply } = await import('../src/services/retrieval/simplemem/client.js');

const reply = {
  videoMauId: 'mau-1',
  fps: 1,
  framesExtracted: 10,
  framesProcessed: 8,
  framesSkipped: 2,
  coveredThroughSeconds: 10,
  audioTranscribed: false,
  elapsedMs: 1200,
};

describe('caption counts on the indexing reply', () => {
  it('reads the counts the sidecar sends', () => {
    const parsed = readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 6, retried: 3, failed: 2, lastError: 'empty caption (finish_reason=length, max_tokens=600)' },
    });
    expect(parsed.captions).toEqual({
      attempted: 8, captioned: 6, retried: 3, failed: 2,
      lastError: 'empty caption (finish_reason=length, max_tokens=600)',
      uncaptionedFrames: [],
    });
  });

  it('accepts a reply from a sidecar that predates the counts, as unknown rather than zero', () => {
    expect(readIndexReply(reply).captions).toBeNull();
  });

  it('refuses counts that are not numbers instead of storing nonsense', () => {
    expect(() => readIndexReply({ ...reply, captions: { attempted: 'eight', captioned: 6, retried: 0, failed: 0 } })).toThrow(/captions\.attempted/);
  });
});

describe('the sidecar routes captions through the writer', () => {
  it('takes over upstream generate_summary on the image processor and reads the counts back', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('from captions import UNCAPTIONED, CaptionWriter');
    expect(source).toContain('processor.generate_summary = writer.caption');
    expect(source).toContain('captions = _caption_stats(memory)');
    expect(source).toContain('"captions": captions,');
  });

  it('refuses to call a memory with no captions at all finished, and says why', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('if captions["attempted"] > 0 and captions["captioned"] == 0:');
    expect(source).toContain('raise IndexingRefused(');
    expect(source).toContain('detail=f"SimpleMem indexing refused: {exc}"');
  });

  it('ships the module in the image and runs its tests in CI', async () => {
    expect(await read('Dockerfile.simplemem')).toContain('COPY tools/simplemem/captions.py /app/captions.py');
    expect(await read('.github/workflows/videochat3-validation.yml')).toContain("python3 -m unittest discover -s tools/simplemem -p 'test_*.py'");
  });

  it('never stores upstream placeholder wording for an undescribed frame', async () => {
    const source = await read('tools/simplemem/captions.py');
    expect(source).toContain('UNCAPTIONED = "[no caption:');
    expect(source).not.toMatch(/return "Image captured"/);
  });
});

const { uncaptionedRanges } = await import('../src/services/retrieval/simplemem/candidates.js');

describe('an answer from memory names the stretches it never described', () => {
  it('folds neighbouring undescribed frames into one stretch, one frame = 1/fps seconds', () => {
    expect(uncaptionedRanges({ captions: { uncaptionedFrames: [3, 4, 5, 9] } }, { fps: 1, durationSeconds: 60 })).toEqual([
      { startSeconds: 3, endSeconds: 6, frames: 3 },
      { startSeconds: 9, endSeconds: 10, frames: 1 },
    ]);
    expect(uncaptionedRanges({ captions: { uncaptionedFrames: [10, 11] } }, { fps: 2, durationSeconds: 60 })).toEqual([
      { startSeconds: 5, endSeconds: 6, frames: 2 },
    ]);
  });

  it('never lets a stretch run past the end of the video', () => {
    expect(uncaptionedRanges({ captions: { uncaptionedFrames: [59, 60, 61] } }, { fps: 1, durationSeconds: 60 })).toEqual([
      { startSeconds: 59, endSeconds: 60, frames: 3 },
    ]);
  });

  it('treats a row without the list, or a malformed one, as having nothing to say', () => {
    expect(uncaptionedRanges(null, { fps: 1, durationSeconds: 60 })).toEqual([]);
    expect(uncaptionedRanges({ models: {} }, { fps: 1, durationSeconds: 60 })).toEqual([]);
    expect(uncaptionedRanges({ captions: { uncaptionedFrames: 'many' } }, { fps: 1, durationSeconds: 60 })).toEqual([]);
    expect(uncaptionedRanges({ captions: { uncaptionedFrames: [-1, 1.5, 'x', 4, 4] } }, { fps: 1, durationSeconds: 60 })).toEqual([
      { startSeconds: 4, endSeconds: 5, frames: 1 },
    ]);
  });

  it('reads the undescribed frames off the indexing reply, and refuses counts that are not counts', () => {
    const parsed = readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 6, retried: 1, failed: 2, lastError: null, uncaptionedFrames: [2, 7] },
    });
    expect(parsed.captions?.uncaptionedFrames).toEqual([2, 7]);
    expect(() => readIndexReply({ ...reply, captions: { attempted: 8, captioned: 9, retried: -1, failed: -1 } })).toThrow(/captions\.retried/);
    expect(() => readIndexReply({ ...reply, captions: { attempted: 8, captioned: 7, retried: 0, failed: 2 } })).toThrow(/inconsistent caption counts/);
    expect(() => readIndexReply({ ...reply, captions: { attempted: 8, captioned: 8, retried: 9, failed: 0 } })).toThrow(/inconsistent caption counts/);
    expect(() => readIndexReply({ ...reply, captions: { attempted: 1.5, captioned: 1, retried: 0, failed: 0 } })).toThrow(/captions\.attempted/);
  });

  it('records each undescribed stretch on the request before answering from memory', async () => {
    const handler = await read('src/worker/handlers/clipSearch.ts');
    const memory = handler.slice(handler.indexOf('async function answerFromSimpleMem'));
    expect(memory).toContain('const undescribed = uncaptionedRanges(index?.config');
    expect(memory).toContain('remembered this stretch');
    expect(memory).toContain("code: 'not_read_yet'");
    expect(memory).toContain('coverageFailuresDescribed: (unreadTail ? 1 : 0) + undescribed.length');
    expect(memory.indexOf('const undescribed = uncaptionedRanges')).toBeLessThan(memory.indexOf('await insertMatches(input.clipRequestId, found)'));
    const sidecar = await read('tools/simplemem/sidecar.py');
    expect(sidecar).toContain('captions["uncaptionedFrames"] = sorted(uncaptioned)');
  });
});
