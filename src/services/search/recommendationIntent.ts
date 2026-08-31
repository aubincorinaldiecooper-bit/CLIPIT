export type CreatorSearchIntent = 'recommendation' | 'visual' | 'mixed' | 'standard';

const RECOMMENDATION = [
  /\b(what|which) should i (post|share|clip)\b/i,
  /\b(give|find|pick|suggest|recommend)\b.*\b(good|best|strongest|top|viral|moments?|clips?)\b/i,
  /\b(moments?|clips?)\b.*\b(for )?(tiktok|reels?|shorts?)\b/i,
  /\b(content|highlights?)\b.*\b(post|share)\b/i,
];

/** A small, deterministic routing distinction; explicit API modes still win. */
export function classifyCreatorSearchIntent(
  instruction: string,
  visualScore: number,
  requestedMode: 'auto' | 'visual' | 'transcript' | 'both',
): CreatorSearchIntent {
  const recommendation = RECOMMENDATION.some((pattern) => pattern.test(instruction));
  const visual = requestedMode === 'visual' || visualScore > 0;
  if (recommendation && visual) return 'mixed';
  if (recommendation) return 'recommendation';
  if (visual) return 'visual';
  return 'standard';
}

export function isFastCandidateIntent(intent: CreatorSearchIntent): boolean {
  return intent === 'recommendation' || intent === 'mixed';
}

/** Snaps close model boundaries to transcript edges without stretching far. */
export function snapRangeToTranscript(
  range: { startSeconds: number; endSeconds: number },
  segments: Array<{ startSeconds: number; endSeconds: number }>,
  toleranceSeconds = 3,
): { startSeconds: number; endSeconds: number } {
  const starts = segments.map((segment) => segment.startSeconds);
  const ends = segments.map((segment) => segment.endSeconds);
  const nearest = (value: number, choices: number[]) => choices.length === 0 ? value : choices.slice(1).reduce(
    (best, choice) => Math.abs(choice - value) < Math.abs(best - value) ? choice : best,
    choices[0]!,
  );
  const start = nearest(range.startSeconds, starts);
  const end = nearest(range.endSeconds, ends);
  return {
    startSeconds: Math.abs(start - range.startSeconds) <= toleranceSeconds ? start : range.startSeconds,
    endSeconds: Math.abs(end - range.endSeconds) <= toleranceSeconds ? end : range.endSeconds,
  };
}
