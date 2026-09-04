/**
 * Does searching the video itself actually work?
 *
 * This is the experiment the whole Media Index rests on, run against one real
 * Clipit video and writing nothing anywhere. It answers, with numbers:
 *
 *   1. Can a typed question find the right ten seconds of footage?
 *   2. Which KIND of question does it work for — objects, motion, visible
 *      text, speech, or a mix?
 *   3. Does the reranker improve the shortlist, or just reorder it?
 *   4. What window length and overlap actually retrieve best?
 *   5. What do the pictures alone find, what does the transcript alone find,
 *      and what does using both find? They are NOT interchangeable and this
 *      measures the difference rather than assuming it.
 *   6. What does it cost, and how long does it take?
 *
 * Run it where the real credentials live (a Railway shell, or locally with the
 * production environment):
 *
 *     node dist/scripts/mediaIndexExperiment.js --video <videoId> --probes probes.json
 *     node dist/scripts/mediaIndexExperiment.js --video <videoId> --ask "the red truck"
 *     node dist/scripts/mediaIndexExperiment.js --list
 *
 * `--ask` is exploration: it prints the best-matching moments for one question
 * so you can watch them and see for yourself. `--probes` is measurement, and
 * needs a file saying what the right answer is. Nothing here can tell you
 * whether retrieval is good without you first saying what good would be.
 *
 * The probes file is a list of:
 *
 *   {
 *     "kind": "object" | "motion" | "visible-text" | "speech" | "mixed",
 *     "query": "the sign that says LOADING BAY",
 *     "expect": { "startSeconds": 402, "endSeconds": 412 },
 *     "distractor": { "startSeconds": 631, "endSeconds": 641 },
 *     "note": "there is a second sign at 10:31 reading FIRE EXIT"
 *   }
 *
 * `distractor` is what makes the visible-text question answerable. Without a
 * near-twin to rank against, "found a sign" and "found the RIGHT sign" look
 * identical, and only the second one is retrieval.
 *
 * Nothing is written to the database and no signed URL is ever printed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { queryRows } from '../db/pool.js';
import { getStorage } from '../services/storage/s3.js';
import { listTranscriptSegments } from '../db/repositories/transcripts.js';
import {
  DEFAULT_WINDOW_PLAN,
  planWindows,
  uncoveredSeconds,
  windowKey,
  type IndexWindow,
  type WindowPlan,
} from '../services/mediaIndex/windows.js';
import {
  embedTexts,
  embedVideoIntervals,
  rerankVideoIntervals,
  type EmbeddedInterval,
} from '../services/mediaIndex/qwen.js';
import { sourceIdentity, type SourceIdentity } from '../services/mediaIndex/sourceIdentity.js';

// ---------------------------------------------------------------- arguments

interface Args {
  videoId?: string;
  probesPath?: string;
  ask?: string;
  list: boolean;
  sweep: boolean;
  topK: number;
  rerankTop: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, sweep: false, topK: 10, rerankTop: 5, out: 'media-index-experiment.json' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--video') { args.videoId = value; i += 1; }
    else if (flag === '--probes') { args.probesPath = value; i += 1; }
    else if (flag === '--ask') { args.ask = value; i += 1; }
    else if (flag === '--top') { args.topK = Number(value); i += 1; }
    else if (flag === '--rerank-top') { args.rerankTop = Number(value); i += 1; }
    else if (flag === '--out') { args.out = value!; i += 1; }
    else if (flag === '--list') args.list = true;
    else if (flag === '--sweep') args.sweep = true;
  }
  return args;
}

// ------------------------------------------------------------------- probes

type ProbeKind = 'object' | 'motion' | 'visible-text' | 'speech' | 'mixed' | 'audio';

interface Probe {
  kind: ProbeKind;
  query: string;
  expect: { startSeconds: number; endSeconds: number };
  distractor?: { startSeconds: number; endSeconds: number };
  note?: string;
}

const PROBE_KINDS: ProbeKind[] = ['object', 'motion', 'visible-text', 'speech', 'mixed', 'audio'];

/**
 * A probe is GROUND TRUTH, and a broken one is not a retrieval failure.
 *
 * Left unchecked, a reversed range, a missing number or a timestamp past the
 * end of the video comes out of this run as "the model did not find it" —
 * a typo in a JSON file, reported as evidence about a model. That is the
 * whole experiment answering the wrong question, so every field is checked
 * before a single GPU second is spent.
 */
