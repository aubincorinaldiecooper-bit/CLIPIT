import { env } from '../config/env.js';
import { getStorage } from '../services/storage/s3.js';
import { formatTimecode } from '../services/timestamps.js';
import { latestVersionsForMatches } from '../db/repositories/reclips.js';
import { clipMediaContract } from './mediaContract.js';
import { isCreatorVisible } from '../services/media/verticalVisibility.js';
import type { CompositionMode } from '../services/media/composition.js';
import type {
  ChunkDegradation,
  ChunkFailureCode,
  Clip,
  ClipMatch,
  ClipRequest,
  Video,
  VideoChunk,
  MomentVersion,
} from '../domain/types.js';

/** Shapes rows into the public API representation. Storage keys never leak. */

export interface VideoProgress {
  stage: string;
  message: string;
}

/**
 * What is happening to this video, in words.
 *
 * There is deliberately no percentage. Each stage used to carry one — 5, 20,
 * 60, 100 — and not one of them was measured: the number jumped to 60 the
 * instant the stage began and sat there for the whole job, however long the
 * video was, which read as stuck rather than busy. Removing it rather than
 * hiding it, because a client that trusts a made-up number is a client we
 * misled, and the browser was not the only one that could read this.
 *
 * The wording is what a person would say. "Building the analysis proxy and
 * chunks" describes our plumbing; nobody uploading a video knows or cares what
 * a proxy is.
 */
function videoProgress(video: Video): VideoProgress {
  switch (video.status) {
    case 'pending_upload':
      return { stage: 'pending_upload', message: 'Waiting for the upload to finish' };
    case 'queued':
      return { stage: 'queued', message: 'Waiting to start' };
    case 'ingesting':
      return { stage: 'ingesting', message: 'Fetching the video' };
    case 'preprocessing':
      return { stage: 'preprocessing', message: 'Getting the video ready' };
    case 'ready':
      return { stage: 'ready', message: 'Ready' };
    case 'failed':
      return { stage: 'failed', message: video.errorMessage ?? 'Something went wrong with this video' };
    default:
      return { stage: video.status, message: '' };
  }
}

export function serializeVideo(video: Video, chunks?: VideoChunk[]) {
  return {
    id: video.id,
    sourceType: video.sourceType,
    sourceUrl: video.sourceUrl,
    title: video.title,
    originalFilename: video.originalFilename,
    status: video.status,
    error: video.errorMessage,
    progress: videoProgress(video),
    durationSeconds: video.durationSeconds,
    durationTimecode: video.durationSeconds !== null ? formatTimecode(video.durationSeconds) : null,
    sizeBytes: video.sizeBytes,
    width: video.width,
    height: video.height,
    fps: video.fps,
    videoCodec: video.videoCodec,
    audioCodec: video.audioCodec,
    hasAudio: video.hasAudio,
    chunkSeconds: video.chunkSeconds,
    chunkCount: video.chunkCount,
    readyForSearch: video.status === 'ready',
    transcript: {
      status: video.transcriptStatus,
      source: video.transcriptSource,
      segmentCount: video.transcriptSegmentCount,
      error: video.transcriptError,
    },
    index: {
      status: video.indexStatus,
      sceneCount: video.sceneCount,
      /**
       * How far into the video the notes reach, in seconds. Measured, and it
       * moves: notes are written chunk by chunk, so this climbs while the read
       * is running. It is what lets a screen say "read 8 of 20 minutes"
       * without anybody inventing a percentage.
       */
      readThroughSeconds: video.indexReadThroughSeconds,
      readThroughTimecode:
        video.indexReadThroughSeconds > 0 ? formatTimecode(video.indexReadThroughSeconds) : null,
      error: video.indexError,
    },
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
    ...(chunks
      ? {
          chunks: chunks.map((chunk) => ({
            id: chunk.id,
            index: chunk.chunkIndex,
            globalStartSeconds: chunk.globalStartSeconds,
            globalEndSeconds: chunk.globalEndSeconds,
            durationSeconds: chunk.durationSeconds,
          })),
        }
      : {}),
  };
}

