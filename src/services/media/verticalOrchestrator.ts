import path from 'node:path';
import { stat } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { logger, type Logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from '../storage/s3.js';
import { clipKey } from '../storage/types.js';
import { cutClip } from './ffmpeg.js';
import { applyClipPadding } from '../timestamps.js';
import { upsertClipForMatch, setClipStatus } from '../../db/repositories/clips.js';
import { setVerticalMedia, markVerticalFailed } from '../../db/repositories/verticalMedia.js';
import { markAttemptsRecovered, recordVerticalRenderAttempt } from '../../db/repositories/verticalRenders.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { askVideoModel, videoPartFromFile, type ContentPart } from '../search/openrouterVideo.js';
import { COMPOSITION_SYSTEM_PROMPT, COMPOSITION_INSTRUCTION } from '../search/composition.js';
import { runVerticalPipeline, VerticalPipelineFailure } from './verticalPipeline.js';
import { assembleDeck, deckMetrics, planDeck, type DeckOutcome, type PreparedCandidate } from './deckAssembly.js';
import type { FailureStage, VerticalCandidate } from './verticalVisibility.js';
import type { PlatformIntent } from '../search/platformIntent.js';
import type { UsageTally } from '../usageTally.js';

/**
 * From ranked candidates to a deck of finished, post-ready moments — or to
 * nothing at all.
 *
 * This is the only place that turns "find me 3 moments I can post on TikTok"
 * into real files. It composes what already exists rather than adding
 * machinery beside it: upsertClipForMatch and cutClip make the canonical
 * excerpt exactly as the Keep route does, runVerticalPipeline makes the 9:16
 * derivative and the poster, assembleDeck decides the order and when to stop.
 *
 * It runs INLINE inside the search job, and that is a decision worth stating.
 * Atomic reveal means the request must not be reported finished until the
 * whole deck stands. Doing the work inside the job that finishes the request
 * makes that structural rather than a promise — there is no window in which
 * the request is complete and the media is not. Handing the work to another
 * queue and waiting on it from a worker would also deadlock at concurrency 1.
 *
 * The cost of that choice: a vertical request occupies its search worker for
 * the whole render. That is the same worker that was already occupied for the
 * whole search, and the render is bounded by the candidate ceiling.
 */

/** A ranked candidate, plus the seconds needed to cut it. */
export interface OrchestratorCandidate extends VerticalCandidate {
  startSeconds: number;
  endSeconds: number;
}

export interface OrchestrateInput {
  videoId: string;
  clipRequestId: string;
  sessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  /** The ORIGINAL source on disk — never the analysis proxy. */
  sourcePath: string;
  workDir: string;
  hasAudio: boolean;
  videoDurationSeconds: number | null;
  intent: PlatformIntent;
  requestedCount: number;
  candidates: OrchestratorCandidate[];
  log: Logger;
  /**
   * The search's own cost tally. Composition calls are made inside the search
   * job and are part of what that request cost; leaving them out would make
   * the "clip search cost" line understate a vertical request by every
   * framing call it paid for — and that line exists precisely to be priced
   * from on its own.
   */
  tally: UsageTally;
}

/**
 * Ask the model how this moment should be framed.
 *
 * Built here, per candidate, so it can carry the clip's own storage key: the
 * MiniCPM lane sends a signed URL to that key, and the OpenRouter lane sends
 * the bytes. Same shape as every other video call in the system — same
 * queue, same retries, same cost accounting — because a second way to reach
 * the model would be a second thing to keep correct.
 */
function compositionAsker(input: OrchestrateInput, canonicalKey: string, durationSeconds: number) {
  return async (canonicalPath: string) => {
    const parts: ContentPart[] = [{ type: 'text', text: COMPOSITION_INSTRUCTION }];

    // The MiniCPM lane sends a signed URL to videoStorageKey and reads only
    // the text parts, so base64-encoding the clip for it produces a
    // multi-megabyte string that is built and thrown away. One clip is
    // nothing; a deck is that repeated for every candidate, inside a worker
    // already running FFmpeg. The OpenRouter lane genuinely needs the bytes
    // and still gets them.
    const usesStorageKey = env.VIDEO_PROVIDER === 'minicpm';
    let videoBytes: number;
    if (usesStorageKey) {
      videoBytes = (await stat(canonicalPath)).size;
    } else {
      const videoPart = await videoPartFromFile(canonicalPath);
      parts.push(videoPart.part);
      videoBytes = videoPart.bytes;
    }

    const answer = await askVideoModel({
      chunkIndex: 0,
      chunkDurationSeconds: durationSeconds,
      systemPrompt: COMPOSITION_SYSTEM_PROMPT,
      parts,
      videoBytes,
      purpose: 'search',
      videoStorageKey: canonicalKey,
      onUsage: (usage) => {
        // Counted in the request's total...
        input.tally.add(usage);
        // ...and stored under its own stage, for the same reason re-clip has
        // one: what framing costs is a separate business number from what
        // searching costs, and it only exists if the rows keep it apart.
        void recordModelUsage({
          ...usage,
          stage: 'composition',
          videoId: input.videoId,
          clipRequestId: input.clipRequestId,
        });
      },
    });

    return { content: answer.content, provider: answer.provider, model: answer.model };
  };
}

/**
 * Take one candidate all the way to READY, or fail it with a named stage.
 *
 * Idempotent by construction, at two levels. upsertClipForMatch returns the
 * existing clip for a match rather than making a second one, and a clip that
 * already has its canonical file, derivative and poster is returned untouched
 * before anything is encoded. So a worker restart, a redelivered job or a
 * repeated orchestration re-uses the media instead of paying for it twice —
 * and, more importantly, cannot give the creator a DIFFERENT framing decision
 * for a moment they have already been shown.
 */
async function prepareCandidate(
  input: OrchestrateInput,
  candidate: OrchestratorCandidate,
  attempt: number,
): Promise<PreparedCandidate> {
  const base = { ...candidate, attempts: attempt, failureStage: null as FailureStage | null };
  const startedAt = performance.now();
  let clipId: string | null = null;
  let stage: FailureStage = 'canonical_generation';
  let canonicalGenerationMs: number | null = null;

  try {
    const clip = await upsertClipForMatch({
      videoId: input.videoId,
      clipMatchId: candidate.matchId,
      sessionId: input.sessionId,
      userId: input.userId,
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
    });
    clipId = clip.id;

    // Everything already exists: this is a repeat, not new work.
    if (
      clip.status === 'ready'
      && clip.storageKey
      && clip.derivativeStatus === 'ready'
      && clip.derivativeStorageKey
      && clip.posterStorageKey
    ) {
      input.log.info('vertical candidate already finished, reusing', {
        matchId: candidate.matchId,
        clipId: clip.id,
      });
      return {
        ...base,
        derivativeStatus: 'ready',
        derivativeStorageKey: clip.derivativeStorageKey,
        posterStorageKey: clip.posterStorageKey,
      };
    }

    // The canonical excerpt: same padding, same encoder settings, same source
    // as the Keep route's render. It is the moment; everything after this is
    // presentation.
    const padded = applyClipPadding(
      { startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds },
      {
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        videoDurationSeconds: input.videoDurationSeconds ?? Number.POSITIVE_INFINITY,
        minDurationSeconds: env.MIN_CLIP_SECONDS,
        // The PLATFORM's ceiling, not the global one. Candidates were already
        // filtered against it, and padding is the one thing that could push a
        // 58-second moment past a 60-second limit after that check passed —
        // rendering a clip TikTok would refuse, having explicitly filtered
        // for clips TikTok would accept. Latent today (padding defaults to
        // zero) and a real bug the moment anyone sets it.
        maxDurationSeconds: input.intent.hardMaxSeconds,
      },
    );

    const canonicalPath = path.join(input.workDir, `${clip.id}.mp4`);
    await setClipStatus(clip.id, 'generating');
    const cut = await cutClip({
      inputPath: input.sourcePath,
      outputPath: canonicalPath,
      startSeconds: padded.startSeconds,
      endSeconds: padded.endSeconds,
      hasAudio: input.hasAudio,
    });

    stage = 'storage_upload';
    const canonicalKey = clipKey(input.videoId, clip.id);
    await getStorage().uploadFile(canonicalKey, canonicalPath, 'video/mp4');
    await setClipStatus(clip.id, 'ready', {
      storageKey: canonicalKey,
      durationSeconds: Number(cut.durationSeconds.toFixed(3)),
      sizeBytes: cut.sizeBytes,
    });
    canonicalGenerationMs = Math.round(performance.now() - startedAt);

    // Framing, derivative, poster. Every failure inside here arrives as a
    // VerticalPipelineFailure carrying the stage that gave way.
    stage = 'composition_decision';
    const media = await runVerticalPipeline({
      videoId: input.videoId,
      clipId: clip.id,
      canonicalPath,
      workDir: input.workDir,
      hasAudio: input.hasAudio,
      askComposition: compositionAsker(input, canonicalKey, cut.durationSeconds),
    });

    // READY is a PERSISTED fact, never an in-memory return value. A candidate
    // whose state could not be written must not become a card whose readiness
    // nothing can vouch for after this process exits.
    stage = 'serialization';
    await setVerticalMedia(clip.id, {
      compositionMode: media.compositionMode,
      focalX: media.focalX,
      focalY: media.focalY,
      derivativeStorageKey: media.derivativeStorageKey,
      posterStorageKey: media.posterStorageKey,
      posterTimestampSeconds: media.posterTimestampSeconds,
      sourceWidth: media.sourceWidth,
      sourceHeight: media.sourceHeight,
      outputWidth: media.outputWidth,
      outputHeight: media.outputHeight,
      canonicalGenerationMs,
      compositionDecisionMs: media.compositionDecisionMs,
      derivativeGenerationMs: media.derivativeGenerationMs,
      posterGenerationMs: media.posterGenerationMs,
      // Made before anyone chose it, so it is temporary until they do.
      retentionClass: 'temporary',
    });

    await recordVerticalRenderAttempt({
      videoId: input.videoId,
      clipRequestId: input.clipRequestId,
      matchId: candidate.matchId,
      clipId: clip.id,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      requestedPlatform: input.intent.platform,
      presentationTarget: input.intent.presentationTarget,
      sourceWidth: media.sourceWidth,
      sourceHeight: media.sourceHeight,
      sourceAspect: media.sourceAspectRatio,
      targetAspect: '9:16',
      targetWidth: media.outputWidth,
      targetHeight: media.outputHeight,
      compositionMode: media.compositionMode,
      provider: media.provider,
      model: media.model,
      outcome: 'succeeded',
      failureStage: null,
      failureCode: null,
      failureMessage: null,
      attemptNumber: attempt,
      totalAttempts: attempt,
      canonicalGenerationMs,
      compositionDecisionMs: media.compositionDecisionMs,
      derivativeRenderMs: media.derivativeGenerationMs,
      posterGenerationMs: media.posterGenerationMs,
    });

    // This attempt succeeded after an earlier one failed, so the earlier
    // failure rows are marked recovered. Without this, retryRecoveryRate is
    // computed from a column nothing ever sets and reads zero forever — a
    // metric that reports "retries never help" while they are helping, which
    // is worse than having no metric at all.
    if (attempt > 1) {
      await markAttemptsRecovered(candidate.matchId).catch((error) => {
        input.log.error('could not mark earlier attempts recovered', {
          matchId: candidate.matchId, err: error,
        });
      });
    }

    return {
      ...base,
      derivativeStatus: 'ready',
      derivativeStorageKey: media.derivativeStorageKey,
      posterStorageKey: media.posterStorageKey,
    };
  } catch (error) {
    const failure = error instanceof VerticalPipelineFailure ? error : null;
    const failureStage = failure?.stage ?? stage;
    const code = failure?.code ?? 'unexpected';
    const message = errorMessage(error);

    if (clipId) await markVerticalFailed(clipId, message).catch(() => undefined);

    // The candidate vanishes from the creator's view. It must not vanish from
    // ours: without this row, a pipeline quietly dropping a third of its
    // candidates looks exactly like a video that only had two good moments.
    await recordVerticalRenderAttempt({
      videoId: input.videoId,
      clipRequestId: input.clipRequestId,
      matchId: candidate.matchId,
      clipId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      requestedPlatform: input.intent.platform,
      presentationTarget: input.intent.presentationTarget,
      sourceWidth: null,
      sourceHeight: null,
      sourceAspect: null,
      targetAspect: '9:16',
      targetWidth: null,
      targetHeight: null,
      compositionMode: null,
      provider: null,
      model: null,
      outcome: 'failed',
      failureStage,
      failureCode: code,
      // Truncated, and never a URL or credential: what reaches here is an
      // ffmpeg stderr tail or a provider message, not a request.
      failureMessage: message.slice(0, 500),
      attemptNumber: attempt,
      totalAttempts: attempt,
      // Whatever the cut cost before this attempt gave way — null when it
      // fell over before the cut finished.
      canonicalGenerationMs,
      compositionDecisionMs: null,
      derivativeRenderMs: null,
      posterGenerationMs: null,
    }).catch((recordError) => {
      // Losing the telemetry is worse than the failure it describes, so it is
      // said out loud rather than swallowed.
      input.log.error('could not record a vertical render failure', { err: recordError });
    });

    input.log.warn('vertical candidate failed', {
      matchId: candidate.matchId,
      stage: failureStage,
      code,
      attempt,
    });

    return { ...base, derivativeStatus: 'failed', failureStage };
  }
}

export interface OrchestrationResult {
  outcome: DeckOutcome;
  metrics: ReturnType<typeof deckMetrics>;
}

/**
 * Assemble the complete deck for one request, or report that it could not be.
 *
 * Returns ready candidates ONLY when the full requested count stands. An
 * incomplete result comes back with an empty deck, so a caller cannot reveal
 * a partial one even by mistake.
 */
export async function orchestrateVerticalDeck(input: OrchestrateInput): Promise<OrchestrationResult> {
  const startedAt = performance.now();
  const plan = planDeck(input.requestedCount, env.VERTICAL_CANDIDATE_OVERFETCH, env.VERTICAL_CANDIDATE_CEILING);

  const outcome = await assembleDeck(
    input.candidates,
    plan,
    (candidate, attempt) => prepareCandidate(input, candidate as OrchestratorCandidate, attempt),
    env.VERTICAL_MAX_RENDER_ATTEMPTS,
  );

  const metrics = deckMetrics(outcome, startedAt, performance.now(), input.candidates.length);
  input.log.info('vertical deck assembled', {
    platform: input.intent.platform,
    requested: input.requestedCount,
    candidateCeiling: plan.candidateTarget,
    complete: outcome.complete,
    ...metrics,
  });

  return { outcome, metrics };
}