function checkRange(
  range: unknown, where: string, durationSeconds: number | null,
): { startSeconds: number; endSeconds: number } {
  const value = range as { startSeconds?: unknown; endSeconds?: unknown } | null;
  const start = value?.startSeconds;
  const end = value?.endSeconds;
  if (typeof start !== 'number' || !Number.isFinite(start)) {
    throw new Error(`${where}: startSeconds must be a number, got ${JSON.stringify(start)}`);
  }
  if (typeof end !== 'number' || !Number.isFinite(end)) {
    throw new Error(`${where}: endSeconds must be a number, got ${JSON.stringify(end)}`);
  }
  if (start < 0) throw new Error(`${where}: startSeconds is negative (${start})`);
  if (end <= start) throw new Error(`${where}: endSeconds (${end}) must be after startSeconds (${start})`);
  if (durationSeconds !== null && end > durationSeconds) {
    throw new Error(
      `${where}: ends at ${end}s but the video is only ${durationSeconds.toFixed(1)}s long`,
    );
  }
  return { startSeconds: start, endSeconds: end };
}

export async function loadProbes(path: string): Promise<Probe[]> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : (parsed as { probes?: unknown }).probes;
  if (!Array.isArray(rows)) throw new Error(`${path} should hold a JSON array of probes`);
  return rows.map((row, index) => {
    const probe = row as Probe;
    const where = `probe ${index}`;
    if (typeof probe.query !== 'string' || probe.query.trim() === '') {
      throw new Error(`${where}: "query" must be a non-empty string`);
    }
    if (!PROBE_KINDS.includes(probe.kind)) {
      throw new Error(`${where}: "kind" must be one of ${PROBE_KINDS.join(', ')}, got ${JSON.stringify(probe.kind)}`);
    }
    // Duration is not known yet; the ranges are re-checked against it below.
    const expect = checkRange(probe.expect, `${where} ("${probe.query}") expect`, null);

    // `in` rather than truthiness: a distractor written as null, 0 or "" is a
    // mistake somebody made, and silently treating it as absent would turn a
    // typo into a quietly weaker experiment.
    const supplied = Object.prototype.hasOwnProperty.call(probe, 'distractor');
    const distractor = supplied
      ? checkRange(probe.distractor, `${where} ("${probe.query}") distractor`, null)
      : undefined;

    // The visible-text probe is the one that decides whether a separate text
    // channel is needed, and it cannot decide anything without a near-twin to
    // rank against. "Found a sign" and "found the RIGHT sign" score the same
    // when there is nothing to compare with, so a missing distractor here
    // would report plain object recognition as successful text retrieval —
    // the exact conclusion this probe exists to rule out.
    if (probe.kind === 'visible-text' && !distractor) {
      throw new Error(
        `${where} ("${probe.query}"): a visible-text probe needs a "distractor" — a second, different ` +
          'piece of visible text to rank against. Without one it cannot tell reading from recognising.',
      );
    }

    // A distractor overlapping the answer is not a distractor. The two would
    // share windows, and the margin between them would be a number about
    // nothing.
    if (
      distractor &&
      distractor.startSeconds < expect.endSeconds &&
      distractor.endSeconds > expect.startSeconds
    ) {
      throw new Error(
        `${where} ("${probe.query}"): the distractor (${distractor.startSeconds}-${distractor.endSeconds}s) ` +
          `overlaps the expected moment (${expect.startSeconds}-${expect.endSeconds}s), so comparing them means nothing.`,
      );
    }

    return { ...probe, expect, ...(distractor ? { distractor } : {}) };
  });
}

/** Re-checked once the video's real length is known. */
export function assertProbesFitVideo(probes: Probe[], durationSeconds: number): void {
  for (const [index, probe] of probes.entries()) {
    checkRange(probe.expect, `probe ${index} ("${probe.query}") expect`, durationSeconds);
    if (probe.distractor) {
      checkRange(probe.distractor, `probe ${index} ("${probe.query}") distractor`, durationSeconds);
    }
  }
}

// ------------------------------------------------------------------ scoring

/** Cosine similarity. Both sides are unit vectors, so this is a dot product. */
function similarity(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!;
  return sum;
}

/** Whether a window shows the moment a probe is asking about. */
function overlaps(window: IndexWindow, range: { startSeconds: number; endSeconds: number }): boolean {
  return window.startSeconds < range.endSeconds && window.endSeconds > range.startSeconds;
}

interface Scored { window: IndexWindow; score: number }

