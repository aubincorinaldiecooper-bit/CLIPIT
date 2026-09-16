import { logger } from '../../lib/logger.js';

export const SCOUT_IDS = ['scout-1', 'scout-2', 'scout-3', 'scout-4'] as const;
export type ScoutId = (typeof SCOUT_IDS)[number];
export interface ScoutCandidate { id: string; }
export interface ScoutProposal { startSeconds: number; endSeconds: number; description: string; confidence?: number; }
export interface ScoutInspection { moments: ScoutProposal[]; mediaSecondsObserved?: number; exhausted?: boolean; metrics?: Record<string, unknown>; }
export interface ScoutRuntime<Candidate extends ScoutCandidate> {
  inspect(input: {
    scoutId: ScoutId;
    searchId: string;
    query: string;
    candidate: Candidate;
    signal: AbortSignal;
    onMoment?: (moment: ScoutProposal) => void | Promise<void>;
  }): Promise<ScoutInspection>;
  closeScout?(scoutId: ScoutId): Promise<void>;
}
export interface SwarmMoment<Candidate extends ScoutCandidate> { id: string; candidate: Candidate; scoutId: ScoutId; startSeconds: number; endSeconds: number; description: string; confidence?: number; }
export interface ScoutSwarmSnapshot<Candidate extends ScoutCandidate> { scoutCount: 4; candidatesTotal: number; candidatesAssigned: number; candidatesCompleted: number; activeOperations: number; momentsFound: number; moments: SwarmMoment<Candidate>[]; }
export interface ScoutSwarmProgress<Candidate extends ScoutCandidate> {
  stage: 'searching' | 'complete' | 'cancelled';
  event: 'swarm.started' | 'scout.candidate_assigned' | 'scout.candidate_completed' | 'moment.found' | 'moment.extended' | 'swarm.completed' | 'swarm.cancelled';
  scoutId?: ScoutId; candidateId?: string; momentId?: string; snapshot: ScoutSwarmSnapshot<Candidate>;
}
export interface ScoutSwarmFailure { scoutId: ScoutId; candidateId: string; stage: 'inspect'; reason: string; }
export interface ScoutSwarmResult<Candidate extends ScoutCandidate> {
  searchId: string; status: 'completed' | 'ceiling_reached' | 'cancelled'; scoutCount: 4; candidatesAvailable: number; candidatesConsidered: number; candidatesCompleted: number;
  candidatesPartlyExamined: number; moments: SwarmMoment<Candidate>[]; failures: ScoutSwarmFailure[];
  metrics: { wallMs: number; inspectOperations: number; mediaSecondsObserved: number; };
}
/**
 * How far apart two findings can be and still be one moment, in seconds.
 *
 * A live watcher is asked about one frame at a time, so something that lasts
 * four seconds answers four times. Left alone that becomes four cards a second
 * apart, all describing the same event, filling a results band that holds five.
 *
 * Two seconds is one missed look at a frame a second: enough to ride over a
 * frame the model did not match in the middle of something it did, without
 * joining two things that happened at different times.
 */
const MERGE_GAP_SECONDS = 2;

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); }, (error) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

