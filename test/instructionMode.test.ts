import { describe, expect, it } from 'vitest';
import { classifyInstruction, resolveSearchMode } from '../src/services/search/instructionMode.js';

describe('classifyInstruction', () => {
  it('routes spoken-content instructions to the transcript', () => {
    expect(classifyInstruction('Find the part where I explain why I left').mode).toBe('transcript');
    expect(classifyInstruction('Clip every time someone mentions the new pricing').mode).toBe('transcript');
    expect(classifyInstruction('Where do they discuss the merger?').mode).toBe('transcript');
  });

  it('routes on-screen instructions to the visual search', () => {
    expect(classifyInstruction('Clip every time I score a goal').mode).toBe('visual');
    expect(classifyInstruction('Clip the boss fight').mode).toBe('visual');
    expect(classifyInstruction('Find when John joins the stream').mode).toBe('visual');
  });

  it('searches both when the instruction mixes signals', () => {
    expect(classifyInstruction('Clip where he explains the boss fight strategy').mode).toBe('both');
  });

  it('searches both when nothing is recognisable', () => {
    const result = classifyInstruction('the good bit');

    expect(result.mode).toBe('both');
    expect(result.rationale).toContain('no strong');
  });

  it('treats a quoted phrase as spoken content', () => {
    expect(classifyInstruction('Find "we are shutting it down"').mode).toBe('transcript');
  });

  it('handles an empty instruction without throwing', () => {
    expect(classifyInstruction('').mode).toBe('both');
  });
});

describe('resolveSearchMode', () => {
  it('uses the classifier in auto mode', () => {
    const result = resolveSearchMode({
      instruction: 'Clip the boss fight',
      requested: 'auto',
      transcriptAvailable: true,
    });

    expect(result.mode).toBe('visual');
    expect(result.rationale).toContain('auto');
  });

  it('honours an explicit mode over the classifier', () => {
    const result = resolveSearchMode({
      instruction: 'Clip the boss fight',
      requested: 'transcript',
      transcriptAvailable: true,
    });

    expect(result.mode).toBe('transcript');
  });

  it('falls back to visual when no transcript exists', () => {
    const result = resolveSearchMode({
      instruction: 'Find the part where I explain why I left',
      requested: 'auto',
      transcriptAvailable: false,
    });

    expect(result.mode).toBe('visual');
    expect(result.rationale).toContain('no transcript');
  });

  it('downgrades an explicit transcript request when no transcript exists', () => {
    const result = resolveSearchMode({
      instruction: 'anything',
      requested: 'transcript',
      transcriptAvailable: false,
    });

    expect(result.mode).toBe('visual');
  });

  it('leaves an explicit visual request untouched without a transcript', () => {
    const result = resolveSearchMode({
      instruction: 'Clip the boss fight',
      requested: 'visual',
      transcriptAvailable: false,
    });

    expect(result.mode).toBe('visual');
    expect(result.rationale).not.toContain('falling back');
  });
});
