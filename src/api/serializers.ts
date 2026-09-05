import { env } from '../config/env.js';
import { getStorage } from '../services/storage/s3.js';
import { formatTimecode } from '../services/timestamps.js';
import { acceptsQuestions } from '../services/search/readiness.js';
import { latestVersionsForMatches } from '../db/repositories/reclips.js';
import { clipMediaContract } from './mediaContract.js';
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
    /**
     * Whether a question may be sent now. True from the moment the bytes have
     * landed: the answer waits, inside the search, for whatever it needs —
     * see services/search/readiness.ts. `readyForSearch` above still says
     * whether the preparation itself has finished.
     */
    acceptsQuestions: acceptsQuestions(video.status),
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
  /**
   * Moments stored for this question so far. Real while the search is still
   * running — rows the model returned and validation accepted — so a client
   * can say "a few possible moments so far" from something that exists. They
   * are not handed out as moments until the request completes (see
   * visibleMatches), because the search may still fold two of them together.
   */
  candidatesFound: number;
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

function clipRequestProgress(request: ClipRequest, candidatesFound: number): ClipRequestProgress {
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
    candidatesFound,
    message,
  };
}

export async function serializeClipRequest(
  request: ClipRequest,
  matches?: ClipMatch[],
  clipsByMatchId?: Map<string, Clip>,
  options: {
    /** Moments stored so far, shown or not. Defaults to the shown ones. */
    candidatesFound?: number;
  } = {},
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
    progress: clipRequestProgress(request, options.candidatesFound ?? matches?.length ?? 0),
    /**
     * What was asked for and what the video had.
     *
     * Kept under its old name for clients that read it. `available` below
     * `requested` is a fact about the footage, not a failure — a creator who
     * asks for three and is shown two should be told their video had two.
     * `complete` now simply restates that the search finished: nothing is
     * assembled behind an answer any more.
     */
    ...(request.presentationTarget !== null
      ? {
          deck: {
            requestedResultCount: request.requestedResultCount,
            availableCandidateCount: request.availableCandidateCount,
            effectiveDeckTarget: request.effectiveDeckTarget,
            readyResultCount: matches?.length ?? 0,
            complete: request.status === 'completed',
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
 * Which of a request's moments a creator may see.
 *
 * All of them, once the search has finished — and none before. That second
 * half is not a reveal rule; it is about identity. A search that reads the
 * footage stores what each part found as it goes, then folds duplicates
 * together at the end, which rewrites the rows and their ids. A card handed
 * out before that fold would be a card whose moment can vanish under it.
 * Once the request says completed the ids are final, and every moment is
 * shown — with whatever file has since been made for it attached, and with
 * none if nobody has kept it yet.
 *
 * What this replaced, so nobody puts it back: a gate that hid every moment
 * until every one of them had been cut, framed and encoded. The session that
 * ended it found four moments in fifteen seconds and showed them after four
 * and a half minutes. The moment is the evidence; the file is production, and
 * production waits for a person.
 */
export function visibleMatches(
  request: Pick<ClipRequest, 'status' | 'requestedResultCount'>,
  matches: ClipMatch[],
): ClipMatch[] {
  if (request.status !== 'completed') return [];

  // No product cap — but a number the person wrote is a limit (owner,
  // 2026-09-05): "give me 3" shows the best three of whatever qualified, and
  // "find every time" shows every one. Never padded: three asked for and two
  // found is two. Ranked by the model's confidence, ties broken by id so the
  // same request always shows the same three; returned in the stored order.
  const cap = request.requestedResultCount;
  if (cap === null || cap <= 0 || matches.length <= cap) return matches;
  const kept = new Set(
    [...matches]
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
      .slice(0, cap)
      .map((match) => match.id),
  );
  return matches.filter((match) => kept.has(match.id));
}

/** Does this clip's playback slot belong to a 9:16 derivative? */
function wantsVertical(clip: Clip): boolean {
  if (clip.presentation !== null) return clip.presentation === 'vertical';
  return clip.preRendered;
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
      // The row says which deliverable it was made for. A pre-rendered row
      // from before the column was always a vertical one; a clip cut on
      // demand delivers its canonical file.
      wantsVertical(clip),
    ),
    /** Which file this moment delivers: its own framing, or a 9:16 derivative. */
    presentation: clip.presentation ?? (clip.preRendered ? 'vertical' : 'original'),
    /** Set when someone pressed Keep. Null means it is still on offer. */
    approvedAt: clip.approvedAt ? clip.approvedAt.toISOString() : null,
    createdAt: clip.createdAt.toISOString(),
    updatedAt: clip.updatedAt.toISOString(),
  };
}
