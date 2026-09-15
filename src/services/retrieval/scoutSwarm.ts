import { logger } from '../../lib/logger.js';

export const SCOUT_IDS = ['scout-1', 'scout-2', 'scout-3', 'scout-4'] as const;
export type ScoutId = (typeof SCOUT_IDS)[number];

export interface ScoutCandidate {
  id: string;
}

export interface ScoutProposal {
  startSeconds: number;
  endSeconds: number;
  description: string;
  confidence?: number;
}

export interface ScoutInspection {
  moments: ScoutProposal[];
  mediaSecondsObserved?: number;
  exhausted?: boolean;
  metrics?: Record<string, unknown>;
}

export interface ScoutVerification {
  match: boolean;
  description?: string;
  mediaSecondsObserved?: number;
  metrics?: Record<string, unknown>;
}

export interface ScoutRuntime<Candidate extends ScoutCandidate> {
  inspect(input: {
    scoutId: ScoutId;
    searchId: string;
    query: string;
    candidate: Candidate;
    signal: AbortSignal;
  }): Promise<ScoutInspection>;

  verify(input: {
    scoutId: ScoutId;
    searchId: string;
    query: string;
    candidate: Candidate;
    startSeconds: number;
    endSeconds: number;
    contextStartSeconds: number;
    contextEndSeconds: number;
    signal: AbortSignal;
  }): Promise<ScoutVerification>;

  closeScout?(scoutId: ScoutId): Promise<void>;
}

export interface ScoutVerdict {
  scoutId: ScoutId;
  match: boolean;
  description?: string;
}

export type SwarmMomentStatus = 'confirmed' | 'possible' | 'rejected';

export interface SwarmMoment<Candidate extends ScoutCandidate> {
  id: string;
  candidate: Candidate;
  finderScoutId: ScoutId;
  startSeconds: number;
  endSeconds: number;
  description: string;
  finderConfidence?: number;
  status: SwarmMomentStatus;
  verdicts: ScoutVerdict[];
  verificationErrors: number;
  agreement: {
    yes: number;
    no: number;
    required: 2;
    complete: boolean;
  };
}

export interface ScoutSwarmSnapshot<Candidate extends ScoutCandidate> {
  scoutCount: 4;
  candidatesTotal: number;
  candidatesAssigned: number;
  candidatesCompleted: number;
  activeOperations: number;
  momentsProposed: number;
  momentsConfirmed: number;
  momentsPossible: number;
  momentsRejected: number;
  confirmed: SwarmMoment<Candidate>[];
  possible: SwarmMoment<Candidate>[];
}

export interface ScoutSwarmProgress<Candidate extends ScoutCandidate> {
  stage: 'searching' | 'verifying' | 'complete' | 'cancelled';
  event:
    | 'swarm.started'
    | 'scout.candidate_assigned'
    | 'scout.candidate_completed'
    | 'moment.proposed'
    | 'verification.completed'
    | 'verification.failed'
    | 'moment.confirmed'
    | 'moment.possible'
    | 'moment.rejected'
    | 'swarm.completed'
    | 'swarm.cancelled';
  scoutId?: ScoutId;
  candidateId?: string;
  momentId?: string;
  snapshot: ScoutSwarmSnapshot<Candidate>;
}

export interface ScoutSwarmFailure {
  scoutId: ScoutId;
  candidateId: string;
  stage: 'inspect' | 'verify';
  momentId?: string;
  reason: string;
}

export interface ScoutSwarmResult<Candidate extends ScoutCandidate> {
  searchId: string;
  status: 'completed' | 'ceiling_reached' | 'cancelled';
  scoutCount: 4;
  candidatesAvailable: number;
  candidatesConsidered: number;
  candidatesCompleted: number;
  confirmed: SwarmMoment<Candidate>[];
  possible: SwarmMoment<Candidate>[];
  rejected: SwarmMoment<Candidate>[];
  failures: ScoutSwarmFailure[];
  metrics: {
    wallMs: number;
    inspectOperations: number;
    verifyOperations: number;
    mediaSecondsObserved: number;
  };
}

