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

  /**
   * The standing acceptance case. The phrase is painted on a car, but "say"
   * and the quotes both read as speech signals, so this scores on both sides
   * and resolves to `both` once a transcript exists.
   *
   * That is the right mode — it hands the model more evidence, not less. The
   * hazard lives downstream in the prompt: told to require every condition,
   * a model can find the car, fail to find the phrase in the transcript, and
   * discard a correct match. `prompt.ts` answers that by saying a quoted
   * phrase may be satisfied by on-screen text, so this pins the input that
   * makes the rule necessary.
   */
  it('sends the on-screen-text acceptance case to both, not transcript', () => {
    const instruction = 'find the scene where it shows the car that say "bought with investor money"';

    const classification = classifyInstruction(instruction);
    expect(classification.spokenScore).toBeGreaterThan(0);
    expect(classification.visualScore).toBeGreaterThan(0);
    expect(classification.mode).toBe('both');

    expect(resolveSearchMode({ instruction, requested: 'auto', transcriptAvailable: true }).mode).toBe('both');
    // Without a transcript it must still search, visually rather than not at all.
    expect(resolveSearchMode({ instruction, requested: 'auto', transcriptAvailable: false }).mode).toBe('visual');
  });
});
