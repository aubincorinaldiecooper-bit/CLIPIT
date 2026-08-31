import { assembleDeck, deckMetrics, planDeck } from '/home/user/CLIPIT/src/services/media/deckAssembly.js';
import type { VerticalCandidate } from '/home/user/CLIPIT/src/services/media/verticalVisibility.js';

function cand(id: string, confidence: number): VerticalCandidate {
  return { matchId: id, derivativeStatus: 'pending', derivativeStorageKey: null, posterStorageKey: null, confidence };
}
const ok = (c: VerticalCandidate, attempt: number) => ({
  ...c, attempts: attempt, failureStage: null,
  derivativeStatus: 'ready' as const, derivativeStorageKey: `d/${c.matchId}`, posterStorageKey: `p/${c.matchId}`,
});
const bad = (c: VerticalCandidate, attempt: number, stage: any = 'storage_upload') => ({
  ...c, attempts: attempt, failureStage: stage, derivativeStatus: 'failed' as const,
  derivativeStorageKey: null, posterStorageKey: null,
});

async function run(name: string, ranked: VerticalCandidate[], requested: number, effective: number,
  prep: (c: VerticalCandidate, a: number) => any, maxAttempts = 2) {
  const plan = planDeck(effective, 1.5, 8);
  const calls: string[] = [];
  const outcome = await assembleDeck(ranked, plan, async (c, a) => { calls.push(`${c.matchId}#${a}`); return prep(c, a); }, maxAttempts);
  const m = deckMetrics(outcome, 0, 1234, { requestedResultCount: requested, internalCandidateCount: ranked.length });
  console.log(`\n=== ${name} ===`);
  console.log('candidateTarget', plan.candidateTarget, 'plan.requested', plan.requested);
  console.log('prepare calls:', calls.join(', '));
  console.log('complete', outcome.complete, 'deck', outcome.deck.map(d => d.matchId));
  console.log(JSON.stringify(m, null, 1));
}

const A = cand('A', 0.9), B = cand('B', 0.8), C = cand('C', 0.7), D = cand('D', 0.6), E = cand('E', 0.5);

// (a) requested 3; A fails attempt 1 then succeeds; B ok; C ok
await run('(a)', [A, B, C, D, E], 3, 3, (c, a) => (c.matchId === 'A' && a === 1 ? bad(c, a) : ok(c, a)));

// (b) requested 3; A ok; B fails terminally (non-retryable); C ok; D ok
await run('(b)', [A, B, C, D, E], 3, 3, (c, a) => (c.matchId === 'B' ? bad(c, a, 'media_probe') : ok(c, a)));

// (b2) B fails on a RETRYABLE stage, exhausting attempts
await run('(b2 retryable B)', [A, B, C, D, E], 3, 3, (c, a) => (c.matchId === 'B' ? bad(c, a, 'storage_upload') : ok(c, a)));

// (c) requested 3, only 2 available, both succeed
await run('(c)', [A, B], 3, 2, (c, a) => ok(c, a));

// (d) requested 3, 2 available, 1 fails
await run('(d)', [A, B], 3, 2, (c, a) => (c.matchId === 'B' ? bad(c, a, 'media_probe') : ok(c, a)));

// (e) everything fails
await run('(e all fail)', [A, B, C, D, E], 3, 3, (c, a) => bad(c, a, 'media_probe'));
