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

  /**
   * This previously asserted `transcript`, which encoded the assumption that
   * quoting something proves it was said. It does not: the phrase may be a
   * chyron, a slide, or paint on a car. Routing to `transcript` sends no
   * video, so that assumption made visible text unfindable.
   */
  it('treats a quoted phrase as ambiguous, not as proof of speech', () => {
    const result = classifyInstruction('Find "we are shutting it down"');

    expect(result.mode).toBe('both');
    expect(result.spokenScore).toBe(0);
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

  /**
   * `transcript` mode sends no video at all, so routing there decides the
   * outcome before the model sees anything: a phrase that is only ever on
   * screen becomes unfindable. A quoted phrase alone must never make that
   * choice.
   */
  it.each([
    'Find "SALE"',
    'the sign that says "EXIT"',
    'clip the moment with “bought with investor money”',
    'where it says "SOLD OUT"',
  ])('keeps the video for the ambiguous quoted instruction: %s', (instruction) => {
    expect(classifyInstruction(instruction).mode).not.toBe('transcript');
    expect(resolveSearchMode({ instruction, requested: 'auto', transcriptAvailable: true }).mode)
      .not.toBe('transcript');
  });

  it('still routes unquoted spoken instructions to the transcript alone', () => {
    // The cheap path has to survive: this is speech with nothing to look at.
    expect(classifyInstruction('find where he explains the pricing model').mode).toBe('transcript');
    expect(classifyInstruction('the part where they discuss hiring').mode).toBe('transcript');
  });

  /** Instructions are pasted from editors that rewrite quotes as they are typed. */
  it.each([
    ['curly double', 'where it says “SALE”'],
    ['curly single', 'where it says ‘SALE’'],
    ['straight single', "where it says 'SALE'"],
    ['straight double', 'where it says "SALE"'],
    // An apostrophe inside the quotation used to close it early, losing the match.
    ['curly single around a contraction', 'where it says ‘I’m done’'],
    ['straight single around a contraction', "where it says 'I'm done'"],
    ['quotation containing a possessive', 'the sign reading “Bob’s Diner”'],
  ])('treats a %s as ambiguous', (_label, instruction) => {
    expect(classifyInstruction(instruction).mode).not.toBe('transcript');
  });

  /**
   * The apostrophe is the same character as the straight closing quote, and
   * the curly apostrophe (’) the same as the curly one. Ordinary contractions
   * must not read as a quotation, or every plain speech search pays for a
   * full video upload it cannot use.
   */
  it.each([
    "find where he's explaining why it isn't available",
    'find where he’s explaining why it isn’t available',
    "the part where they don't answer the question",
  ])('does not read contractions as a quoted phrase: %s', (instruction) => {
    expect(classifyInstruction(instruction).mode).toBe('transcript');
  });

  it('reads text written on an object as something to look at', () => {
    expect(classifyInstruction('the writing on his shirt').visualScore).toBeGreaterThan(0);
    expect(classifyInstruction('the licence plate').visualScore).toBeGreaterThan(0);
    expect(classifyInstruction('what the banner reads').visualScore).toBeGreaterThan(0);
  });

  /** An explicit request is the caller's call and stays honoured. */
  it('does not upgrade an explicitly requested transcript search', () => {
    const result = resolveSearchMode({
      instruction: 'Find "SALE"',
      requested: 'transcript',
      transcriptAvailable: true,
    });

    expect(result.mode).toBe('transcript');
  });
});