interface MomentState<Candidate extends ScoutCandidate> {
  id: string;
  candidate: Candidate;
  finderScoutId: ScoutId;
  proposal: ScoutProposal;
  attempts: Set<ScoutId>;
  verdicts: ScoutVerdict[];
  verificationErrors: number;
  final?: SwarmMoment<Candidate>;
}

interface InspectTask<Candidate extends ScoutCandidate> {
  kind: 'inspect';
  candidate: Candidate;
}

interface VerifyTask<Candidate extends ScoutCandidate> {
  kind: 'verify';
  moment: MomentState<Candidate>;
}

type Task<Candidate extends ScoutCandidate> = InspectTask<Candidate> | VerifyTask<Candidate>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function verificationWindow(
  startSeconds: number,
  endSeconds: number,
  paddingSeconds: number,
  maxContextSeconds: number,
): { start: number; end: number } {
  let start = Math.max(0, startSeconds - paddingSeconds);
  let end = endSeconds + paddingSeconds;
  if (end - start <= maxContextSeconds) return { start, end };

  const midpoint = (startSeconds + endSeconds) / 2;
  start = Math.max(0, midpoint - maxContextSeconds / 2);
  end = start + maxContextSeconds;
  if (end < endSeconds) {
    end = endSeconds;
    start = Math.max(0, end - maxContextSeconds);
  }
  return { start, end };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function runScoutSwarm<Candidate extends ScoutCandidate>(input: {
  searchId: string;
  query: string;
  candidates: Candidate[];
  runtime: ScoutRuntime<Candidate>;
  maxCandidates?: number;
  timeoutMs?: number;
  verificationPaddingSeconds?: number;
  maxVerificationContextSeconds?: number;
  maxMomentSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ScoutSwarmProgress<Candidate>) => void | Promise<void>;
}): Promise<ScoutSwarmResult<Candidate>> {
  const startedAt = Date.now();
  const maxCandidates = Math.max(1, Math.min(15, input.maxCandidates ?? 15));
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? 5 * 60_000);
  const verificationPaddingSeconds = Math.max(0, input.verificationPaddingSeconds ?? 15);
  const maxVerificationContextSeconds = Math.max(1, input.maxVerificationContextSeconds ?? 60);
  const maxMomentSeconds = Math.max(1, input.maxMomentSeconds ?? 60);
  const candidates = input.candidates.slice(0, maxCandidates);
  const log = logger.child({ search_id: input.searchId, component: 'scout_swarm' });

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('search cancelled'));
  if (input.signal?.aborted) forwardAbort();
  else input.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('scout swarm wall-time ceiling reached')), timeoutMs);
  timeout.unref?.();

  let candidateCursor = 0;
  let candidatesAssigned = 0;
  let candidatesCompleted = 0;
  let activeOperations = 0;
  let inspectOperations = 0;
  let verifyOperations = 0;
  let mediaSecondsObserved = 0;
  let momentSequence = 0;
  const moments: MomentState<Candidate>[] = [];
  const failures: ScoutSwarmFailure[] = [];
  const waiters = new Set<() => void>();

  const wakeAll = () => {
    for (const wake of waiters) wake();
    waiters.clear();
  };

  const waitForWork = async () => new Promise<void>((resolve) => waiters.add(resolve));

  const publicMoment = (state: MomentState<Candidate>): SwarmMoment<Candidate> | undefined => state.final;

  const snapshot = (): ScoutSwarmSnapshot<Candidate> => {
    const finals = moments.map(publicMoment).filter((value): value is SwarmMoment<Candidate> => value !== undefined);
    return {
      scoutCount: 4,
      candidatesTotal: candidates.length,
      candidatesAssigned,
      candidatesCompleted,
      activeOperations,
      momentsProposed: moments.length,
      momentsConfirmed: finals.filter((moment) => moment.status === 'confirmed').length,
      momentsPossible: finals.filter((moment) => moment.status === 'possible').length,
      momentsRejected: finals.filter((moment) => moment.status === 'rejected').length,
      confirmed: finals.filter((moment) => moment.status === 'confirmed'),
      possible: finals.filter((moment) => moment.status === 'possible'),
    };
  };

  const emit = async (
    event: ScoutSwarmProgress<Candidate>['event'],
    detail: { scoutId?: ScoutId; candidateId?: string; momentId?: string } = {},
  ) => {
    const stage: ScoutSwarmProgress<Candidate>['stage'] = controller.signal.aborted
      ? 'cancelled'
      : event.startsWith('verification.') || event.startsWith('moment.')
        ? 'verifying'
        : event === 'swarm.completed'
          ? 'complete'
          : 'searching';
    const progress: ScoutSwarmProgress<Candidate> = { stage, event, ...detail, snapshot: snapshot() };
    log.debug(event, {
      scout_id: detail.scoutId,
      candidate_id: detail.candidateId,
      moment_id: detail.momentId,
      ...progress.snapshot,
    });
    await input.onProgress?.(progress);
  };

  const finalizeMoment = async (state: MomentState<Candidate>) => {
    if (state.final) return;
    const yes = state.verdicts.filter((verdict) => verdict.match).length;
    const no = state.verdicts.filter((verdict) => !verdict.match).length;
    const complete = state.verdicts.length >= 2;
    const status: SwarmMomentStatus = complete
      ? yes === 2
        ? 'confirmed'
        : yes === 1
          ? 'possible'
          : 'rejected'
      : 'possible';

    state.final = {
      id: state.id,
      candidate: state.candidate,
      finderScoutId: state.finderScoutId,
      startSeconds: state.proposal.startSeconds,
      endSeconds: state.proposal.endSeconds,
      description: state.proposal.description,
      finderConfidence: state.proposal.confidence,
      status,
      verdicts: [...state.verdicts],
      verificationErrors: state.verificationErrors,
      agreement: { yes, no, required: 2, complete },
    };
    await emit(`moment.${status}` as ScoutSwarmProgress<Candidate>['event'], {
      candidateId: state.candidate.id,
      momentId: state.id,
    });
  };

  const hasUnfinishedMoments = () => moments.some((moment) => !moment.final);

  const takeTask = (scoutId: ScoutId): Task<Candidate> | 'done' | null => {
    if (controller.signal.aborted) return 'done';

    for (const moment of moments) {
      if (moment.final || moment.finderScoutId === scoutId || moment.attempts.has(scoutId)) continue;
      if (moment.verdicts.length >= 2) continue;
      if (moment.attempts.size >= 3) continue;
      moment.attempts.add(scoutId);
      return { kind: 'verify', moment };
    }

    if (candidateCursor < candidates.length) {
      const candidate = candidates[candidateCursor++]!;
      candidatesAssigned += 1;
      return { kind: 'inspect', candidate };
    }

    if (activeOperations === 0 && !hasUnfinishedMoments()) return 'done';
    return null;
  };

  const worker = async (scoutId: ScoutId) => {
    while (!controller.signal.aborted) {
      const task = takeTask(scoutId);
      if (task === 'done') return;
      if (task === null) {
        await waitForWork();
        continue;
      }

      activeOperations += 1;
      wakeAll();
      try {
        if (task.kind === 'inspect') {
          inspectOperations += 1;
          await emit('scout.candidate_assigned', { scoutId, candidateId: task.candidate.id });
          try {
            const inspection = await abortable(
              input.runtime.inspect({
                scoutId,
                searchId: input.searchId,
                query: input.query,
                candidate: task.candidate,
                signal: controller.signal,
              }),
              controller.signal,
            );
            mediaSecondsObserved += Math.max(0, inspection.mediaSecondsObserved ?? 0);
            for (const proposal of inspection.moments) {
              if (!Number.isFinite(proposal.startSeconds) || !Number.isFinite(proposal.endSeconds)) continue;
              if (proposal.startSeconds < 0 || proposal.endSeconds <= proposal.startSeconds) continue;
              if (proposal.endSeconds - proposal.startSeconds > maxMomentSeconds) {
                failures.push({
                  scoutId,
                  candidateId: task.candidate.id,
                  stage: 'inspect',
                  reason: `proposed moment exceeds ${maxMomentSeconds}s maximum`,
                });
                continue;
              }
              momentSequence += 1;
              const state: MomentState<Candidate> = {
                id: `moment-${momentSequence}`,
                candidate: task.candidate,
                finderScoutId: scoutId,
                proposal,
                attempts: new Set(),
                verdicts: [],
                verificationErrors: 0,
              };
              moments.push(state);
              await emit('moment.proposed', {
                scoutId,
                candidateId: task.candidate.id,
                momentId: state.id,
              });
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              failures.push({
                scoutId,
                candidateId: task.candidate.id,
                stage: 'inspect',
                reason: errorMessage(error),
              });
            }
          } finally {
            candidatesCompleted += 1;
            await emit('scout.candidate_completed', { scoutId, candidateId: task.candidate.id });
          }
        } else {
          verifyOperations += 1;
          const state = task.moment;
          const window = verificationWindow(
            state.proposal.startSeconds,
            state.proposal.endSeconds,
            verificationPaddingSeconds,
            maxVerificationContextSeconds,
          );
          try {
            const verdict = await abortable(
              input.runtime.verify({
                scoutId,
                searchId: input.searchId,
                query: input.query,
                candidate: state.candidate,
                startSeconds: state.proposal.startSeconds,
                endSeconds: state.proposal.endSeconds,
                contextStartSeconds: window.start,
                contextEndSeconds: window.end,
                signal: controller.signal,
              }),
              controller.signal,
            );
            mediaSecondsObserved += Math.max(0, verdict.mediaSecondsObserved ?? 0);
            state.verdicts.push({
              scoutId,
              match: verdict.match,
              description: verdict.description,
            });
            await emit('verification.completed', {
              scoutId,
              candidateId: state.candidate.id,
              momentId: state.id,
            });
          } catch (error) {
            if (!controller.signal.aborted) {
              state.verificationErrors += 1;
              failures.push({
                scoutId,
                candidateId: state.candidate.id,
                stage: 'verify',
                momentId: state.id,
                reason: errorMessage(error),
              });
              await emit('verification.failed', {
                scoutId,
                candidateId: state.candidate.id,
                momentId: state.id,
              });
            }
          }

          if (state.verdicts.length >= 2 || state.attempts.size >= 3) {
            await finalizeMoment(state);
          }
        }
      } finally {
        activeOperations -= 1;
        wakeAll();
      }
    }
  };

  await emit('swarm.started');
  try {
    await Promise.all(SCOUT_IDS.map((scoutId) => worker(scoutId)));
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', forwardAbort);
    await Promise.allSettled(SCOUT_IDS.map((scoutId) => input.runtime.closeScout?.(scoutId)));
  }

  for (const moment of moments) {
    if (!moment.final) await finalizeMoment(moment);
  }

  const finals = moments.map((moment) => moment.final!).filter(Boolean);
  const cancelled = controller.signal.aborted;
  await emit(cancelled ? 'swarm.cancelled' : 'swarm.completed');

  const result: ScoutSwarmResult<Candidate> = {
    searchId: input.searchId,
    status: cancelled
      ? 'cancelled'
      : input.candidates.length > candidates.length
        ? 'ceiling_reached'
        : 'completed',
    scoutCount: 4,
    candidatesAvailable: input.candidates.length,
    candidatesConsidered: candidates.length,
    candidatesCompleted,
    confirmed: finals.filter((moment) => moment.status === 'confirmed'),
    possible: finals.filter((moment) => moment.status === 'possible'),
    rejected: finals.filter((moment) => moment.status === 'rejected'),
    failures,
    metrics: {
      wallMs: Date.now() - startedAt,
      inspectOperations,
      verifyOperations,
      mediaSecondsObserved,
    },
  };

  log.info('swarm.completed', {
    status: result.status,
    candidates_available: result.candidatesAvailable,
    candidates_considered: result.candidatesConsidered,
    candidates_completed: result.candidatesCompleted,
    moments_confirmed: result.confirmed.length,
    moments_possible: result.possible.length,
    moments_rejected: result.rejected.length,
    failures: result.failures.length,
    ...result.metrics,
  });
  return result;
}
