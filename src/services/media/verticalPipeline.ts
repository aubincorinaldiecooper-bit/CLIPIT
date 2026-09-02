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
  /**
   * Reads the derivative key this clip points at RIGHT NOW.
   *
   * The key is deterministic, so a retry writes where an earlier run wrote.
   * When the row still names it, whatever is there predates this attempt and
   * must survive a failed re-upload — cleanup collects what this attempt
   * created, never media that was already good.
   *
   * A function rather than a value because the answer can change underneath
   * us: the retention sweep can clear this clip's keys and delete its objects
   * while the render is in flight. Deciding from a snapshot taken minutes
   * earlier would then skip cleanup for an object only this attempt could
   * have created, and leave it orphaned. Asked at the moment of failure, and
   * only then, so the common path pays nothing.
   *
   * Injected rather than imported so this stays a media service with no
   * database of its own.
   */
  currentDerivativeKey?: () => Promise<string | null>;
  /**
   * What the row named when this attempt STARTED — the fallback when the
   * read above cannot answer. See shouldDiscardOnUploadFailure.
   */
  snapshotDerivativeKey?: string | null;
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
/**
 * Delete objects this pipeline uploaded, when the work they belong to did not
 * finish.
 *
 * The invariant: every derivative and poster this pipeline uploads ends up
 * either referenced by its clip row, or deleted before the failure is
 * reported. Nothing in between.
 *
 * The in-between state is the dangerous one and it is not hypothetical: the
 * derivative uploads, then the poster extraction fails, and the object sits in
 * storage with its key recorded nowhere. The retention sweep cannot help —
 * that sweep works from keys ON clip rows, and this key never reached one. An
 * object nothing references is an object nothing will ever collect.
 *
 * Best-effort but never silent. If the delete itself fails there really is an
 * orphan, and the only thing standing between it and permanent invisibility is
 * this log line — so it names the clip, the video and the key.
 */
/**
 * Should the object at a deterministic key be deleted after a failed upload?
 *
 * The keys here are derived from ids, so a retry writes exactly where an
 * earlier run wrote. Deleting one is destructive and deleting none leaks, and
 * the right answer depends on TWO readings of the clip row: what it said when
 * the attempt began, and what it says at the moment of failure. Written out
 * as a table because getting it wrong in either direction has now happened
 * three times:
 *
 *   snapshot        fresh read at failure     delete?
 *   ────────────────────────────────────────────────────────────────────
 *   not the key     not the key               YES — only we could have written it
 *   not the key     the key                   no  — it is owned now
 *   not the key     READ FAILED               YES — nobody owned it when we started
 *   the key         not the key               YES — retention swept it; this is ours
 *   the key         the key                   no  — it predates this attempt
 *   the key         READ FAILED               NO  — unknown, and it was owned
 *
 * The last row is the one that matters most and the one I got wrong: an
 * unavailable database must never authorise deleting media the snapshot
 * showed we already had. Unknown means leave it alone — an orphan is a bill,
 * a deleted clip is gone.
 */
