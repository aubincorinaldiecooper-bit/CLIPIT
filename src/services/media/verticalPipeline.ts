import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from '../storage/s3.js';
import { clipPosterKey, verticalDerivativeKey } from '../storage/types.js';
import { extractFrameAt, ffprobe, renderVerticalDerivative } from './ffmpeg.js';
import { planReframe } from './reframe.js';
import {
  VERTICAL_DELIVERY,
  aspectRatioLabel,
  cropMeetsQualityFloor,
  posterOffsetSeconds,
  type CompositionMode,
} from './composition.js';
import type { FailureStage } from './verticalVisibility.js';
import { decideFromResponse, SAFE_COMPOSITION, type CompositionDecision } from '../search/composition.js';

/** Turns one approved moment into the post-ready 9:16 deliverable. */
export class VerticalPipelineFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly code: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'VerticalPipelineFailure';
  }
}

export interface VerticalPipelineInput {
  videoId: string;
  clipId: string;
  /** Canonical source-framing cut on disk. The deliverable made from it is always vertical. */
  canonicalPath: string;
  workDir: string;
  hasAudio: boolean;
  /** Asks the configured framing model what must stay visible in this exact moment. */
  askComposition: (canonicalPath: string) => Promise<{ content: string | null; provider: string; model: string }>;
  currentDerivativeKey?: () => Promise<string | null>;
  snapshotDerivativeKey?: string | null;
  /** Fresh key suffix for a re-render. */
  render?: string;
}

export interface VerticalPipelineResult {
  compositionMode: CompositionMode;
  focalX: number | null;
  focalY: number | null;
  derivativeStorageKey: string;
  posterStorageKey: string;
  posterTimestampSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceAspectRatio: string | null;
  outputWidth: number;
  outputHeight: number;
  compositionDecisionMs: number;
  derivativeGenerationMs: number;
  posterGenerationMs: number;
  provider: string | null;
  model: string | null;
}

/**
 * Decide how to fit the moment into 9:16. Already-vertical footage skips the
 * model because there is no framing decision to make.
 */
export async function decideComposition(
  input: Pick<VerticalPipelineInput, 'canonicalPath' | 'askComposition'>,
  source: { width: number; height: number },
): Promise<{
  decision: CompositionDecision;
  elapsedMs: number;
  provider: string | null;
  model: string | null;
  skipped: boolean;
}> {
  const startedAt = performance.now();
  const ratio = source.width / source.height;
  const target = VERTICAL_DELIVERY.width / VERTICAL_DELIVERY.height;

  if (Math.abs(ratio - target) / target < 0.02) {
    return {
      decision: { mode: 'original', focalX: null, focalY: null, reason: null, fellBack: false },
      elapsedMs: Math.round(performance.now() - startedAt),
      provider: null,
      model: null,
      skipped: true,
    };
  }

  try {
    const answer = await input.askComposition(input.canonicalPath);
    return {
      decision: decideFromResponse(answer.content),
      elapsedMs: Math.round(performance.now() - startedAt),
      provider: answer.provider,
      model: answer.model,
      skipped: false,
    };
  } catch (error) {
    // A framing-model failure must not make the moment disappear. The safe
    // whole-frame treatment preserves all source pixels in a vertical file.
    logger.warn('composition call failed; using the safe composition', { err: errorMessage(error) });
    return {
      decision: SAFE_COMPOSITION,
      elapsedMs: Math.round(performance.now() - startedAt),
      provider: null,
      model: null,
      skipped: false,
    };
  }
}

/**
 * A deterministic object key can already belong to an earlier successful
 * render. On an ambiguous upload failure, only delete the object when this
 * attempt could have created it.
 */
export function shouldDiscardOnUploadFailure(input: {
  key: string;
  snapshotKey: string | null;
  currentKey: string | null | undefined;
  readFailed: boolean;
}): boolean {
  const ownedNow = input.readFailed ? input.snapshotKey : (input.currentKey ?? null);
  return ownedNow !== input.key;
}

export async function discardUploadedObjects(
  keys: Array<string | null | undefined>,
  context: { videoId: string; clipId: string; reason: string },
): Promise<void> {
  const present = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  if (present.length === 0) return;

  const storage = getStorage();
  for (const storageKey of present) {
    try {
      await storage.remove(storageKey);
      logger.info('discarded a partially uploaded object', { ...context, storageKey });
    } catch (error) {
      logger.error('could not discard a partially uploaded object — it is now an orphan', {
        ...context,
        storageKey,
        err: error,
      });
    }
  }
}

