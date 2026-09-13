import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** A frame whose caption never arrived must be counted, never disguised. */
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
  it('reads internally consistent counts the sidecar sends', () => {
    const parsed = readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 6, retried: 3, failed: 2, lastError: 'empty caption (finish_reason=length, max_tokens=600)' },
    });
    expect(parsed.captions).toEqual({
      attempted: 8, captioned: 6, retried: 3, failed: 2,
      lastError: 'empty caption (finish_reason=length, max_tokens=600)',
    });
  });

  it('accepts a reply from a sidecar that predates the counts as unknown rather than zero', () => {
    expect(readIndexReply(reply).captions).toBeNull();
  });

  it('refuses counts that are not numbers instead of storing nonsense', () => {
    expect(() => readIndexReply({ ...reply, captions: { attempted: 'eight', captioned: 6, retried: 0, failed: 0 } })).toThrow(/captions\.attempted/);
  });

  it('refuses negative or fractional counts', () => {
    expect(() => readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 8, retried: -1, failed: 0, lastError: null },
    })).toThrow(/captions\.retried/);
    expect(() => readIndexReply({
      ...reply,
      captions: { attempted: 8.5, captioned: 8, retried: 0, failed: 0.5, lastError: null },
    })).toThrow(/captions\.attempted/);
  });

  it('refuses mathematically impossible caption totals', () => {
    expect(() => readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 9, retried: 0, failed: 0, lastError: null },
    })).toThrow(/inconsistent caption counts/);
    expect(() => readIndexReply({
      ...reply,
      captions: { attempted: 8, captioned: 8, retried: 9, failed: 0, lastError: null },
    })).toThrow(/inconsistent caption counts/);
  });
});

describe('the sidecar routes captions through the writer', () => {
  it('takes over upstream generate_summary on the image processor and reads the counts back', async () => {
    const source = await read('tools/simplemem/sidecar.py');
    expect(source).toContain('from captions import CaptionWriter');
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

  it('the worker refuses any partial-caption memory instead of treating it as full coverage', async () => {
    const source = await read('src/worker/handlers/simplememIndexing.ts');
    expect(source).toContain('if (reply.captions.failed > 0)');
    expect(source).toContain('refusing partial memory');
  });
});