export async function serializeMatch(match: ClipMatch, clip?: Clip | null, currentVersion?: MomentVersion | null) {
  // Signed like any other private object: the still lives in the same bucket
  // as the media it came from and must not be publicly readable.
  const thumbnailUrl = match.thumbnailKey
    ? await getStorage().createDownloadUrl(match.thumbnailKey)
    : null;

  // What the person sees is the moment's CURRENT boundaries — after a
  // Re-clip, the latest version's. The match row itself keeps the original
  // first-pass prediction untouched; only the presentation moves.
  const startSeconds = currentVersion?.startSeconds ?? match.globalStartSeconds;
  const endSeconds = currentVersion?.endSeconds ?? match.globalEndSeconds;
  const reclipCount = currentVersion && currentVersion.version > 1 ? currentVersion.version - 1 : 0;

  return {
    id: match.id,
    chunkId: match.chunkId,
    startSeconds,
    endSeconds,
    startTimecode: formatTimecode(startSeconds),
    endTimecode: formatTimecode(endSeconds),
    durationSeconds: Number((endSeconds - startSeconds).toFixed(3)),
    localStartSeconds: match.localStartSeconds,
    localEndSeconds: match.localEndSeconds,
    description: match.description,
    confidence: match.confidence,
    source: match.source,
    quote: match.quote,
    thumbnailUrl,
    // The client hides a rejected match rather than the server withholding it:
    // a reload should put the moment back exactly where the user left it, and
    // an approval that vanished on refresh would read as not having registered.
    feedback: match.feedback,
    feedbackReason: match.feedbackReason,
    // The Re-clip lifecycle, so a reload lands on the truth: how many
    // re-evaluations this moment has spent, how many remain, whether one is
    // running, and — when the last one failed — why, in words already safe
    // to show.
    reclipStatus: match.reclipStatus,
    reclipError: match.reclipError,
    reclipCount,
    reclipsRemaining: Math.max(0, env.MAX_RECLIPS_PER_MOMENT - reclipCount),
    reclippedAt: reclipCount > 0 && currentVersion ? currentVersion.createdAt.toISOString() : null,
    // A finished match carries the actual cut and its signed URL. Previously
    // this contained only an id and status, which left a client with no media
    // to put in the thumbnail player; its only playable URL was the parent
    // source video. Keeping the full clip here makes the small player play the
    // cut, while pending/failed clips still expose their useful state.
    clip: clip ? await serializeClip(clip) : null,
  };
}

export interface ClipRequestProgress {
  stage: string;
  percent: number;
  chunksTotal: number;
  chunksCompleted: number;
  chunksFailed: number;
  message: string;
}

/**
 * Which parts of the video were never examined, and why.
 *
 * A chunk the provider refused is not a failed search — the search completes
 * and returns what the other chunks found. But it means a window of the video
 * was never looked at, and a user asking about a moment inside that window is
 * told "nothing matches", which is indistinguishable from the moment being
 * absent. Naming the seconds is what makes that answer honest.
 */
export interface SearchCoverage {
  /** True only when every chunk was searched with the evidence intended. */
  complete: boolean;
  /** False when something is known to be missing but cannot be located. */
  locatable: boolean;
  unsearchedSeconds: number;
  gaps: Array<{
    startSeconds: number;
    endSeconds: number;
    startTimecode: string;
    endTimecode: string;
    reason: ChunkFailureCode;
  }>;
  /**
   * Windows that WERE searched, but without their transcript — recovered from
   * a provider content filter. Not gaps: matches from them are real. What is
   * missing there is the ability to have checked a spoken condition.
   */
  degraded: Array<{
    startSeconds: number;
    endSeconds: number;
    startTimecode: string;
    endTimecode: string;
    reason: ChunkDegradation['reason'];
  }>;
}

