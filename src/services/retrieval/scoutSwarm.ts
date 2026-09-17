import { logger } from '../../lib/logger.js';

export const SCOUT_IDS = ['scout-1', 'scout-2', 'scout-3', 'scout-4'] as const;
export type ScoutId = (typeof SCOUT_IDS)[number];
export interface ScoutCandidate { id: string; }
export interface ScoutProposal { startSeconds: number; endSeconds: number; description: string; confidence?: number; }
export interface ScoutInspectionPlan {
  startSeconds: number;
  endSeconds: number;
  mode: 'coarse' | 'continuous';
  burstSeconds?: number;
  strideSeconds?: number;
}
export interface ScoutInspection {
  moments: ScoutProposal[];
  mediaSecondsObserved?: number;
  exhausted?: boolean;
  exhaustive?: boolean;
  metrics?: Record<string, unknown>;
}
export interface ScoutRuntime<Candidate extends ScoutCandidate> {
  inspect(input: {
    scoutId: ScoutId;
    searchId: string;
    query: string;
    candidate: Candidate;
    plan: ScoutInspectionPlan;
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

const MERGE_GAP_SECONDS = 2;

function sameThing(one: string, other: string): boolean {
  const plain = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  return plain(one) === plain(other);
}

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
  searchId: string;
  query: string;
  candidates: Candidate[];
  runtime: ScoutRuntime<Candidate>;
  maxCandidates?: number;
  timeoutMs?: number;
  maxMomentSeconds?: number;
  horizonSeconds?: number;
  coarseBurstSeconds?: number;
  coarseStrideSeconds?: number;
  densePaddingSeconds?: number;
  maxDenseWindowsPerCandidate?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ScoutSwarmProgress<Candidate>) => void | Promise<void>;
}): Promise<ScoutSwarmResult<Candidate>> {
  const startedAt = Date.now();
  const maxCandidates = Math.max(1, Math.min(7, input.maxCandidates ?? 7));
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 10 * 60_000);
  const maxMomentSeconds = Math.max(1, input.maxMomentSeconds ?? 60);
  const horizonSeconds = Math.max(4, Math.min(600, input.horizonSeconds ?? 600));
  const coarseBurstSeconds = Math.max(0.25, Math.min(5, input.coarseBurstSeconds ?? 1));
  const coarseStrideSeconds = Math.max(coarseBurstSeconds, Math.min(30, input.coarseStrideSeconds ?? 5));
  const densePaddingSeconds = Math.max(1, Math.min(30, input.densePaddingSeconds ?? 6));
  const maxDenseWindows = Math.max(1, Math.min(8, input.maxDenseWindowsPerCandidate ?? 4));
  const candidates = input.candidates.slice(0, maxCandidates);
  const sectionSeconds = horizonSeconds / SCOUT_IDS.length;
  const log = logger.child({ search_id: input.searchId, component: 'scout_swarm' });
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('search cancelled'));
  if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('scout swarm wall-time ceiling reached')), timeoutMs); timeout.unref?.();

  let candidatesAssigned = 0, candidatesCompleted = 0, activeOperations = 0, inspectOperations = 0, mediaSecondsObserved = 0, momentSequence = 0, candidatesPartlyExamined = 0;
  const moments: SwarmMoment<Candidate>[] = [];
  const failures: ScoutSwarmFailure[] = [];
  const snapshot = (): ScoutSwarmSnapshot<Candidate> => ({ scoutCount: 4, candidatesTotal: candidates.length, candidatesAssigned, candidatesCompleted, activeOperations, momentsFound: moments.length, moments: moments.map((moment) => ({ ...moment })) });
  const emit = async (event: ScoutSwarmProgress<Candidate>['event'], detail: { scoutId?: ScoutId; candidateId?: string; momentId?: string } = {}) => {
    const stage: ScoutSwarmProgress<Candidate>['stage'] = controller.signal.aborted ? 'cancelled' : event === 'swarm.completed' ? 'complete' : 'searching';
    const progress: ScoutSwarmProgress<Candidate> = { stage, event, ...detail, snapshot: snapshot() };
    log.debug(event, { scout_id: detail.scoutId, candidate_id: detail.candidateId, moment_id: detail.momentId, ...progress.snapshot });
    await input.onProgress?.(progress);
  };

  const continues = (proposal: ScoutProposal, candidate: Candidate): SwarmMoment<Candidate> | null => {
    const previous = moments.findLast((moment) => moment.candidate.id === candidate.id);
    if (!previous) return null;
    if (proposal.startSeconds < previous.startSeconds) return null;
    if (proposal.startSeconds - previous.endSeconds > MERGE_GAP_SECONDS) return null;
    if (!sameThing(proposal.description, previous.description)) return null;
    if (Math.max(previous.endSeconds, proposal.endSeconds) - previous.startSeconds > maxMomentSeconds) return null;
    return previous;
  };

  const accept = async (proposal: ScoutProposal, scoutId: ScoutId, candidate: Candidate) => {
    if (!Number.isFinite(proposal.startSeconds) || !Number.isFinite(proposal.endSeconds)) return;
    if (proposal.startSeconds < 0 || proposal.endSeconds <= proposal.startSeconds) return;
    if (proposal.endSeconds - proposal.startSeconds > maxMomentSeconds) {
      failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason: `proposed moment exceeds ${maxMomentSeconds}s maximum` });
      return;
    }
    const previous = continues(proposal, candidate);
    if (previous) {
      previous.endSeconds = Math.max(previous.endSeconds, proposal.endSeconds);
      if (proposal.confidence !== undefined) previous.confidence = previous.confidence === undefined ? proposal.confidence : Math.max(previous.confidence, proposal.confidence);
      await emit('moment.extended', { scoutId, candidateId: candidate.id, momentId: previous.id });
      return;
    }
    momentSequence += 1;
    const moment: SwarmMoment<Candidate> = { id: `moment-${momentSequence}`, candidate, scoutId, startSeconds: proposal.startSeconds, endSeconds: proposal.endSeconds, description: proposal.description, confidence: proposal.confidence };
    moments.push(moment);
    await emit('moment.found', { scoutId, candidateId: candidate.id, momentId: moment.id });
  };

  const inspect = async (scoutId: ScoutId, candidate: Candidate, plan: ScoutInspectionPlan, onMoment?: (moment: ScoutProposal) => Promise<void>) => {
    activeOperations += 1;
    inspectOperations += 1;
    await emit('scout.candidate_assigned', { scoutId, candidateId: candidate.id });
    try {
      const inspection = await abortable(input.runtime.inspect({ scoutId, searchId: input.searchId, query: input.query, candidate, plan, signal: controller.signal, onMoment }), controller.signal);
      mediaSecondsObserved += Math.max(0, inspection.mediaSecondsObserved ?? 0);
      return inspection;
    } catch (error) {
      if (!controller.signal.aborted) failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason: errorMessage(error) });
      return null;
    } finally {
      activeOperations -= 1;
      await emit('scout.candidate_completed', { scoutId, candidateId: candidate.id });
    }
  };

  await emit('swarm.started');
  try {
    for (const candidate of candidates) {
      if (controller.signal.aborted) break;
      candidatesAssigned += 1;

      const coarseRuns = await Promise.all(SCOUT_IDS.map(async (scoutId, index) => {
        const startSeconds = index * sectionSeconds;
        const endSeconds = Math.min(horizonSeconds, startSeconds + sectionSeconds);
        const inspection = await inspect(scoutId, candidate, {
          startSeconds,
          endSeconds,
          mode: 'coarse',
          burstSeconds: coarseBurstSeconds,
          strideSeconds: coarseStrideSeconds,
        });
        return { scoutId, inspection };
      }));

      // Sparse coverage deliberately leaves gaps, so this candidate cannot be
      // used to prove absence even if every assigned coarse range completed.
      if (coarseRuns.some(({ inspection }) => inspection === null || inspection.exhaustive !== true)) candidatesPartlyExamined += 1;

      const coarseHits: Array<{ scoutId: ScoutId; proposal: ScoutProposal }> = [];
      for (const { scoutId, inspection } of coarseRuns) {
        if (!inspection) continue;
        for (const proposal of inspection.moments) coarseHits.push({ scoutId, proposal });
      }

      // Collapse overlapping coarse hits before spending dense GPU time. The
      // coarse pass is only a locator; nothing is surfaced until a continuous
      // local re-watch actually sees the requested evidence.
      coarseHits.sort((a, b) => a.proposal.startSeconds - b.proposal.startSeconds);
      const targets: Array<{ scoutId: ScoutId; proposal: ScoutProposal }> = [];
      for (const hit of coarseHits) {
        const overlaps = targets.some((target) => {
          const a0 = hit.proposal.startSeconds - densePaddingSeconds;
          const a1 = hit.proposal.endSeconds + densePaddingSeconds;
          const b0 = target.proposal.startSeconds - densePaddingSeconds;
          const b1 = target.proposal.endSeconds + densePaddingSeconds;
          return a0 <= b1 && b0 <= a1;
        });
        if (!overlaps) targets.push(hit);
        if (targets.length >= maxDenseWindows) break;
      }

      await Promise.all(targets.map(async (target, index) => {
        const scoutId = SCOUT_IDS[index % SCOUT_IDS.length]!;
        let streamed = 0;
        const dense = await inspect(scoutId, candidate, {
          startSeconds: Math.max(0, target.proposal.startSeconds - densePaddingSeconds),
          endSeconds: Math.min(horizonSeconds, target.proposal.endSeconds + densePaddingSeconds),
          mode: 'continuous',
        }, async (proposal) => {
          streamed += 1;
          await accept(proposal, scoutId, candidate);
        });
        if (dense && streamed === 0) for (const proposal of dense.moments) await accept(proposal, scoutId, candidate);
      }));

      candidatesCompleted += 1;
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
    await Promise.all(SCOUT_IDS.map((scoutId) => input.runtime.closeScout?.(scoutId)));
  }

  const cancelled = controller.signal.aborted;
  const status: ScoutSwarmResult<Candidate>['status'] = cancelled ? 'cancelled' : input.candidates.length > candidates.length ? 'ceiling_reached' : 'completed';
  await emit(cancelled ? 'swarm.cancelled' : 'swarm.completed');
  return {
    searchId: input.searchId,
    status,
    scoutCount: 4,
    candidatesAvailable: input.candidates.length,
    candidatesConsidered: candidates.length,
    candidatesCompleted,
    candidatesPartlyExamined,
    moments,
    failures,
    metrics: { wallMs: Date.now() - startedAt, inspectOperations, mediaSecondsObserved },
  };
}