export function shouldDiscardOnUploadFailure(input: {
  key: string;
  /** What the row named when this attempt began. */
  snapshotKey: string | null;
  /** What it names now — undefined when the read itself failed. */
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
    // The upload rejected, which does not prove the object is absent — the
    // bytes may have landed and only the response been lost. Delete it, but
    // ONLY when this attempt could have been what created it: if the row
    // already named this key, the object there is a working derivative from
    // an earlier run and removing it would break a clip that played fine.
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

  // From here on the derivative EXISTS in storage while its key exists
  // nowhere else. Every exit from this block therefore takes it back out
  // again before reporting the failure — otherwise the object is stranded
  // where no sweep can find it.
  const posterStartedAt = performance.now();
  const posterTimestampSeconds = posterOffsetSeconds(rendered.durationSeconds);
  const posterPath = path.join(input.workDir, `${input.clipId}-poster.jpg`);
  const posterStorageKey = clipPosterKey(input.videoId, input.clipId);
  // ATTEMPTED, not succeeded, and the difference is a real orphan.
  //
  // A PUT can reach the bucket and store the object while the response is
  // lost on the way back — a timeout, a reset connection. uploadFile rejects,
  // the object exists, and a flag set only on success would leave its key out
  // of the cleanup below: exactly the unreferenced file this whole block is
  // here to prevent. Deleting a key that was never written is harmless, so
  // the safe side of that uncertainty is to always try.
  let posterUploadAttempted = false;

  try {
    // The poster comes from the derivative: it must show the frame the
    // creator will actually post, not the wider one it was cut from.
    let posterWritten = false;
    try {
      posterWritten = await extractFrameAt(derivativePath, posterTimestampSeconds, posterPath, VERTICAL_DELIVERY.width);
    } catch (error) {
      throw new VerticalPipelineFailure('poster_generation', 'poster_failed', 'The poster frame could not be extracted', error);
    }
    if (!posterWritten) {
      // extractFrameAt exits 0 without a file when the seek lands past the
      // last decodable frame, so the result is confirmed rather than assumed.
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

export interface OriginalPipelineInput {
  videoId: string;
  clipId: string;
  /** The canonical clip on disk — original framing, already cut. */
  canonicalPath: string;
  workDir: string;
  /** The cut as ffmpeg reported it, so the poster is taken from inside it. */
  durationSeconds: number;
  width: number;
  height: number;
  /** See VerticalPipelineInput.currentDerivativeKey — the same rule, for the poster. */
  currentPosterKey?: () => Promise<string | null>;
  snapshotPosterKey?: string | null;
}

export interface OriginalPipelineResult {
  posterStorageKey: string;
  posterTimestampSeconds: number;
  posterGenerationMs: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceAspectRatio: string | null;
}

/**
 * Finish a moment whose deliverable is the canonical cut itself.
 *
 * The owner's rule (2026-09-02): every moment is cut when it is found, and
 * the review shows finished clips whatever framing was asked for. For an
 * original-framing request there is no framing decision and no second
 * encode — the cut IS the file the creator will receive — so all that stands
 * between the cut and a card is the poster, taken from inside the cut at the
 * same offset the vertical pipeline uses. No model is asked anything.
 *
 * Failures name their stage for the same reason the vertical pipeline's do:
 * a candidate that fails is invisible to the creator by design, and the
 * stage is what tells "we could not finish it" apart from "it was never there".
 */
export async function runOriginalPipeline(input: OriginalPipelineInput): Promise<OriginalPipelineResult> {
  if (input.width < 2 || input.height < 2) {
    throw new VerticalPipelineFailure('media_probe', 'no_dimensions', 'The canonical clip reported no usable dimensions');
  }

  const posterStartedAt = performance.now();
  const posterTimestampSeconds = posterOffsetSeconds(input.durationSeconds);
  const posterPath = path.join(input.workDir, `${input.clipId}-poster.jpg`);
  const posterStorageKey = clipPosterKey(input.videoId, input.clipId);

  let posterWritten = false;
  try {
    // The poster is the card's picture, so it is asked for at the cut's own
    // width and at the quality the thumbnails use — not the preview default.
    posterWritten = await extractFrameAt(input.canonicalPath, posterTimestampSeconds, posterPath, input.width, { quality: 2 });
  } catch (error) {
    throw new VerticalPipelineFailure('poster_generation', 'poster_failed', 'The poster frame could not be extracted', error);
  }
  if (!posterWritten) {
    // extractFrameAt exits 0 without a file when the seek lands past the
    // last decodable frame, so the result is confirmed rather than assumed.
    throw new VerticalPipelineFailure('poster_generation', 'poster_empty', 'The poster frame extracted to nothing');
  }

  try {
    await getStorage().uploadFile(posterStorageKey, posterPath, 'image/jpeg');
  } catch (error) {
    // The key is deterministic, so a retry writes where an earlier run wrote.
    // Delete only what this attempt could itself have created — the same
    // two-reading rule the derivative upload above uses.
    let currentKey: string | null | undefined;
    let readFailed = false;
    try {
      currentKey = input.currentPosterKey ? await input.currentPosterKey() : null;
    } catch {
      readFailed = true;
    }
    if (shouldDiscardOnUploadFailure({
      key: posterStorageKey,
      snapshotKey: input.snapshotPosterKey ?? null,
      currentKey,
      readFailed,
    })) {
      await discardUploadedObjects([posterStorageKey], {
        videoId: input.videoId,
        clipId: input.clipId,
        reason: 'poster_upload_failed',
      });
    }
    throw new VerticalPipelineFailure('storage_upload', 'poster_upload_failed', 'The poster could not be stored', error);
  }

  return {
    posterStorageKey,
    posterTimestampSeconds,
    posterGenerationMs: Math.round(performance.now() - posterStartedAt),
    sourceWidth: input.width,
    sourceHeight: input.height,
    sourceAspectRatio: aspectRatioLabel(input.width, input.height),
  };
}
