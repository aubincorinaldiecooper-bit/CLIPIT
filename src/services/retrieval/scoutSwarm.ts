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
export interface SwarmMoment<Candidate extends ScoutCandidate> { id: string; candidate: Candidate; scoutId: ScoutId; startSeconds: number; endSeconds: number; description: string; confidence?: number; scoutVotes: number; }
export interface ScoutSwarmSnapshot<Candidate extends ScoutCandidate> { scoutCount: 4; candidatesTotal: number; candidatesAssigned: number; candidatesCompleted: number; activeOperations: number; momentsFound: number; moments: SwarmMoment<Candidate>[]; }
export interface ScoutSwarmProgress<Candidate extends ScoutCandidate> {
  stage: 'searching' | 'complete' | 'cancelled';
  event: 'swarm.started' | 'scout.candidate_assigned' | 'scout.candidate_completed' | 'moment.found' | 'moment.extended' | 'swarm.completed' | 'swarm.cancelled';
  scoutId?: ScoutId; candidateId?: string; momentId?: string; snapshot: ScoutSwarmSnapshot<Candidate>;
}
export interface ScoutSwarmFailure { scoutId: ScoutId; candidateId: string; stage: 'inspect'; reason: string; }
export interface ScoutInspectionTelemetry {
  scoutId: ScoutId;
  candidateId: string;
  mode: ScoutInspectionPlan['mode'];
  startSeconds: number;
  endSeconds: number;
  wallMs: number;
  mediaSecondsObserved: number;
  exhaustive: boolean;
  exhausted: boolean;
  success: boolean;
  failureReason?: string;
  metrics: Record<string, unknown>;
}
export interface ScoutSwarmResult<Candidate extends ScoutCandidate> {
  searchId: string; status: 'completed' | 'ceiling_reached' | 'cancelled'; scoutCount: 4; candidatesAvailable: number; candidatesConsidered: number; candidatesCompleted: number;
  candidatesPartlyExamined: number; moments: SwarmMoment<Candidate>[]; failures: ScoutSwarmFailure[];
  inspections: ScoutInspectionTelemetry[];
  metrics: { wallMs: number; inspectOperations: number; mediaSecondsObserved: number; firstMomentMs: number | null; };
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
  const candidates = input.candidates.slice(0, maxCandidates);
  const scoutOffsetSeconds = coarseStrideSeconds / SCOUT_IDS.length;
  const voteWindowSeconds = Math.max(coarseBurstSeconds, scoutOffsetSeconds * 1.5);
  const log = logger.child({ search_id: input.searchId, component: 'scout_swarm' });
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('search cancelled'));
  if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('scout swarm wall-time ceiling reached')), timeoutMs); timeout.unref?.();

  let candidatesAssigned = 0, candidatesCompleted = 0, activeOperations = 0, inspectOperations = 0, mediaSecondsObserved = 0, momentSequence = 0, candidatesPartlyExamined = 0;
  let firstMomentAt: number | null = null;
  const moments: SwarmMoment<Candidate>[] = [];
  const failures: ScoutSwarmFailure[] = [];
  const inspections: ScoutInspectionTelemetry[] = [];
  const snapshot = (): ScoutSwarmSnapshot<Candidate> => ({ scoutCount: 4, candidatesTotal: candidates.length, candidatesAssigned, candidatesCompleted, activeOperations, momentsFound: moments.length, moments: moments.map((moment) => ({ ...moment })) });
  const emit = async (event: ScoutSwarmProgress<Candidate>['event'], detail: { scoutId?: ScoutId; candidateId?: string; momentId?: string } = {}) => {
    const stage: ScoutSwarmProgress<Candidate>['stage'] = controller.signal.aborted ? 'cancelled' : event === 'swarm.completed' ? 'complete' : 'searching';
    const progress: ScoutSwarmProgress<Candidate> = { stage, event, ...detail, snapshot: snapshot() };
    log.debug(event, { scout_id: detail.scoutId, candidate_id: detail.candidateId, moment_id: detail.momentId, ...progress.snapshot });
    await input.onProgress?.(progress);
  };

  const inspect = async (scoutId: ScoutId, candidate: Candidate, plan: ScoutInspectionPlan, onMoment?: (moment: ScoutProposal) => Promise<void>) => {
    const inspectionStartedAt = Date.now();
    activeOperations += 1;
    inspectOperations += 1;
    await emit('scout.candidate_assigned', { scoutId, candidateId: candidate.id });
    try {
      const inspection = await abortable(input.runtime.inspect({ scoutId, searchId: input.searchId, query: input.query, candidate, plan, signal: controller.signal, onMoment }), controller.signal);
      const observed = Math.max(0, inspection.mediaSecondsObserved ?? 0);
      mediaSecondsObserved += observed;
      const telemetry: ScoutInspectionTelemetry = {
        scoutId,
        candidateId: candidate.id,
        mode: plan.mode,
        startSeconds: plan.startSeconds,
        endSeconds: plan.endSeconds,
        wallMs: Date.now() - inspectionStartedAt,
        mediaSecondsObserved: observed,
        exhaustive: inspection.exhaustive === true,
        exhausted: inspection.exhausted === true,
        success: true,
        metrics: inspection.metrics ?? {},
      };
      inspections.push(telemetry);
      log.info('scout inspection finished', {
        scout_id: scoutId,
        candidate_id: candidate.id,
        mode: plan.mode,
        range_start_seconds: plan.startSeconds,
        range_end_seconds: plan.endSeconds,
        wall_ms: telemetry.wallMs,
        media_seconds_observed: telemetry.mediaSecondsObserved,
        exhaustive: telemetry.exhaustive,
        exhausted: telemetry.exhausted,
        ...telemetry.metrics,
      });
      return inspection;
    } catch (error) {
      const reason = errorMessage(error);
      if (!controller.signal.aborted) failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason });
      const telemetry: ScoutInspectionTelemetry = {
        scoutId,
        candidateId: candidate.id,
        mode: plan.mode,
        startSeconds: plan.startSeconds,
        endSeconds: plan.endSeconds,
        wallMs: Date.now() - inspectionStartedAt,
        mediaSecondsObserved: 0,
        exhaustive: false,
        exhausted: false,
        success: false,
        failureReason: reason,
        metrics: {},
      };
      inspections.push(telemetry);
      log.warn('scout inspection failed', {
        scout_id: scoutId,
        candidate_id: candidate.id,
        mode: plan.mode,
        range_start_seconds: plan.startSeconds,
        range_end_seconds: plan.endSeconds,
        wall_ms: telemetry.wallMs,
        reason,
      });
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

      // Every scout covers the same horizon, but starts at a different offset
      // inside the sparse stride. That gives us independent looks at the same
      // area without replaying promising windows a second time.
      const coarseRuns = await Promise.all(SCOUT_IDS.map(async (scoutId, index) => {
        const startSeconds = index * scoutOffsetSeconds;
        const inspection = await inspect(scoutId, candidate, {
          startSeconds,
          endSeconds: horizonSeconds,
          mode: 'coarse',
          burstSeconds: coarseBurstSeconds,
          strideSeconds: coarseStrideSeconds,
        });
        return { scoutId, inspection };
      }));

      if (coarseRuns.some(({ inspection }) => inspection === null || inspection.exhaustive !== true)) candidatesPartlyExamined += 1;

      const coarseHits: Array<{ scoutId: ScoutId; proposal: ScoutProposal }> = [];
      for (const { scoutId, inspection } of coarseRuns) {
        if (!inspection) continue;
        for (const proposal of inspection.moments) {
          if (!Number.isFinite(proposal.startSeconds) || !Number.isFinite(proposal.endSeconds)) continue;
          if (proposal.startSeconds < 0 || proposal.endSeconds <= proposal.startSeconds) continue;
          if (proposal.endSeconds - proposal.startSeconds > maxMomentSeconds) {
            failures.push({ scoutId, candidateId: candidate.id, stage: 'inspect', reason: `proposed moment exceeds ${maxMomentSeconds}s maximum` });
            continue;
          }
          coarseHits.push({ scoutId, proposal });
        }
      }

      coarseHits.sort((a, b) => a.proposal.startSeconds - b.proposal.startSeconds);

      type SignalCluster = {
        startSeconds: number;
        endSeconds: number;
        hits: Array<{ scoutId: ScoutId; proposal: ScoutProposal }>;
        scouts: Set<ScoutId>;
      };
      const clusters: SignalCluster[] = [];
      for (const hit of coarseHits) {
        const cluster = clusters.find((candidateCluster) =>
          hit.proposal.startSeconds <= candidateCluster.endSeconds + voteWindowSeconds
          && hit.proposal.endSeconds >= candidateCluster.startSeconds - voteWindowSeconds
        );
        if (cluster) {
          cluster.startSeconds = Math.min(cluster.startSeconds, hit.proposal.startSeconds);
          cluster.endSeconds = Math.max(cluster.endSeconds, hit.proposal.endSeconds);
          cluster.hits.push(hit);
          cluster.scouts.add(hit.scoutId);
        } else {
          clusters.push({
            startSeconds: hit.proposal.startSeconds,
            endSeconds: hit.proposal.endSeconds,
            hits: [hit],
            scouts: new Set([hit.scoutId]),
          });
        }
      }

      for (const cluster of clusters) {
        const strongest = [...cluster.hits].sort((one, other) => (other.proposal.confidence ?? -1) - (one.proposal.confidence ?? -1))[0]!;
        const startSeconds = cluster.endSeconds - cluster.startSeconds > maxMomentSeconds
          ? strongest.proposal.startSeconds
          : cluster.startSeconds;
        const endSeconds = cluster.endSeconds - cluster.startSeconds > maxMomentSeconds
          ? strongest.proposal.endSeconds
          : cluster.endSeconds;
        if (firstMomentAt === null) firstMomentAt = Date.now();
        momentSequence += 1;
        const moment: SwarmMoment<Candidate> = {
          id: `moment-${momentSequence}`,
          candidate,
          scoutId: strongest.scoutId,
          startSeconds,
          endSeconds,
          description: strongest.proposal.description,
          ...(strongest.proposal.confidence === undefined ? {} : { confidence: strongest.proposal.confidence }),
          scoutVotes: cluster.scouts.size,
        };
        moments.push(moment);
        await emit('moment.found', { scoutId: strongest.scoutId, candidateId: candidate.id, momentId: moment.id });
      }

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
    inspections,
    metrics: {
      wallMs: Date.now() - startedAt,
      inspectOperations,
      mediaSecondsObserved,
      firstMomentMs: firstMomentAt === null ? null : firstMomentAt - startedAt,
    },
  };
}