export async function runVerticalPipeline(input: VerticalPipelineInput): Promise<VerticalPipelineResult> {
  let probe;
  try {
    probe = await ffprobe(input.canonicalPath);
  } catch (error) {
    throw new VerticalPipelineFailure('media_probe', 'probe_failed', 'Could not read the canonical clip', error);
  }

  const sourceWidth = probe.width ?? 0;
  const sourceHeight = probe.height ?? 0;
  if (sourceWidth < 2 || sourceHeight < 2) {
    throw new VerticalPipelineFailure('media_probe', 'no_dimensions', 'The canonical clip reported no usable dimensions');
  }

  const composition = await decideComposition(input, { width: sourceWidth, height: sourceHeight });
  logger.info('framing decided', {
    clipId: input.clipId,
    mode: composition.decision.mode,
    skipped: composition.skipped,
    fellBack: composition.decision.fellBack,
    provider: composition.provider,
    elapsedMs: composition.elapsedMs,
  });

  let mode: CompositionMode = composition.decision.mode;
  let cropFilter: string | null = null;

  if (mode === 'smart_crop') {
    const focusPct = focusPctFor(composition.decision, { width: sourceWidth, height: sourceHeight });
    const plan = planReframe({ aspect: '9:16', focusPct }, { width: sourceWidth, height: sourceHeight });

    if (!cropMeetsQualityFloor({ width: plan.outputWidth, height: plan.outputHeight }, env.VERTICAL_MIN_CROP_WIDTH)) {
      logger.info('smart crop rejected by the resolution floor', {
        clipId: input.clipId,
        cropWidth: plan.outputWidth,
        floor: env.VERTICAL_MIN_CROP_WIDTH,
      });
      mode = 'blurred_background';
    } else {
      cropFilter = plan.filter;
      // The source is already at the delivery shape. The output is still the
      // normal vertical derivative; there simply is no crop to apply.
      if (!cropFilter) mode = 'original';
    }
  }

  const derivativePath = path.join(input.workDir, `${input.clipId}-vertical.mp4`);
  const renderStartedAt = performance.now();
  let rendered;
  try {
    rendered = await renderVerticalDerivative({
      inputPath: input.canonicalPath,
      outputPath: derivativePath,
      hasAudio: input.hasAudio,
      delivery: VERTICAL_DELIVERY,
      cropFilter,
    });
  } catch (error) {
    throw new VerticalPipelineFailure(
      cropFilter ? 'smart_crop_render' : 'blurred_background_render',
      'render_failed',
      'The vertical derivative could not be rendered',
      error,
    );
  }
  const derivativeGenerationMs = Math.round(performance.now() - renderStartedAt);

  const derivativeStorageKey = verticalDerivativeKey(input.videoId, input.clipId, input.render);
  try {
    await getStorage().uploadFile(derivativeStorageKey, derivativePath, 'video/mp4');
  } catch (error) {
    let currentKey: string | null | undefined;
    let readFailed = false;
    try {
      currentKey = input.currentDerivativeKey ? await input.currentDerivativeKey() : null;
    } catch {
      readFailed = true;
    }

    if (shouldDiscardOnUploadFailure({
      key: derivativeStorageKey,
      snapshotKey: input.snapshotDerivativeKey ?? null,
      currentKey,
      readFailed,
    })) {
      await discardUploadedObjects([derivativeStorageKey], {
        videoId: input.videoId,
        clipId: input.clipId,
        reason: 'derivative_upload_failed',
      });
    }

    throw new VerticalPipelineFailure('storage_upload', 'derivative_upload_failed', 'The derivative could not be stored', error);
  }

  const posterStartedAt = performance.now();
  const posterTimestampSeconds = posterOffsetSeconds(rendered.durationSeconds);
  const posterPath = path.join(input.workDir, `${input.clipId}-poster.jpg`);
  const posterStorageKey = clipPosterKey(input.videoId, input.clipId, input.render);
  let posterUploadAttempted = false;

  try {
    let posterWritten = false;
    try {
      posterWritten = await extractFrameAt(
        derivativePath,
        posterTimestampSeconds,
        posterPath,
        VERTICAL_DELIVERY.width,
      );
    } catch (error) {
      throw new VerticalPipelineFailure('poster_generation', 'poster_failed', 'The poster frame could not be extracted', error);
    }

    if (!posterWritten) {
      throw new VerticalPipelineFailure('poster_generation', 'poster_empty', 'The poster frame extracted to nothing');
    }

    try {
      posterUploadAttempted = true;
      await getStorage().uploadFile(posterStorageKey, posterPath, 'image/jpeg');
    } catch (error) {
      throw new VerticalPipelineFailure('storage_upload', 'poster_upload_failed', 'The poster could not be stored', error);
    }
  } catch (error) {
    await discardUploadedObjects(
      [derivativeStorageKey, posterUploadAttempted ? posterStorageKey : null],
      {
        videoId: input.videoId,
        clipId: input.clipId,
        reason: error instanceof VerticalPipelineFailure ? error.code : 'unexpected',
      },
    );
    throw error;
  }

  const posterGenerationMs = Math.round(performance.now() - posterStartedAt);

  return {
    compositionMode: mode,
    focalX: composition.decision.focalX,
    focalY: composition.decision.focalY,
    derivativeStorageKey,
    posterStorageKey,
    posterTimestampSeconds,
    sourceWidth,
    sourceHeight,
    sourceAspectRatio: aspectRatioLabel(sourceWidth, sourceHeight),
    outputWidth: rendered.width,
    outputHeight: rendered.height,
    compositionDecisionMs: composition.elapsedMs,
    derivativeGenerationMs,
    posterGenerationMs,
    provider: composition.provider,
    model: composition.model,
  };
}

function focusPctFor(decision: CompositionDecision, source: { width: number; height: number }): number {
  const target = VERTICAL_DELIVERY.width / VERTICAL_DELIVERY.height;
  const along = source.width / source.height > target ? decision.focalX : decision.focalY;
  const clamped = Math.min(1, Math.max(0, along ?? 0.5));
  return Number((clamped * 100).toFixed(2));
}
