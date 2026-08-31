import path from 'node:path';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from '../storage/s3.js';
import { clipPosterKey, verticalDerivativeKey } from '../storage/types.js';
import {
  extractFrameAt,
  ffprobe,
  renderVerticalDerivative,
} from './ffmpeg.js';
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

/**
 * Turning one approved moment into a post-ready vertical asset.
 *
 * The division held throughout: MiniCPM decides WHAT must stay visible,
 * planReframe turns that judgement into source-space geometry, FFmpeg renders
 * the file. Nothing here detects a face or tracks a subject, and the guard
 * below is arithmetic rather than an opinion about the picture.
 *
 * Every step names the stage it failed at, because a candidate that fails is
 * invisible to the creator by design — and a pipeline that quietly drops a
 * third of its candidates looks, from outside, exactly like a video that only
 * had two good moments in it. The stage is what tells those apart.
 */

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
  /** The canonical clip on disk — original framing, already cut. */
  canonicalPath: string;
  workDir: string;
  hasAudio: boolean;
  /** Asks MiniCPM about this exact moment. Injected so the pipeline is testable. */
  askComposition: (canonicalPath: string) => Promise<{ content: string | null; provider: string; model: string }>;
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
 * Decide the composition for one moment.
 *
 * An already-vertical source skips the model entirely: there is no framing
 * decision to make when the frame is already the target shape, and paying for
 * GPU inference to be told so would be spending money on a foregone
 * conclusion. Reported truthfully as 'original'.
 */
export async function decideComposition(
  input: Pick<VerticalPipelineInput, 'canonicalPath' | 'askComposition'>,
  source: { width: number; height: number },
): Promise<{ decision: CompositionDecision; elapsedMs: number; provider: string | null; model: string | null; skipped: boolean }> {
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
    // The call itself failed. Not fatal: blurred_background keeps the whole
    // frame, so the moment is still deliverable and still honest about what
    // it is. Recorded as a fallback so the metrics can tell it apart from the
    // model deliberately choosing that mode.
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
 * Run the whole post-ready pipeline for one candidate.
 *
 * Order matters: probe, then decide, then render, then poster. The poster is
 * taken from the DERIVATIVE rather than the canonical clip, so the still a
 * creator sees is the frame they will actually post — a poster cropped
 * differently from its own video is a small lie that shows up immediately in
 * a grid.
 */
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
  let mode: CompositionMode = composition.decision.mode;
  let cropFilter: string | null = null;

  if (mode === 'smart_crop') {
    const focusPct = focusPctFor(composition.decision, { width: sourceWidth, height: sourceHeight });
    const plan = planReframe({ aspect: '9:16', focusPct }, { width: sourceWidth, height: sourceHeight });

    // The quality guard. MiniCPM can be entirely right that the crop is
    // semantically safe and the result still be too soft to post: a 640x360
    // source crops to ~202px and would be scaled more than fivefold in area.
    // Falling back keeps the WHOLE frame, so a weak source keeps every pixel
    // it has rather than a magnified third of them.
    if (!cropMeetsQualityFloor({ width: plan.outputWidth, height: plan.outputHeight }, env.VERTICAL_MIN_CROP_WIDTH)) {
      logger.info('smart crop rejected by the resolution floor', {
        clipId: input.clipId,
        cropWidth: plan.outputWidth,
        floor: env.VERTICAL_MIN_CROP_WIDTH,
      });
      mode = 'blurred_background';
    } else {
      cropFilter = plan.filter;
      // A source already at the target shape has no crop to apply; treat it
      // as original rather than claiming a crop that did nothing.
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

  const derivativeStorageKey = verticalDerivativeKey(input.videoId, input.clipId);
  try {
    await getStorage().uploadFile(derivativeStorageKey, derivativePath, 'video/mp4');
  } catch (error) {
    throw new VerticalPipelineFailure('storage_upload', 'derivative_upload_failed', 'The derivative could not be stored', error);
  }

  // The poster comes from the derivative: it must show the frame the creator
  // will actually post, not the wider one it was cut from.
  const posterStartedAt = performance.now();
  const posterTimestampSeconds = posterOffsetSeconds(rendered.durationSeconds);
  const posterPath = path.join(input.workDir, `${input.clipId}-poster.jpg`);
  let posterWritten = false;
  try {
    posterWritten = await extractFrameAt(derivativePath, posterTimestampSeconds, posterPath, VERTICAL_DELIVERY.width);
  } catch (error) {
    throw new VerticalPipelineFailure('poster_generation', 'poster_failed', 'The poster frame could not be extracted', error);
  }
  if (!posterWritten) {
    // extractFrameAt exits 0 without a file when the seek lands past the last
    // decodable frame, so the result is confirmed rather than assumed.
    throw new VerticalPipelineFailure('poster_generation', 'poster_empty', 'The poster frame extracted to nothing');
  }

  const posterStorageKey = clipPosterKey(input.videoId, input.clipId);
  try {
    await getStorage().uploadFile(posterStorageKey, posterPath, 'image/jpeg');
  } catch (error) {
    throw new VerticalPipelineFailure('storage_upload', 'poster_upload_failed', 'The poster could not be stored', error);
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
    // What was WRITTEN, read back from the file — never what was requested.
    outputWidth: rendered.width,
    outputHeight: rendered.height,
    compositionDecisionMs: composition.elapsedMs,
    derivativeGenerationMs,
    posterGenerationMs,
    provider: composition.provider,
    model: composition.model,
  };
}

/** The model's normalized focal point, on the axis planReframe actually cuts. */
function focusPctFor(decision: CompositionDecision, source: { width: number; height: number }): number {
  const target = VERTICAL_DELIVERY.width / VERTICAL_DELIVERY.height;
  const along = source.width / source.height > target ? decision.focalX : decision.focalY;
  const clamped = Math.min(1, Math.max(0, along ?? 0.5));
  return Number((clamped * 100).toFixed(2));
}
