import { describe, expect, it } from 'vitest';
import {
  applyVisualRejection,
  hasSpokenEvidence,
  SPOKEN_EVIDENCE_DEMOTION,
} from '../src/worker/handlers/clipSearch.js';
import type { NewClipMatch } from '../src/db/repositories/clipRequests.js';

/**
 * Verification asks "is this VISIBLE here?". A moment established by speech
 * can answer no and still be right — someone mentions the thing off-camera.
 * Speech and visuals are independent signals, so a visual rejection must
 * never be the sole reason spoken evidence disappears.
 */

const match = (overrides: Partial<NewClipMatch> = {}): NewClipMatch => ({
  chunkId: '00000000-0000-0000-0000-000000000001',
  localStartSeconds: 10,
  localEndSeconds: 20,
  globalStartSeconds: 610,
  globalEndSeconds: 620,
  description: 'someone talks about a truck',
  confidence: 0.8,
  source: 'multimodal',
  quote: null,
  ...overrides,
});

describe('hasSpokenEvidence', () => {
  it('is true for a transcript match regardless of quote', () => {
    expect(hasSpokenEvidence(match({ source: 'transcript', quote: null }))).toBe(true);
  });

  it('is true for a multimodal match carrying a quote', () => {
    expect(hasSpokenEvidence(match({ source: 'multimodal', quote: 'is that a Cybertruck?' }))).toBe(true);
  });

  it('is false for a visual match, and for an empty or whitespace quote', () => {
    expect(hasSpokenEvidence(match({ source: 'visual', quote: null }))).toBe(false);
    expect(hasSpokenEvidence(match({ source: 'visual', quote: '   ' }))).toBe(false);
    expect(hasSpokenEvidence(match({ source: 'multimodal', quote: '' }))).toBe(false);
  });
});

describe('applyVisualRejection', () => {
  it('drops a purely visual match the footage did not support', () => {
    expect(applyVisualRejection(match({ source: 'visual', quote: null }))).toBeNull();
  });

  it('keeps a quoted match, demoted rather than deleted', () => {
    const rejected = applyVisualRejection(match({ quote: 'is that a Cybertruck?', confidence: 0.8 }));
    expect(rejected).not.toBeNull();
    expect(rejected!.confidence).toBeCloseTo(0.8 * SPOKEN_EVIDENCE_DEMOTION, 4);
  });

  it('keeps a transcript match even with no quote text', () => {
    expect(applyVisualRejection(match({ source: 'transcript', quote: null }))).not.toBeNull();
  });

  it('leaves everything except confidence untouched', () => {
    const original = match({ quote: 'spoken' });
    const rejected = applyVisualRejection(original)!;
    expect({ ...rejected, confidence: original.confidence }).toEqual(original);
  });

  it('demotes below a high-confidence claim without erasing it', () => {
    // The demotion must actually lower standing — a rejected match should not
    // outrank a confirmed one — while still surviving the default floor.
    const rejected = applyVisualRejection(match({ quote: 'spoken', confidence: 0.9 }))!;
    expect(rejected.confidence).toBeLessThan(0.9);
    expect(rejected.confidence).toBeGreaterThan(0.3);
  });
});