export async function runScoutSwarm<Candidate extends ScoutCandidate>(input: {
  searchId: string; query: string; candidates: Candidate[]; runtime: ScoutRuntime<Candidate>; maxCandidates?: number; timeoutMs?: number; maxMomentSeconds?: number; signal?: AbortSignal;
  onProgress?: (progress: ScoutSwarmProgress<Candidate>) => void | Promise<void>;
}): Promise<ScoutSwarmResult<Candidate>> {
  const startedAt = Date.now();
  const maxCandidates = Math.max(1, Math.min(15, input.maxCandidates ?? 15));
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 5 * 60_000);
  const maxMomentSeconds = Math.max(1, input.maxMomentSeconds ?? 60);
  const candidates = input.candidates.slice(0, maxCandidates);
  const log = logger.child({ search_id: input.searchId, component: 'scout_swarm' });
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('search cancelled'));
  if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('scout swarm wall-time ceiling reached')), timeoutMs); timeout.unref?.();

  let candidateCursor = 0, candidatesAssigned = 0, candidatesCompleted = 0, activeOperations = 0, inspectOperations = 0, mediaSecondsObserved = 0, momentSequence = 0, candidatesPartlyExamined = 0;
  const moments: SwarmMoment<Candidate>[] = []; const failures: ScoutSwarmFailure[] = [];
  const snapshot = (): ScoutSwarmSnapshot<Candidate> => ({ scoutCount: 4, candidatesTotal: candidates.length, candidatesAssigned, candidatesCompleted, activeOperations, momentsFound: moments.length, moments: moments.map((moment) => ({ ...moment })) });
  const emit = async (event: ScoutSwarmProgress<Candidate>['event'], detail: { scoutId?: ScoutId; candidateId?: string; momentId?: string } = {}) => {
    const stage: ScoutSwarmProgress<Candidate>['stage'] = controller.signal.aborted ? 'cancelled' : event === 'swarm.completed' ? 'complete' : 'searching';
    const progress: ScoutSwarmProgress<Candidate> = { stage, event, ...detail, snapshot: snapshot() };
    log.debug(event, { scout_id: detail.scoutId, candidate_id: detail.candidateId, moment_id: detail.momentId, ...progress.snapshot });
    await input.onProgress?.(progress);
  };
  /**
   * The moment this finding continues, when it continues one.
   *
   * Scouts watch different pages at the same time, so the newest finding for
   * this page is not necessarily the newest finding overall: the list has to be
   * searched backwards for this page's own last moment rather than read off the
   * end.
   */
  const continues = (proposal: ScoutProposal, scoutId: ScoutId, candidate: Candidate): SwarmMoment<Candidate> | null => {
    const previous = moments.findLast((moment) => moment.candidate.id === candidate.id && moment.scoutId === scoutId);
    if (!previous) return null;
    // Frames arrive in order. A finding that starts before the moment it would
    // join is not a continuation of it.
    if (proposal.startSeconds < previous.startSeconds) return null;
    if (proposal.startSeconds - previous.endSeconds > MERGE_GAP_SECONDS) return null;
    // Growing past the ceiling would turn a stretch the product does not call a
    // moment into one card. Beyond it the finding starts a moment of its own.
    if (Math.max(previous.endSeconds, proposal.endSeconds) - previous.startSeconds > maxMomentSeconds) return null;
    return previous;
  };
  const accept = async (proposal: ScoutProposal, scoutId: ScoutId, candidate: Candidate) => {
    if (!Number.isFinite(proposal.startSeconds) || !Number.isFinite(proposal.endSeconds)) return;
    if (proposal.startSeconds < 0 || proposal.endSeconds <= proposal.startSeconds) return;
    if (proposal.endSeconds - proposal.startSeconds > maxMomentSeconds) {
      failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason: `proposed moment exceeds ${maxMomentSeconds}s maximum` }); return;
    }
    const previous = continues(proposal, scoutId, candidate);
    if (previous) {
      // The same event, still going. The moment already on screen grows to
      // cover it; a second card would only say the same thing again. The words
      // stay as first given — they are what the model said as it began.
      previous.endSeconds = Math.max(previous.endSeconds, proposal.endSeconds);
      await emit('moment.extended', { scoutId, candidateId: candidate.id, momentId: previous.id });
      return;
    }
    momentSequence += 1;
    const moment: SwarmMoment<Candidate> = { id: `moment-${momentSequence}`, candidate, scoutId, startSeconds: proposal.startSeconds, endSeconds: proposal.endSeconds, description: proposal.description, confidence: proposal.confidence };
    moments.push(moment);
    await emit('moment.found', { scoutId, candidateId: candidate.id, momentId: moment.id });
  };

  await emit('swarm.started');
  const worker = async (scoutId: ScoutId) => {
    try {
      while (!controller.signal.aborted) {
        const index = candidateCursor++; if (index >= candidates.length) return;
        const candidate = candidates[index]!; candidatesAssigned += 1; activeOperations += 1; inspectOperations += 1;
        await emit('scout.candidate_assigned', { scoutId, candidateId: candidate.id });
        let streamed = 0;
        try {
          const inspection = await abortable(input.runtime.inspect({
            scoutId, searchId: input.searchId, query: input.query, candidate, signal: controller.signal,
            onMoment: async (proposal) => { streamed += 1; await accept(proposal, scoutId, candidate); },
          }), controller.signal);
          mediaSecondsObserved += Math.max(0, inspection.mediaSecondsObserved ?? 0);
          if (inspection.exhausted !== true) candidatesPartlyExamined += 1;
          if (streamed === 0) for (const proposal of inspection.moments) await accept(proposal, scoutId, candidate);
        } catch (error) {
          if (controller.signal.aborted) candidatesPartlyExamined += 1;
          else failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason: errorMessage(error) });
        } finally {
          activeOperations -= 1; candidatesCompleted += 1; await emit('scout.candidate_completed', { scoutId, candidateId: candidate.id });
        }
      }
    } finally { await input.runtime.closeScout?.(scoutId); }
  };

  try { await Promise.all(SCOUT_IDS.map((scoutId) => worker(scoutId))); }
  finally { clearTimeout(timeout); input.signal?.removeEventListener('abort', forwardAbort); }
  const cancelled = controller.signal.aborted;
  const status: ScoutSwarmResult<Candidate>['status'] = cancelled ? 'cancelled' : input.candidates.length > candidates.length ? 'ceiling_reached' : 'completed';
  await emit(cancelled ? 'swarm.cancelled' : 'swarm.completed');
  return { searchId: input.searchId, status, scoutCount: 4, candidatesAvailable: input.candidates.length, candidatesConsidered: candidates.length, candidatesCompleted, candidatesPartlyExamined, moments, failures, metrics: { wallMs: Date.now() - startedAt, inspectOperations, mediaSecondsObserved } };
}
