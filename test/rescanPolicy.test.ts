import { describe, expect, it } from 'vitest';
import { isCorrection } from '../src/services/search/rescanPolicy.js';

/**
 * This detector decides whether to search what the user typed or to silently
 * replace it with their previous question. Both mistakes are bad in different
 * ways: a missed correction searches the video for the words "are you sure"
 * and reports an absence, while a false positive throws away a real question
 * and answers a different one.
 */
describe('telling a correction from a question', () => {
  it.each([
    'are you sure?',
    'Are you certain',
    'look again',
    'look harder',
    'look more carefully',
    'try again',
    'check again',
    'search again please',
    "that's wrong",
    'that is not right',
    'you missed it',
    'you missed one',
    'keep looking',
    'rescan',
    're-check it',
    "it's definitely there",
    'it is definitely there',
    'watch the video again',
    'go back and look',
  ])('recognises a correction: %s', (text) => {
    expect(isCorrection(text)).toBe(true);
  });

  it.each([
    'clip every time a cybertruck is seen',
    'find the part where they introduce themselves',
    'show me the sign that says OPEN',
    // Contains "again" but describes a moment: someone doing something twice.
    'the moment he tries again after dropping the ball',
    // Describes where to look, so it is an instruction, not an aside. Replacing
    // it with the previous question would discard everything specific in it.
    'check again around the part where they open the boot of the car and unload it',
    '',
    '   ',
  ])('leaves a real instruction alone: %s', (text) => {
    expect(isCorrection(text)).toBe(false);
  });

  /**
   * The length rule, stated as its own case because it is the thing standing
   * between a correction and a hijacked question.
   */
  it('treats a short aside as a correction and a long sentence as an instruction', () => {
    expect(isCorrection('look again')).toBe(true);
    expect(
      isCorrection('look again at the bit near the end where the red car pulls into the driveway slowly'),
    ).toBe(false);
  });
});
