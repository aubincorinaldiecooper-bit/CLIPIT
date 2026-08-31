import { describe, expect, it } from 'vitest';
import { classifyInstruction } from '../src/services/search/instructionMode.js';
import { classifyCreatorSearchIntent, isFastCandidateIntent, snapRangeToTranscript } from '../src/services/search/recommendationIntent.js';
import {
  exceedsPlatformHardMax,
  parseExplicitDurationSeconds,
  resolvePlatformOutput,
} from '../src/services/search/platformOutput.js';

describe('fast creator recommendation routing', () => {
  it('routes generic and TikTok recommendations to the transcript shortlist path', () => {
    for (const instruction of ['find me moments for TikTok', 'what should I post?', 'give me some good clips']) {
      const classified = classifyInstruction(instruction);
      expect(isFastCandidateIntent(classifyCreatorSearchIntent(instruction, classified.visualScore, 'auto'))).toBe(true);
    }
  });

  it('keeps an explicitly visual bottle search on visual footage search', () => {
    const instruction = 'find when the person holds a bottle';
    const classified = classifyInstruction(instruction);
    expect(classifyCreatorSearchIntent(instruction, classified.visualScore, 'auto')).toBe('visual');
    expect(isFastCandidateIntent('visual')).toBe(false);
  });

  it('distinguishes a recommendation containing a visual requirement as mixed', () => {
    const instruction = 'find the best clip where he holds the bottle';
    const classified = classifyInstruction(instruction);
    expect(classifyCreatorSearchIntent(instruction, classified.visualScore, 'auto')).toBe('mixed');
  });
});

describe('platform output enforcement', () => {
  it('enforces the Clipit TikTok defaults structurally', () => {
    const active = resolvePlatformOutput('Find me moments for TikTok', 300)!;
    expect(active.profile).toEqual({ targetMinSeconds: 15, targetMaxSeconds: 45, hardMaxSeconds: 60 });
    expect(exceedsPlatformHardMax({ startSeconds: 10, endSeconds: 70 }, active)).toBe(false);
    expect(exceedsPlatformHardMax({ startSeconds: 10, endSeconds: 70.01 }, active)).toBe(true);
    expect(active.profile.targetMaxSeconds).toBe(45);
  });

  it('causes a 75-second default TikTok candidate to require refinement', () => {
    const active = resolvePlatformOutput('Find me TikTok moments', 300)!;
    expect(exceedsPlatformHardMax({ startSeconds: 20, endSeconds: 95 }, active)).toBe(true);
  });

  it('lets an explicit 90-second request override the default hard maximum', () => {
    const active = resolvePlatformOutput('give me a 90 second TikTok clip', 300)!;
    expect(parseExplicitDurationSeconds('give me a 90 second TikTok clip')).toBe(90);
    expect(active.explicitDurationSeconds).toBe(90);
    expect(active.hardMaxSeconds).toBe(300);
    expect(exceedsPlatformHardMax({ startSeconds: 0, endSeconds: 90 }, active)).toBe(false);
  });
});

it('snaps targeted boundaries to nearby source-global transcript sentence edges', () => {
  expect(snapRangeToTranscript(
    { startSeconds: 101.2, endSeconds: 128.4 },
    [{ startSeconds: 100, endSeconds: 115 }, { startSeconds: 115, endSeconds: 130 }],
  )).toEqual({ startSeconds: 100, endSeconds: 130 });
});
