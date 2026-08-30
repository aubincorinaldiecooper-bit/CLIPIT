import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/services/search/prompt.js';

describe('clip boundary instructions', () => {
  it('asks for the exact moment without unrelated context', () => {
    expect(SYSTEM_PROMPT).toContain('Mark the exact matching moment');
    expect(SYSTEM_PROMPT).toContain('Do not add lead-in, aftermath, or unrelated context');
    expect(SYSTEM_PROMPT).not.toContain('start slightly before');
  });
});
