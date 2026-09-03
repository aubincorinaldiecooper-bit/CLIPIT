import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertProbesFitVideo, loadProbes } from '../src/scripts/mediaIndexExperiment.js';

/**
 * The probes are the experiment's ground truth.
 *
 * A probe that is wrong does not produce a wrong probe — it produces "the
 * model did not find it", which is a conclusion about a model drawn from a
 * mistake in a JSON file. Every rule here exists so that a bad probe fails the
 * run instead of quietly becoming evidence.
 */

async function probeFile(probes: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'clipit-probes-'));
  const file = path.join(dir, 'probes.json');
  await writeFile(file, JSON.stringify(probes));
  return file;
}

const good = {
  kind: 'object',
  query: 'the red pickup truck',
  expect: { startSeconds: 74, endSeconds: 88 },
};

describe('loadProbes', () => {
  it('accepts a well formed probe', async () => {
    const probes = await loadProbes(await probeFile([good]));
    expect(probes[0]!.expect).toEqual({ startSeconds: 74, endSeconds: 88 });
  });

  it('accepts the example file shipped beside the Modal services', async () => {
    // The template is documentation, and documentation that would fail the
    // validator is worse than none.
    const probes = await loadProbes(path.join(process.cwd(), 'modal', 'probes.example.json'));
    expect(probes.length).toBeGreaterThan(0);
  });

  it('refuses a reversed range', async () => {
    await expect(loadProbes(await probeFile([{ ...good, expect: { startSeconds: 88, endSeconds: 74 } }])))
      .rejects.toThrow(/must be after/);
  });

  it('refuses a missing or non-numeric timestamp', async () => {
    await expect(loadProbes(await probeFile([{ ...good, expect: { startSeconds: 74 } }])))
      .rejects.toThrow(/endSeconds must be a number/);
    await expect(loadProbes(await probeFile([{ ...good, expect: { startSeconds: '74', endSeconds: 88 } }])))
      .rejects.toThrow(/startSeconds must be a number/);
  });

  it('refuses a negative start', async () => {
    await expect(loadProbes(await probeFile([{ ...good, expect: { startSeconds: -1, endSeconds: 10 } }])))
      .rejects.toThrow(/negative/);
  });

  it('refuses an unrecognised kind', async () => {
    await expect(loadProbes(await probeFile([{ ...good, kind: 'vibes' }])))
      .rejects.toThrow(/"kind" must be one of/);
  });

  it('refuses an empty question', async () => {
    await expect(loadProbes(await probeFile([{ ...good, query: '   ' }])))
      .rejects.toThrow(/non-empty string/);
  });

  it('insists a visible-text probe has something to rank against', async () => {
    // The decisive probe. Without a near-twin, "found a sign" and "found the
    // RIGHT sign" score identically, and plain object recognition would be
    // reported as successful text retrieval — the one conclusion this probe
    // exists to rule out.
    await expect(loadProbes(await probeFile([{
      kind: 'visible-text', query: 'the sign that reads LOADING BAY',
      expect: { startSeconds: 402, endSeconds: 412 },
    }]))).rejects.toThrow(/needs a "distractor"/);
  });

  it('refuses a distractor that overlaps the answer', async () => {
    // They would share windows, and the margin between them would be a number
    // about nothing.
    await expect(loadProbes(await probeFile([{
      kind: 'visible-text', query: 'the sign that reads LOADING BAY',
      expect: { startSeconds: 402, endSeconds: 412 },
      distractor: { startSeconds: 408, endSeconds: 418 },
    }]))).rejects.toThrow(/overlaps the expected moment/);
  });

  it('does not let a null distractor pass as an absent one', async () => {
    // Written down and wrong is not the same as left out. Treating it as
    // absent would turn a typo into a quietly weaker experiment.
    await expect(loadProbes(await probeFile([{ ...good, distractor: null }])))
      .rejects.toThrow(/distractor/);
  });
});

describe('assertProbesFitVideo', () => {
  it('refuses a moment past the end of the video', async () => {
    // Otherwise the run reports that the model failed to find something the
    // video does not contain.
    const probes = await loadProbes(await probeFile([{ ...good, expect: { startSeconds: 74, endSeconds: 880 } }]));
    expect(() => assertProbesFitVideo(probes, 120)).toThrow(/only 120.0s long/);
  });

  it('accepts a moment inside the video', async () => {
    const probes = await loadProbes(await probeFile([good]));
    expect(() => assertProbesFitVideo(probes, 120)).not.toThrow();
  });
});