function rankOf(ranked: Scored[], range: { startSeconds: number; endSeconds: number }): number | null {
  const index = ranked.findIndex((row) => overlaps(row.window, range));
  return index === -1 ? null : index + 1;
}

/** Highest score among windows that do NOT show the answer. The bar to beat. */
function bestWrongScore(ranked: Scored[], range: { startSeconds: number; endSeconds: number }): number | null {
  const wrong = ranked.find((row) => !overlaps(row.window, range));
  return wrong?.score ?? null;
}

// ------------------------------------------------------------------ helpers

function timecode(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function describe(window: IndexWindow): string {
  return `${timecode(window.startSeconds)}–${timecode(window.endSeconds)}`;
}

/**
 * Embeds every window of the video, in batches.
 *
 * One signed URL per batch, and the remote container caches its download under
 * the STABLE key, so a whole video costs one fetch however many batches it
 * takes. The URL is re-signed per batch so a long run cannot expire halfway.
 */
async function embedAllWindows(input: {
  proxyKey: string;
  /** Key plus content tag, and the size it was read at. Never the signed URL. */
  source: SourceIdentity;
  windows: IndexWindow[];
}): Promise<{ vectors: Map<string, Float32Array>; failed: Array<{ id: string; reason: string }>; metrics: Array<Record<string, unknown>> }> {
  const vectors = new Map<string, Float32Array>();
  const failed: Array<{ id: string; reason: string }> = [];
  const metrics: Array<Record<string, unknown>> = [];
  const size = env.MEDIA_INDEX_BATCH_WINDOWS;

  for (let offset = 0; offset < input.windows.length; offset += size) {
    const batch = input.windows.slice(offset, offset + size);
    const videoUrl = await getStorage().createDownloadUrl(input.proxyKey, {
      expiresInSeconds: env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS,
    });
    const result = await embedVideoIntervals({
      videoUrl,
      videoKey: input.source.identity,
      expectedBytes: input.source.sizeBytes,
      // The proxy IS the source timeline, so window seconds need no rebasing.
      intervals: batch.map((window) => ({
        id: windowKey(window), start: window.startSeconds, end: window.endSeconds,
      })),
    });
    for (const row of result.embedded) vectors.set(row.id, row.embedding);
    failed.push(...result.failed);
    metrics.push(result.metrics);
    process.stdout.write(
      `  embedded ${Math.min(offset + size, input.windows.length)}/${input.windows.length} windows` +
      `${result.failed.length > 0 ? ` (${result.failed.length} failed)` : ''}\n`,
    );
  }

  // The identity was read before the first signed URL was minted, and the
  // proxy key is a mutable one — re-processing the video overwrites it. If it
  // moved while this was running, some of these vectors are of one version of
  // the video and some of another, and the remote cache is now holding new
  // bytes under the old identity, which would poison every later call too.
  //
  // Nothing here can tell which vectors are which, so none of them are
  // believed. (Pinning the download to an exact object version would prevent
  // the race rather than detect it; that needs to be tried against the real
  // store, which this environment cannot reach.)
  const after = await sourceIdentity(input.proxyKey);
  if (after.identity !== input.source.identity) {
    throw new Error(
      `The analysis proxy changed while it was being indexed (${input.source.identity.split('#')[1]} → ` +
        `${after.identity.split('#')[1]}). Some of these vectors describe footage that has been replaced, and ` +
        'nothing here can tell which. Re-run once the video has finished re-processing.',
    );
  }

  return { vectors, failed, metrics };
}

/**
 * The words spoken inside each window, as one string.
 *
 * This is the transcript AS A SEPARATE SIGNAL, not as a caption on the video
 * vector. The video model is vision and language — it does not hear — so what
 * was SAID reaches the index only through here. Measuring the two channels
 * apart is the point: a question about speech and a question about a red
 * truck are not the same retrieval problem and must not be assumed to be.
 */
async function speechPerWindow(videoId: string, windows: IndexWindow[]): Promise<Map<string, string>> {
  const segments = await listTranscriptSegments(videoId);
  const spoken = new Map<string, string>();
  for (const window of windows) {
    const words = segments
      .filter((segment) => segment.startSeconds < window.endSeconds && segment.endSeconds > window.startSeconds)
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(' ');
    if (words) spoken.set(windowKey(window), words);
  }
  return spoken;
}

/**
 * What the GPU time this run held is worth, in dollars.
 *
 * An ESTIMATE, and labelled as one everywhere it is printed. Modal's JS SDK
 * exposes no supported billing API, so this is measured wall-clock inside the
 * service multiplied by a rate somebody typed in — the same arithmetic, and
 * the same honesty rule, the evaluation page already uses. With no rate
 * configured it returns null and the report says the rate is not set, rather
 * than pricing GPU seconds at zero and calling it free.
 */
function estimateGpuCost(msHeld: number): { usd: number | null; note: string } {
  const rate = env.MODAL_L4_USD_PER_GPU_HOUR;
  if (rate === null) {
    return { usd: null, note: 'MODAL_L4_USD_PER_GPU_HOUR is not set, so no cost can be estimated' };
  }
  return {
    usd: Number(((msHeld / 3_600_000) * rate).toFixed(4)),
    note: `estimated from ${(msHeld / 1000).toFixed(1)}s of measured GPU time at $${rate}/hour`,
  };
}

/**
 * How long the GPU was actually held.
 *
 * The per-call timers start inside the remote method, which is AFTER the
 * model has been loaded onto the GPU — and loading it is real, billed time.
 * A cost built from the call timers alone understates every cold container,
 * which is precisely the container an experiment starts on.
 *
 * So the load is added, once per container rather than once per call: each
 * reply carries the id of the container that served it and how long that
 * container spent starting up. Twenty calls to one warm container pay for one
 * startup, which is what actually happened.
 */
function gpuMsFrom(metrics: Array<Record<string, unknown>>): number {
  const calls = metrics.reduce((sum, row) => sum + (typeof row.total_ms === 'number' ? row.total_ms : 0), 0);

  const startupByContainer = new Map<string, number>();
  for (const row of metrics) {
    if (typeof row.container !== 'string' || typeof row.startup_ms !== 'number') continue;
    startupByContainer.set(row.container, row.startup_ms);
  }
  const startup = [...startupByContainer.values()].reduce((sum, ms) => sum + ms, 0);

  return calls + startup;
}

/**
 * Can this grid tell a probe's answer from its distractor at all?
 *
 * Two ranges that do not overlap EACH OTHER can still both sit inside one
 * window — likelier the coarser the grid, and likelier still where windows
 * overlap. When that happens there is no window holding the twin and not the
 * answer, and the visible-text comparison has nothing to compare: the margin
 * would come out at zero and read as "the model cannot tell these apart",
 * when in truth nothing was ever put side by side.
 *
 * Checked per grid, because it is a property of the grid and not of the
 * probe, and the sweep runs several.
 */
function assertDistractorsSeparable(probes: Probe[], windows: IndexWindow[], grid: string): void {
  for (const [index, probe] of probes.entries()) {
    if (!probe.distractor) continue;
    const separable = windows.some(
      (window) => overlaps(window, probe.distractor!) && !overlaps(window, probe.expect),
    );
    if (!separable) {
      throw new Error(
        `probe ${index} ("${probe.query}") at ${grid}: no window holds the distractor ` +
          `(${probe.distractor.startSeconds}-${probe.distractor.endSeconds}s) without also holding the ` +
          `answer (${probe.expect.startSeconds}-${probe.expect.endSeconds}s), so comparing them would ` +
          'measure one piece of footage against itself. Move them further apart, or drop this grid.',
      );
    }
  }
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    console.error('MODAL_TOKEN_ID and MODAL_TOKEN_SECRET must be set. VIDEO_PROVIDER does not need changing.');
    process.exit(2);
  }

  if (args.list) {
    const rows = await queryRows<{ id: string; title: string | null; duration_seconds: number | null }>(
      `SELECT id, title, duration_seconds FROM videos
        WHERE proxy_storage_key IS NOT NULL AND status = 'ready'
        ORDER BY created_at DESC LIMIT 20`,
    );
    for (const row of rows) {
      console.log(`${row.id}  ${row.duration_seconds ? timecode(row.duration_seconds) : '  ?  '}  ${row.title ?? '(untitled)'}`);
    }
    return;
  }

  if (!args.videoId) {
    console.error('Pass --video <videoId>, or --list to see what is available.');
    process.exit(2);
  }

  // The probe file is read and structurally checked FIRST, before the database
  // is touched at all. It needs nothing but itself to be judged, and a typo in
  // it should cost nothing — not a query, not a signed URL, and certainly not
  // the two embedding calls it used to cost.
  const probes = args.probesPath ? await loadProbes(args.probesPath) : [];
  if (probes.length === 0 && !args.ask) {
    console.error('Nothing to measure. Pass --probes <file> for numbers, or --ask "<question>" to look around.');
    process.exit(2);
  }

  const [video] = await queryRows<{ id: string; title: string | null; duration_seconds: number | null; proxy_storage_key: string | null }>(
    `SELECT id, title, duration_seconds, proxy_storage_key FROM videos WHERE id = $1`, [args.videoId],
  );
  if (!video) { console.error(`No video ${args.videoId}`); process.exit(2); }
  if (!video.proxy_storage_key) { console.error('That video has no analysis proxy to index.'); process.exit(2); }
  if (!video.duration_seconds) { console.error('That video has no measured duration.'); process.exit(2); }

  const proxyKey = video.proxy_storage_key;
  const duration = Number(video.duration_seconds);

  console.log(`video      ${video.id}  ${video.title ?? '(untitled)'}`);
  console.log(`duration   ${timecode(duration)}`);
  console.log(`proxy      ${env.PROXY_HEIGHT}p at ${env.PROXY_FPS} fps (one continuous file — no chunks are used here)`);
  console.log(`model      ${env.MEDIA_INDEX_EMBED_MODEL} at ${env.MEDIA_INDEX_EMBED_DIMS} dimensions`);
  console.log(`sampling   ${env.MEDIA_INDEX_SAMPLE_FPS} fps, up to ${env.MEDIA_INDEX_MAX_FRAMES} frames per window`);

  // The one probe check that needs the video: a moment past its end fails the
  // run rather than counting as something the model could not find. Still
  // ahead of every signed URL and every GPU call.
  assertProbesFitVideo(probes, duration);

  // Resolved once, before any GPU work: the proxy key plus the store's tag for
  // its current bytes. A re-processed video overwrites the key, and a warm
  // container caching on the key alone would embed the previous footage.
  const source = await sourceIdentity(proxyKey);
  console.log(`identity   ${source.identity.split('#')[1]}  ` +
    `(content tag, ${(source.sizeBytes / 1_000_000).toFixed(1)} MB — a re-processed video gets a new one)\n`);

  /**
   * Before anything else: is the question actually being phrased differently
   * from the footage?
   *
   * These models are asymmetric, and getting it wrong does not raise — it
   * returns confident, well-ordered, wrong rankings, which is indistinguishable
   * from working retrieval unless something checks. So the same sentence is
   * embedded both ways and the two vectors compared. Identical vectors mean
   * the flag is inert and every number printed below would be measuring
   * symmetric embeddings while claiming otherwise.
   */
  const SAME = 'a red pickup truck pulls out of the driveway';
  const [asQuery, asDocument] = await Promise.all([
    embedTexts({ texts: [{ id: 'probe', text: SAME }], isQuery: true }),
    embedTexts({ texts: [{ id: 'probe', text: SAME }], isQuery: false }),
  ]);
  const asymmetry = 1 - similarity(asQuery.embedded[0]!.embedding, asDocument.embedded[0]!.embedding);
  if (asymmetry < 1e-6) {
    // A measurement run STOPS here. Printing a warning and carrying on would
    // write a report file that looks like every other report file, with the
    // one fact that invalidates it two hundred lines up the scrollback. An
    // exploration run (--ask) may continue: it makes no claims and produces
    // no numbers to be believed.
    const complaint =
      'The same sentence embeds identically as a question and as a document, so the ' +
      'query/document distinction is inert. Every measurement below would be of symmetric ' +
      'embeddings while claiming otherwise. Fix the service before running this again.';
    if (probes.length > 0) throw new Error(complaint);
    console.log(`WARNING  ${complaint}\n`);
  } else {
    console.log(`asymmetry  question and document differ by ${asymmetry.toFixed(4)} — the distinction is live`);
  }
  // Which weights produced everything below. 'unpinned' means the service
  // loaded whatever the hub was serving, so this run is reproducible only
  // until those weights change.
  console.log(`weights    ${asQuery.revision}${asQuery.revision === 'unpinned' ? '  (pin before the index becomes durable)' : ''}\n`);

  // Which grids to try. One by default, because every extra grid is a whole
  // second pass over the video on a real GPU.
  const grids: WindowPlan[] = args.sweep
    ? [
        { windowSeconds: 6, strideSeconds: 3, minWindowSeconds: 2 },
        { ...DEFAULT_WINDOW_PLAN },
        { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 },
        { windowSeconds: 20, strideSeconds: 10, minWindowSeconds: 5 },
      ]
    : [{
        windowSeconds: env.MEDIA_INDEX_WINDOW_SECONDS,
        strideSeconds: env.MEDIA_INDEX_STRIDE_SECONDS,
        minWindowSeconds: env.MEDIA_INDEX_MIN_WINDOW_SECONDS,
      }];


  const report: Record<string, unknown>[] = [];

  for (const grid of grids) {
    const label = `${grid.windowSeconds}s window / ${grid.strideSeconds}s stride`;
    console.log(`\n=== ${label} ===`);

    const windows = planWindows(duration, grid);
    console.log(`  ${windows.length} windows over ${timecode(duration)}`);
    assertDistractorsSeparable(probes, windows, label);

    const startedAt = performance.now();
    const { vectors, failed, metrics } = await embedAllWindows({ proxyKey, source, windows });
    const embedMs = Math.round(performance.now() - startedAt);

    const covered = windows.filter((window) => vectors.has(windowKey(window)));
    const gaps = uncoveredSeconds(covered, duration);
    console.log(`  ${covered.length}/${windows.length} embedded in ${(embedMs / 1000).toFixed(1)}s` +
      `  (${(duration / (embedMs / 1000)).toFixed(1)}s of video per second)`);
    if (gaps.length > 0) {
      // Named, never implied. A stretch with no vector is a stretch nothing
      // can retrieve from, and it must not read as a stretch with nothing in it.
      console.log(`  NOT INDEXED: ${gaps.map(describe).join(', ')}`);
    }

    // The transcript as its own channel.
    //
    // Batched exactly as the video windows are. A six-hour video at a five
    // second stride is over four thousand transcript windows, and handing all
    // of them to one call would fail the whole run on a video long enough to
    // be worth indexing in the first place. Failures are carried across
    // batches rather than swallowed: a window whose speech could not be
    // embedded has no speech channel, and the summary below must not report
    // that as a window with nothing said in it.
    // Over EVERY planned window, not only the ones the pictures worked for.
    // Coupling them meant a failed video window silently deleted that
    // window's speech too, so the speech column understated itself and the
    // comparison this experiment exists to make — are these channels
    // interchangeable? — was measured on a set one channel had pruned.
    const spoken = await speechPerWindow(video.id, windows);
    let speechVectors = new Map<string, Float32Array>();
    const speechMetrics: Array<Record<string, unknown>> = [];
    if (spoken.size > 0) {
      const texts = [...spoken.entries()].map(([id, text]) => ({ id, text }));
      const speechFailures: Array<{ id: string; reason: string }> = [];
      for (let offset = 0; offset < texts.length; offset += env.MEDIA_INDEX_BATCH_WINDOWS) {
        const said = await embedTexts({
          texts: texts.slice(offset, offset + env.MEDIA_INDEX_BATCH_WINDOWS),
          isQuery: false,
        });
        for (const row of said.embedded as EmbeddedInterval[]) speechVectors.set(row.id, row.embedding);
        speechFailures.push(...said.failed);
        // Counted, not discarded. Indexing a video with speech means both
        // passes, and a cost figure that quietly covers only the pictures is
        // worse than the missing figure it replaced — it looks answered.
        speechMetrics.push(said.metrics);
      }
      console.log(`  ${speechVectors.size} of ${texts.length} windows carry speech `+ `(counted over all ${windows.length} planned windows, independently of the pictures)`);
      if (speechFailures.length > 0) {
        console.log(`  ${speechFailures.length} transcript windows could not be embedded: ` +
          `${speechFailures.slice(0, 3).map((row) => row.reason).join('; ')}`);
      }
    } else {
      console.log('  no transcript for this video — the speech channel is empty, and speech probes below measure nothing');
    }

    // Every window this run knows about, by key, so a channel can be ranked
    // over the windows IT has vectors for rather than over the other
    // channel's successes.
    const byKey = new Map(windows.map((window) => [windowKey(window), window]));

    const rank = (queryVector: Float32Array, channel: Map<string, Float32Array>): Scored[] =>
      [...channel.entries()]
        .map(([key, vector]) => {
          const window = byKey.get(key);
          return window ? { window, score: similarity(queryVector, vector) } : null;
        })
        .filter((row): row is Scored => row !== null)
        .sort((a, b) => b.score - a.score);

    /** Both channels at once: a window is as good as its best evidence. */
    const rankFused = (queryVector: Float32Array): Scored[] => {
      const seen = new Map<string, Scored>();
      for (const row of [...rank(queryVector, vectors), ...rank(queryVector, speechVectors)]) {
        const key = windowKey(row.window);
        const best = seen.get(key);
        if (!best || row.score > best.score) seen.set(key, row);
      }
      return [...seen.values()].sort((a, b) => b.score - a.score);
    };

    // ---- exploration -----------------------------------------------------
    if (args.ask) {
      const asked = await embedTexts({ texts: [{ id: 'q', text: args.ask }], isQuery: true });
      const queryVector = asked.embedded[0]!.embedding;
      console.log(`\n  "${args.ask}"`);
      for (const [name, ranked] of [
        ['pictures', rank(queryVector, vectors)],
        ['speech', rank(queryVector, speechVectors)],
        ['both', rankFused(queryVector)],
      ] as const) {
        if (ranked.length === 0) continue;
        console.log(`    ${name.padEnd(9)} ${ranked.slice(0, args.topK).map((row) => `${describe(row.window)} (${row.score.toFixed(3)})`).join('  ')}`);
      }
    }

    // ---- measurement -----------------------------------------------------
    const probeResults: Record<string, unknown>[] = [];
    const rerankMetrics: Array<Record<string, unknown>> = [];

    for (const probe of probes) {
      const asked = await embedTexts({ texts: [{ id: 'q', text: probe.query }], isQuery: true });
      const queryVector = asked.embedded[0]!.embedding;

      const channels = {
        visual: rank(queryVector, vectors),
        speech: rank(queryVector, speechVectors),
        both: rankFused(queryVector),
      };

      const row: Record<string, unknown> = {
        kind: probe.kind, query: probe.query,
        expect: `${describe({ startSeconds: probe.expect.startSeconds, endSeconds: probe.expect.endSeconds })}`,
      };

      for (const [name, ranked] of Object.entries(channels)) {
        if (ranked.length === 0) { row[name] = null; continue; }
        const correctRank = rankOf(ranked, probe.expect);
        const correct = ranked.find((entry) => overlaps(entry.window, probe.expect));
        const wrong = bestWrongScore(ranked, probe.expect);
        row[name] = {
          rank: correctRank,
          score: correct ? Number(correct.score.toFixed(4)) : null,
          // How far clear of the best wrong answer. A rank of 1 with a margin
          // of 0.001 is a coin toss that happened to land right.
          margin: correct && wrong !== null ? Number((correct.score - wrong).toFixed(4)) : null,
          ...(probe.distractor
            ? (() => {
                // The twin has to be footage the answer is NOT also in.
                // Two ranges that do not overlap each other can still land
                // inside one ten-second window, and comparing a window with
                // itself yields a margin of zero — which would read as "the
                // model cannot tell these apart" when nothing was compared.
                const twin = ranked.find(
                  (entry) => overlaps(entry.window, probe.distractor!) && !overlaps(entry.window, probe.expect),
                );
                return {
                  distractorScore: twin ? Number(twin.score.toFixed(4)) : null,
                  // The visible-text verdict. Positive means the model read
                  // the words; near zero means it recognised "a sign".
                  beatsDistractor: correct && twin ? Number((correct.score - twin.score).toFixed(4)) : null,
                };
              })()
            : {}),
        };
      }

      // ---- does reranking help? -------------------------------------------
      const shortlist = channels.both.slice(0, args.rerankTop);
      if (shortlist.length > 1) {
        const videoUrl = await getStorage().createDownloadUrl(proxyKey, {
          expiresInSeconds: env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS,
        });
        const reranked = await rerankVideoIntervals({
          query: probe.query, videoUrl, videoKey: source.identity, expectedBytes: source.sizeBytes,
          candidates: shortlist.map((entry) => ({
            id: windowKey(entry.window), start: entry.window.startSeconds, end: entry.window.endSeconds,
          })),
        });
        const byKey = new Map(shortlist.map((entry) => [windowKey(entry.window), entry.window]));
        const rerankedWindows: Scored[] = reranked.ranked
          .map((entry) => { const window = byKey.get(entry.id); return window ? { window, score: entry.score } : null; })
          .filter((entry): entry is Scored => entry !== null);
        rerankMetrics.push(reranked.metrics);
        row.reranked = {
          rankBefore: rankOf(shortlist, probe.expect),
          rankAfter: rankOf(rerankedWindows, probe.expect),
          failed: reranked.failed.length,
          ms: reranked.metrics.total_ms ?? null,
        };
      }

      probeResults.push(row);
      const both = row.both as { rank: number | null } | null;
      console.log(`  [${probe.kind.padEnd(12)}] rank ${String(both?.rank ?? '—').padStart(3)}  ${probe.query}`);
    }

    // ---- the summary that decides the configuration -----------------------
    const byKind = new Map<string, Array<Record<string, unknown>>>();
    for (const row of probeResults) {
      const list = byKind.get(row.kind as string) ?? [];
      list.push(row);
      byKind.set(row.kind as string, list);
    }

    if (probeResults.length > 0) {
      console.log('\n  kind          n   visual@1  speech@1   both@1   both@3');
      for (const [kind, rows] of byKind) {
        const at = (channel: string, within: number) =>
          rows.filter((row) => {
            const entry = row[channel] as { rank: number | null } | null;
            return entry?.rank !== null && entry !== null && (entry.rank as number) <= within;
          }).length;
        const pct = (n: number) => `${Math.round((100 * n) / rows.length)}%`.padStart(7);
        console.log(`  ${kind.padEnd(13)} ${String(rows.length).padStart(2)}  ${pct(at('visual', 1))}  ${pct(at('speech', 1))}  ${pct(at('both', 1))}  ${pct(at('both', 3))}`);
      }
      // Indexing is BOTH passes. Splitting them out as well, because "the
      // pictures cost this much and the words cost that much" is the number
      // that decides whether a channel earns its place.
      const visualCost = estimateGpuCost(gpuMsFrom(metrics));
      const speechCost = estimateGpuCost(gpuMsFrom(speechMetrics));
      const indexCost = estimateGpuCost(gpuMsFrom([...metrics, ...speechMetrics]));
      const rerankCost = estimateGpuCost(gpuMsFrom(rerankMetrics));
      const money = (cost: { usd: number | null; note: string }) =>
        cost.usd === null ? cost.note : `~$${cost.usd} (${cost.note})`;
      console.log(`\n  indexing this video: ${money(indexCost)}`);
      console.log(`    of which pictures: ${money(visualCost)}`);
      console.log(`    of which speech:   ${money(speechCost)}`);
      console.log(`  reranking ${probeResults.length} questions: ${money(rerankCost)}`);

      const improved = probeResults.filter((row) => {
        const r = row.reranked as { rankBefore: number | null; rankAfter: number | null } | undefined;
        return r?.rankBefore != null && r.rankAfter != null && r.rankAfter < r.rankBefore;
      }).length;
      const worsened = probeResults.filter((row) => {
        const r = row.reranked as { rankBefore: number | null; rankAfter: number | null } | undefined;
        return r?.rankBefore != null && r.rankAfter != null && r.rankAfter > r.rankBefore;
      }).length;
      console.log(`\n  reranking moved the right answer up on ${improved} probes and down on ${worsened}`);
    }

    report.push({
      grid: label,
      windows: windows.length,
      embedded: covered.length,
      failedWindows: failed,
      notIndexed: gaps.map(describe),
      embedMs,
      secondsOfVideoPerSecond: Number((duration / (embedMs / 1000)).toFixed(2)),
      speechWindows: speechVectors.size,
      remoteMetrics: metrics,
      remoteSpeechMetrics: speechMetrics,
      // Estimated, never measured: Modal exposes no billing API to this SDK,
      // so this is the service's own wall-clock times a configured rate.
      estimatedCost: {
        indexing: estimateGpuCost(gpuMsFrom([...metrics, ...speechMetrics])),
        indexingVisual: estimateGpuCost(gpuMsFrom(metrics)),
        indexingSpeech: estimateGpuCost(gpuMsFrom(speechMetrics)),
        reranking: estimateGpuCost(gpuMsFrom(rerankMetrics)),
      },
      probes: probeResults,
    });
  }

  await writeFile(args.out, JSON.stringify({
    video: { id: video.id, title: video.title, durationSeconds: duration },
    model: env.MEDIA_INDEX_EMBED_MODEL,
    // Recorded with the results: numbers that cannot be traced to weights
    // cannot be reproduced, and this file is the record of the measurement.
    revision: asQuery.revision,
    dims: env.MEDIA_INDEX_EMBED_DIMS,
    sampling: { fps: env.MEDIA_INDEX_SAMPLE_FPS, maxFrames: env.MEDIA_INDEX_MAX_FRAMES, shortSide: env.MEDIA_INDEX_FRAME_SHORT_SIDE },
    runs: report,
  }, null, 2));
  console.log(`\nfull results written to ${args.out}`);
  console.log('nothing was written to the database, and no signed URL was printed.');
}

// Only when run directly. The probe rules below are the experiment's ground
// truth, and a bug in them turns a typo into a conclusion about a model — so
// they are importable and tested rather than sealed inside a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('\nexperiment failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