export function searchCoverage(request: ClipRequest): SearchCoverage {
  const gaps = request.chunkErrors
    // Rows written before failures carried a source window cannot describe
    // one; they still count as failures, they just cannot be located.
    .filter((error) => typeof error.globalStartSeconds === 'number' && typeof error.globalEndSeconds === 'number')
    .map((error) => ({
      startSeconds: error.globalStartSeconds,
      endSeconds: error.globalEndSeconds,
      startTimecode: formatTimecode(error.globalStartSeconds),
      endTimecode: formatTimecode(error.globalEndSeconds),
      reason: error.code ?? ('unknown' as ChunkFailureCode),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const degraded = (request.chunkDegradations ?? []).map((entry) => ({
    startSeconds: entry.globalStartSeconds,
    endSeconds: entry.globalEndSeconds,
    startTimecode: formatTimecode(entry.globalStartSeconds),
    endTimecode: formatTimecode(entry.globalEndSeconds),
    reason: entry.reason,
  })).sort((a, b) => a.startSeconds - b.startSeconds);

  return {
    // A recovered chunk counts against completeness. Its matches are real, but
    // the search that ran there is not the search that was asked for.
    //
    // Deliberately about the FOOTAGE that was examined, not about how the
    // question was answered. An answer from memory examined none, but it also
    // has no gap to point at — and reporting it as incomplete would make the
    // client offer to explain a stretch of unexamined video that does not
    // exist. `answeredFrom` carries that distinction instead, which is the
    // honest place for it: recalled and read are different acts, not different
    // amounts of coverage.
    complete: request.chunksFailed === 0 && degraded.length === 0,
    // A failure recorded before failures carried a window is still a failure;
    // it just cannot say where. Callers must not read unsearchedSeconds: 0 as
    // "nothing was missed".
    locatable: gaps.length === request.chunksFailed,
    unsearchedSeconds: Number(gaps.reduce((sum, gap) => sum + (gap.endSeconds - gap.startSeconds), 0).toFixed(3)),
    gaps,
    degraded,
  };
}

function clipRequestProgress(request: ClipRequest): ClipRequestProgress {
  const total = request.chunksTotal;
  const done = request.chunksCompleted + request.chunksFailed;
  const percent = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : request.status === 'completed' ? 100 : 0;

  const message =
    request.status === 'pending'
      ? 'Queued'
      : request.status === 'searching'
        ? // A question answered from memory reads no segments at all, so
          // counting them would report 0 of 0 while it works.
          total === 0
          ? 'Checking what I remember about this video'
          : `Searched ${done} of ${total} segments`
        : request.status === 'completed'
          ? // Never claim a whole video was searched when part of it was not.
            // "Search complete (10 segments)" after searching nine is the line
            // that turns a coverage gap into an apparent absence. The same
            // applies to answering from memory: no segment was read, and
            // saying otherwise would dress a recollection up as a search.
            request.answeredFrom === 'notes'
            ? 'Answered from what I remember of this video'
            : request.chunksFailed > 0
              ? `Searched ${request.chunksCompleted} of ${total} segments — ${request.chunksFailed} could not be examined`
              : `Search complete (${total} segments)`
          : (request.errorMessage ?? 'Search failed');

  return {
    stage: request.status,
    percent: request.status === 'completed' ? 100 : percent,
    chunksTotal: total,
    chunksCompleted: request.chunksCompleted,
    chunksFailed: request.chunksFailed,
    message,
  };
}

export async function serializeClipRequest(
  request: ClipRequest,
  matches?: ClipMatch[],
  clipsByMatchId?: Map<string, Clip>,
) {
  return {
    id: request.id,
    videoId: request.videoId,
    instruction: request.instruction,
    mode: request.mode,
    resolvedMode: request.resolvedMode,
    status: request.status,
    error: request.errorMessage,
    /**
     * Whether this was recalled or read. The notes are a summary written at
     * upload, so an answer from them carries less weight than one from the
     * footage — and a user who is about to conclude their video lacks
     * something deserves to know which kind of answer they got.
     */
    answeredFrom: request.answeredFrom,
    /**
     * Moments the model reported and our threshold discarded. Not results —
     * they cannot be turned into clips and are not counted. They are here so
     * an answer can say "I saw something at 04:12 I wasn't sure about" instead
     * of reporting an absence we know to be untrue.
     */
    uncertain: request.uncertainMatches
      .map((match) => ({
        startSeconds: match.globalStartSeconds,
        endSeconds: match.globalEndSeconds,
        startTimecode: formatTimecode(match.globalStartSeconds),
        endTimecode: formatTimecode(match.globalEndSeconds),
        confidence: match.confidence,
        description: match.description,
      }))
      .sort((a, b) => a.startSeconds - b.startSeconds),
    progress: clipRequestProgress(request),
    /**
     * What was asked for, what the video had, and what came back.
     *
     * Present only for requests that owe a finished deck. `available` below
     * `requested` is a fact about the footage, not a failure — a creator who
     * asks for three and is offered two should be told their video had two,
     * and this is what lets the interface say that instead of implying we
     * dropped one.
     *
     * `complete` is the same gate the matches above passed through, restated
     * so a client can tell "still assembling" from "assembled, and this is
     * all of it" without inferring anything from the array length.
     */
    ...(request.presentationTarget === 'vertical'
      ? {
          deck: {
            requestedResultCount: request.requestedResultCount,
            availableCandidateCount: request.availableCandidateCount,
            effectiveDeckTarget: request.effectiveDeckTarget,
            readyResultCount: matches?.length ?? 0,
            complete: request.deckCompletedAt !== null,
          },
        }
      : {}),
    // Surfaced so a partially failed search is visible rather than silent.
    failedChunks: request.chunkErrors.slice(0, 20),
    // The same facts as failedChunks, expressed as what the user actually
    // needs to know: which seconds of their video went unexamined.
    coverage: searchCoverage(request),
    matchCount: matches?.length ?? undefined,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    ...(matches
      ? {
          matches: await (async () => {
            const versions = await latestVersionsForMatches(matches.map((match) => match.id));
            return Promise.all(
              matches.map((match) =>
                serializeMatch(match, clipsByMatchId?.get(match.id) ?? null, versions.get(match.id) ?? null),
              ),
            );
          })(),
        }
      : {}),
  };
}

/**
 * The detail view adds a signed playback URL for the source, so the client
 * can seat the video in a player and seek straight to matched moments. Reads
 * stay side-effect free — this only signs a URL for bytes already in storage.
 */
/**
 * The video's own poster frame, signed.
 *
 * Split out because serializeVideo is synchronous and signing is not: the
 * list route awaits this per row, and the detail route folds it in below.
 * Null is an ordinary answer — the frame is captured best-effort at
 * preprocess time, and a video that has not reached that step yet simply has
 * no picture of itself.
 */
export async function videoPosterUrl(video: Video): Promise<string | null> {
  if (!video.posterStorageKey) return null;
  return getStorage().createDownloadUrl(video.posterStorageKey);
}

export async function serializeVideoWithPlayback(video: Video, chunks?: VideoChunk[]) {
  const base = { ...serializeVideo(video, chunks), posterUrl: await videoPosterUrl(video) };

  // The original is playable exactly when bytes were confirmed for the
  // CURRENT key. Both ingestion paths set sizeBytes at that moment — the
  // upload HEAD-confirm and the YouTube download — and reserving a retry URL
  // clears it, because the new key's object has not been PUT yet. Status is
  // deliberately not consulted: a video that failed AFTER its source landed
  // (say, in preprocessing) still has a perfectly playable original.
  const playable = video.originalStorageKey !== null && video.sizeBytes !== null;
  if (!playable) return { ...base, playback: null };

  const expiresAt = new Date(Date.now() + env.SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
  const url = await getStorage().createDownloadUrl(video.originalStorageKey!);
  // The watchable proxy, when preprocessing built one. The review cards and
  // the Preview play THIS; the original is what a cut is made from. Null is
  // honest — the client falls back to the original, as it always did.
  const proxyUrl = video.playbackStorageKey ? await getStorage().createDownloadUrl(video.playbackStorageKey) : null;
  return {
    ...base,
    playback: {
      url,
      expiresAt,
      proxyUrl,
    },
  };
}

/**
 * A library entry: the clip plus what it shows. The still and both URLs are
 * signed here like everything else private — the library is the page most
 * likely to be left open, so nothing in it may be a permanent link.
 */
export async function serializeLibraryClip(entry: {
  clip: Clip;
  description: string;
  thumbnailKey: string | null;
  videoTitle: string | null;
}) {
  const base = await serializeClip(entry.clip);
  const thumbnailUrl = entry.thumbnailKey
    ? await getStorage().createDownloadUrl(entry.thumbnailKey)
    : null;

  return {
    ...base,
    description: entry.description,
    thumbnailUrl,
    videoTitle: entry.videoTitle,
  };
}

/**
 * The gate between what the pipeline made and what a creator is shown.
 *
 * SET-level, not card-level, and that distinction is the entire point.
 *
 * Filtering finished clips one at a time still lets a polling client watch the
 * deck build itself: one card, then two, then three. The rule is that a
 * creator who asks for three postable moments sees NOTHING until all three
 * are finished, and then sees them together. So the question asked here is
 * not "is this clip ready?" but "does this request's whole deck stand?".
 *
 * The answer comes from the REQUEST ROW, never from inspecting clips. Three
 * reasons it has to:
 *
 *  - It must survive process boundaries. The worker that assembled the deck
 *    may be gone; a different API instance answers the poll.
 *  - "Some clip has preRendered = true" cannot distinguish a deck mid-assembly
 *    from a finished one, which is exactly the distinction that matters.
 *  - A correction ("are you sure?") stores those three words as its own
 *    instruction while the deck belongs to the question before it, so
 *    re-reading the text would be wrong precisely when it matters most.
 *
 * A request that owes no deck passes through untouched — every non-platform
 * flow behaves exactly as it did before any of this existed.
 */
/** Does this moment have real, finished media behind it? */
function clipIsShowable(match: ClipMatch, clip: Clip): boolean {
  return isCreatorVisible({
    matchId: match.id,
    derivativeStatus: clip.derivativeStatus ?? 'pending',
    derivativeStorageKey: clip.derivativeStorageKey,
    posterStorageKey: clip.posterStorageKey,
    confidence: match.confidence,
  });
}

export function creatorVisibleDeck(
  request: Pick<ClipRequest, 'presentationTarget' | 'deckCompletedAt' | 'effectiveDeckTarget'>,
  matches: ClipMatch[],
  clipsByMatchId: Map<string, Clip>,
): { matches: ClipMatch[]; clips: Clip[]; withheld: number } {
  // A request from BEFORE set-level tracking existed.
  //
  // Migration 030 adds these columns nullable and does not backfill, so every
  // vertical request created while 028/029 were live — media already rendered,
  // overfetch candidates and failures among it — carries a null target. Read
  // as "owes no deck", those rows would hand back every match and clip,
  // including cards that play nothing. That is a regression against the gate
  // this replaced, and it lands on real rows the moment 030 ships.
  //
  // So a null target falls back to the rule those rows were BUILT under:
  // card-level readiness, from the clips themselves. It is weaker than the
  // set-level guarantee and deliberately not dressed up as it — the
  // set-level truth was never recorded for them and cannot be invented now.
  if (request.presentationTarget === null) {
    const preRendered = [...clipsByMatchId.values()].some((clip) => clip.preRendered);
    if (!preRendered) return { matches, clips: [...clipsByMatchId.values()], withheld: 0 };
    const legacyVisible = matches.filter((match) => {
      const clip = clipsByMatchId.get(match.id);
      return clip ? clipIsShowable(match, clip) : false;
    });
    return {
      matches: legacyVisible,
      clips: legacyVisible.map((match) => clipsByMatchId.get(match.id)!),
      withheld: matches.length - legacyVisible.length,
    };
  }

  if (request.presentationTarget !== 'vertical') {
    return { matches, clips: [...clipsByMatchId.values()], withheld: 0 };
  }

  // Assembling, or failed. Both are "there is no finished set", and a creator
  // sees the same thing in both cases: nothing yet.
  if (!request.deckCompletedAt) {
    return { matches: [], clips: [], withheld: matches.length };
  }

  // The deck stands. Release it whole — still checking each clip's FILES
  // rather than trusting the flag alone, because a released deck whose media
  // went missing underneath must not hand out a card that plays nothing.
  const visible = matches.filter((match) => {
    const clip = clipsByMatchId.get(match.id);
    return clip ? clipIsShowable(match, clip) : false;
  });

  // Deliberately NOT re-checked against effectiveDeckTarget.
  //
  // An earlier version refused to serve a released deck whose visible count
  // had fallen below its original target, on the theory that a shortfall
  // meant something had deleted media out from under a finished request. But
  // the commonest cause of that shortfall is the system working exactly as
  // designed: the creator Keeps one moment, and a day later the retention
  // sweep collects the ones they did not keep — which is the whole point of
  // rendering before Keep being affordable. Comparing against the original
  // target then hid the entire conversation, including the moment they chose
  // and which still plays perfectly well from their library.
  //
  // The atomic promise is about the REVEAL, and it is already kept above:
  // deck_completed_at is written only when every moment in the effective deck
  // is finished and stored, so a polling client sees nothing and then sees
  // all of them. What survives afterwards is a question about the passage of
  // time, and answering it with what still exists is the truthful answer.
  return {
    matches: visible,
    clips: visible.map((match) => clipsByMatchId.get(match.id)!),
    withheld: matches.length - visible.length,
  };
}

export async function serializeClip(clip: Clip, includeUrl = true) {
  let url: string | null = null;
  let downloadUrl: string | null = null;
  let urlExpiresAt: string | null = null;
  let derivativeUrl: string | null = null;
  let posterUrl: string | null = null;

  // The 9:16 file and its still, signed only when they really exist. Asking
  // for a URL to a key that is null would sign a path to nothing, and the
  // client would get a link that 404s instead of an honest absence.
  if (includeUrl && clip.derivativeStatus === 'ready' && clip.derivativeStorageKey) {
    derivativeUrl = await getStorage().createDownloadUrl(clip.derivativeStorageKey);
  }
  if (includeUrl && clip.posterStorageKey) {
    posterUrl = await getStorage().createDownloadUrl(clip.posterStorageKey);
  }

  if (includeUrl && clip.status === 'ready' && clip.storageKey) {
    // Two URLs for the same object, differing only in disposition. Inline
    // playback needs the bytes served as video; saving needs them served as an
    // attachment, and a single URL cannot do both — `attachment` can stop a
    // <video> element playing it.
    const [inline, attachment] = await Promise.all([
      getStorage().createDownloadUrl(clip.storageKey),
      getStorage().createDownloadUrl(clip.storageKey, {
        downloadFilename: `clipit-${formatTimecode(clip.startSeconds)}-${formatTimecode(clip.endSeconds)}.mp4`,
      }),
    ]);
    url = inline;
    downloadUrl = attachment;
    urlExpiresAt = new Date(Date.now() + env.SIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();
  }

  return {
    id: clip.id,
    videoId: clip.videoId,
    clipMatchId: clip.clipMatchId,
    status: clip.status,
    error: clip.errorMessage,
    startSeconds: clip.startSeconds,
    endSeconds: clip.endSeconds,
    startTimecode: formatTimecode(clip.startSeconds),
    endTimecode: formatTimecode(clip.endSeconds),
    // The model's original boundaries and whether the person has moved them
    // — what the adjust control starts from, and how an edited clip is told
    // apart from an untouched one.
    predictedStartSeconds: clip.predictedStartSeconds,
    predictedEndSeconds: clip.predictedEndSeconds,
    boundariesEditedAt: clip.boundariesEditedAt ? clip.boundariesEditedAt.toISOString() : null,
    // The spec the editor saved, so re-opening the editor starts from it.
    captions: clip.captions ?? null,
    derivedFromClipId: clip.derivedFromClipId,
    durationSeconds: clip.durationSeconds,
    sizeBytes: clip.sizeBytes,
    url,
    downloadUrl,
    urlExpiresAt,
    /**
     * What to actually show. One block, built in one place, so no route can
     * form its own opinion about whether a moment is vertical.
     *
     * `media.url` is the 9:16 derivative only when that derivative genuinely
     * exists. It never silently falls back to the landscape file — that
     * substitution is exactly what the post-ready rule forbids, and a
     * serializer is precisely where it would happen without anyone deciding
     * to.
     */
    media: clipMediaContract(
      {
        canonicalUrl: url,
        derivativeUrl,
        derivativeStorageKey: clip.derivativeStorageKey,
        derivativeStatus: clip.derivativeStatus,
        posterUrl,
        posterStorageKey: clip.posterStorageKey,
        posterTimestampSeconds: clip.posterTimestampSeconds,
        sourceWidth: clip.sourceWidth,
        sourceHeight: clip.sourceHeight,
        outputWidth: clip.outputWidth,
        outputHeight: clip.outputHeight,
        compositionMode: clip.compositionMode as CompositionMode | null,
        focalX: clip.focalX,
        focalY: clip.focalY,
      },
      // A clip made by the post-ready pipeline was made FOR a vertical
      // request. The row itself says so; no caller has to remember to.
      clip.preRendered,
    ),
    /** Set when someone pressed Keep. Null means it is still on offer. */
    approvedAt: clip.approvedAt ? clip.approvedAt.toISOString() : null,
    createdAt: clip.createdAt.toISOString(),
    updatedAt: clip.updatedAt.toISOString(),
  };
}
