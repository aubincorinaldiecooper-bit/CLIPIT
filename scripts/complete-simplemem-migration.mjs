import { readFile, writeFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const at = (path) => new URL(path, root);

async function text(path) {
  return readFile(at(path), 'utf8');
}
async function save(path, value) {
  await writeFile(at(path), value, 'utf8');
}
function mustReplace(value, pattern, replacement, label) {
  const next = value.replace(pattern, replacement);
  if (next === value) console.warn(`migration pattern did not match: ${label}`);
  return next;
}

// --- Clip search: SimpleMem -> Clipit's actual footage watcher -> notes/full footage.
{
  const path = 'src/worker/handlers/clipSearch.ts';
  let s = await text(path);
  s = mustReplace(
    s,
    /import \{ getMediaIndexStatus, listIndexedWindows \} from '\.\.\/\.\.\/db\/repositories\/mediaIndex\.js';\nimport \{[\s\S]*?import \{ estimateGpuCostUsd, gpuMsFrom \} from '\.\.\/\.\.\/services\/mediaIndex\/cost\.js';\n/,
    '',
    'clipSearch media-index imports',
  );
  s = mustReplace(
    s,
    /\n    const fromIndex = await answerFromMediaIndex\(\{[\s\S]*?\n    const notesAvailable =/,
    '\n    const notesAvailable =',
    'clipSearch media-index fallback block',
  );
  s = mustReplace(
    s,
    /  let verified;\n  try \{\n    const source = await sourceIdentity\(input\.video\.proxyStorageKey\);[\s\S]*?\n  const outcome = \{/,
    `  let verified;\n  try {\n    const object = await getStorage().head(input.video.proxyStorageKey);\n    const videoUrl = await getStorage().createDownloadUrl(input.video.proxyStorageKey, {\n      expiresInSeconds: Math.max(60, Math.ceil(env.OPENROUTER_REQUEST_TIMEOUT_MS / 1000) + 60),\n    });\n    verified = await rerankSimpleMemCandidates({\n      query: input.instruction,\n      candidates: mapping.candidates,\n      videoUrl,\n      videoKey: input.video.proxyStorageKey,\n      expectedBytes: object?.sizeBytes ?? input.video.sizeBytes ?? 0,\n      onUsage: (usage) => {\n        void recordModelUsage({\n          ...usage,\n          stage: 'search',\n          videoId: input.video.id,\n          clipRequestId: input.clipRequestId,\n        });\n      },\n    });\n  } catch (error) {\n    const detail = errorMessage(error);\n    input.log.warn('Omni-SimpleMem candidates could not be verified against the actual footage; using fallback retrieval', { err: error });\n    return {\n      matchCount: 0,\n      released: false,\n      fallback: 'primary_failed',\n      outcome: { ...baseOutcome, verificationError: detail },\n    };\n  }\n\n  const outcome = {`,
    'SimpleMem verifier block',
  );
  s = s
    .replaceAll('rerankFailures:', 'verificationFailures:')
    .replaceAll('rerankModel:', 'verificationModel:')
    .replaceAll('rerankRevision:', 'verificationRevision:')
    .replaceAll('rerankMetrics:', 'verificationMetrics:')
    .replaceAll('the reranker could not verify it', 'the actual footage watcher could not verify it');
  s = mustReplace(
    s,
    /\/\*\*\n \* Answering from the vectors, before the notes are asked\.[\s\S]*?(?=\/\*\*\n \* Answers from what was written down at upload)/,
    '',
    'answerFromMediaIndex implementation',
  );
  await save(path, s);
}

// --- Worker: no Media Index readiness, queue, reranker startup check, or yt-dlp binary.
{
  const path = 'src/worker/main.ts';
  let s = await text(path);
  s = s
    .replace("import { assertYtdlpAvailable } from '../services/media/ytdlp.js';\n", '')
    .replace("import { mediaIndexReadiness, watchMediaIndexRecovery } from './mediaIndexReadiness.js';\n", '')
    .replace("import { assertRerankerDeploymentAvailable } from '../services/mediaIndex/qwen.js';\n", '')
    .replace("import { handleMediaIndexing } from './handlers/mediaIndexing.js';\n", '')
    .replace("    mediaIndex: env.MEDIA_INDEX_ENABLED,\n", '')
    .replace("    youtubeIngestion: env.YOUTUBE_INGESTION_ENABLED,\n", '');
  s = mustReplace(
    s,
    /  if \(env\.YOUTUBE_INGESTION_ENABLED\) \{\n    checks\.push\(\['yt-dlp', assertYtdlpAvailable\]\);\n  \}\n/,
    '',
    'worker yt-dlp binary check',
  );
  s = mustReplace(
    s,
    /  const mediaIndexReady = await mediaIndexReadiness\(\);[\s\S]*?(?=  startWorker\(QUEUE_NAMES\.ingestion)/,
    '',
    'worker Media Index startup/readiness',
  );
  s = mustReplace(
    s,
    /  \/\/ Reading a video into vectors is a GPU call per batch of windows,[\s\S]*?  \}\n  \/\/ One at a time as well: a SimpleMem read/,
    '  // One at a time as well: a SimpleMem read',
    'worker Media Index consumer',
  );
  s = mustReplace(
    s,
    /  \/\/ The queues actually being consumed,[\s\S]*?  logger\.info\('worker ready', \{[\s\S]*?\n  \}\);/,
    "  logger.info('worker ready', { queues: Object.values(QUEUE_NAMES) });",
    'worker ready Media Index reporting',
  );
  // Remove the obsolete explanatory paragraph inside checkVideoProviderConfig.
  s = s.replace(/  \/\/ The Media Index's own credential requirement is NOT checked here,[\s\S]*?  \/\/ video; there is nothing left to degrade to\.\n/, '');
  await save(path, s);
}

// --- Preprocessing: only notes + SimpleMem are produced.
{
  const path = 'src/worker/handlers/preprocess.ts';
  let s = await text(path);
  s = s
    .replace('  enqueueMediaIndexing,\n', '')
    .replace("import { setMediaIndexStatus } from '../../db/repositories/mediaIndex.js';\n", '');
  s = mustReplace(
    s,
    /\n      \/\/ 6\. Read the video into vectors as well, when the Media Index is on\.[\s\S]*?(?=\n      \/\/ 7\. Send the video to Omni-SimpleMem)/,
    '',
    'preprocess Media Index enqueue',
  );
  s = s.replace('// 7. Send the video to Omni-SimpleMem as well, when it is being tried.', '// 6. Send the video to Omni-SimpleMem after preprocessing.');
  await save(path, s);
}

// --- Queue registry: retire media-indexing queue entirely.
{
  const path = 'src/queues/index.ts';
  let s = await text(path);
  s = s.replace("  mediaIndexing: 'media-indexing',\n", '');
  s = s.replace(/\/\*\* Read a video into vectors, once, after preprocessing\. \*\/\nexport interface MediaIndexingJob \{\n  videoId: string;\n\}\n\n/, '');
  s = s.replace('  mediaIndexing: Queue<MediaIndexingJob>;\n', '');
  s = s.replace(/      mediaIndexing: new Queue<MediaIndexingJob>\(QUEUE_NAMES\.mediaIndexing, \{ connection, defaultJobOptions \}\),\n/, '');
  s = s.replace(/export async function enqueueMediaIndexing\(data: MediaIndexingJob\): Promise<void> \{\n  await addWithStableId\(getQueues\(\)\.mediaIndexing, 'media-index', data, `media-index-\$\{data\.videoId\}`\);\n\}\n\n/, '');
  await save(path, s);
}

// --- Ingestion: uploads only. Web discovery must acquire bytes before this pipeline.
await save('src/worker/handlers/ingestion.ts', `import type { Job } from 'bullmq';\nimport { logger } from '../../lib/logger.js';\nimport { errorMessage } from '../../lib/errors.js';\nimport { getStorage } from '../../services/storage/s3.js';\nimport { getVideo, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';\nimport { enqueuePreprocessing, type IngestionJob } from '../../queues/index.js';\n\n/**\n * Confirms bytes acquired by Clipit are present, then hands them to the normal\n * preprocessing pipeline. URL/provider acquisition belongs to web discovery's\n * source resolver; this worker never downloads from a public video site.\n */\nexport async function handleIngestion(job: Job<IngestionJob>): Promise<void> {\n  const { videoId } = job.data;\n  const log = logger.child({ job: 'ingestion', videoId });\n  const video = await getVideo(videoId);\n  if (!video) {\n    log.warn('video no longer exists, dropping job');\n    return;\n  }\n  if (video.status === 'ready') {\n    log.info('video already processed, skipping ingestion');\n    return;\n  }\n\n  await setVideoStatus(videoId, 'ingesting');\n  await job.updateProgress({ stage: 'ingesting', percent: 5 });\n\n  try {\n    if (video.sourceType !== 'upload') {\n      console.warn('Legacy URL ingestion has been retired; web sources must be resolved to stored bytes before ingestion');\n    }\n    const key = video.originalStorageKey;\n    if (!key) throw new Error('Upload has no storage key');\n    const object = await getStorage().head(key);\n    if (!object) throw new Error('Uploaded file was not found in storage — complete the presigned upload first');\n\n    await updateVideoMedia(videoId, { sizeBytes: object.sizeBytes });\n    log.info('upload confirmed', { key, sizeBytes: object.sizeBytes });\n    await job.updateProgress({ stage: 'ingested', percent: 30 });\n    await setVideoStatus(videoId, 'preprocessing');\n    await enqueuePreprocessing({ videoId });\n  } catch (error) {\n    const message = errorMessage(error);\n    log.error('ingestion failed', { err: error });\n    await setVideoStatus(videoId, 'failed', message);\n    throw error;\n  }\n}\n`);

// --- API: remove manual YouTube URL creation completely.
{
  const path = 'src/api/routes/videos.ts';
  let s = await text(path);
  s = s.replace("import { isSupportedYoutubeUrl } from '../../services/media/ytdlp.js';\n", '');
  s = mustReplace(
    s,
    /const createVideoSchema = z\.discriminatedUnion\('sourceType', \[[\s\S]*?\n\]\);/,
    `const createVideoSchema = z.object({\n  sourceType: z.literal('upload'),\n  filename: z.string().trim().min(1, 'filename is required').max(255),\n  contentType: z.string().trim().max(120).optional(),\n  /** Announced so the server can decide single-PUT versus part-by-part. */\n  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),\n});`,
    'videos create schema',
  );
  s = mustReplace(
    s,
    /\n    if \(body\.sourceType === 'youtube'\) \{[\s\S]*?\n    \}\n\n    const filename =/,
    '\n    const filename =',
    'manual YouTube creation route',
  );
  s = s.replace('Creates a video from a YouTube URL, or reserves one for a direct upload.', 'Reserves a direct upload. Web search sources enter only after source resolution has acquired bytes.');
  await save(path, s);
}

// --- Environment: remove every executable Media Index and yt-dlp control.
{
  const path = 'src/config/env.ts';
  let s = await text(path);
  s = s.replace(/const optionalInt = \(min\?: number, max\?: number\) =>[\s\S]*?\n\nconst num =/, 'const num =');
  s = mustReplace(
    s,
    /  \/\/ --- Media Index: Qwen embeddings and reranking on Modal ---------------[\s\S]*?(?=  \/\/ --- Retrieval primary:)/,
    '',
    'Media Index environment block',
  );
  s = s.replace(/  \/\*\* Prefer creator\/auto captions from yt-dlp before paying for Whisper\. \*\/\n  YOUTUBE_PREFER_CAPTIONS: bool\(true\),\n  YOUTUBE_CAPTION_LANGS: z\.string\(\)\.default\('en\.\*,en'\),\n\n/, '');
  s = mustReplace(
    s,
    /  \/\*\*\n   \* Whether a video may be created from a YouTube URL\.[\s\S]*?  YTDLP_EXTRACTOR_ARGS: z\.string\(\)\.trim\(\)\.optional\(\),\n/,
    '',
    'yt-dlp environment block',
  );
  s = s.replace('/** Root for transient ffmpeg / yt-dlp scratch files. */', '/** Root for transient ffmpeg scratch files. */');
  s = mustReplace(
    s,
    /\/\*\*\n \* MEDIA_INDEX_STALE_AFTER_SECONDS is optional in the schema[\s\S]*?export const MEDIA_INDEX_HEARTBEAT_WRITE_TIMEOUT_SECONDS = 10;\n/,
    'export type Env = z.infer<typeof envSchema>;\n',
    'Media Index Env type/heartbeat constants',
  );
  s = mustReplace(
    s,
    /  \/\/ The Media Index grid has to be able to cover a timeline\.[\s\S]*?(?=  if \(value\.RETRIEVAL_PRIMARY === 'simplemem')/,
    '',
    'Media Index env validation grid',
  );
  s = s.replace(/  \/\/ MEDIA_INDEX_ENABLED's demand for Modal credentials is NOT checked here,[\s\S]*?(?=  if \(value\.TRANSCRIPTION_ENABLED)/, '');
  s = mustReplace(
    s,
    /\n  \/\/ A run is judged gone by its silence,[\s\S]*?(?=\n  if \(problems\.length > 0\))/,
    '',
    'Media Index heartbeat validation',
  );
  s = mustReplace(
    s,
    /  return \{\n    \.\.\.value,[\s\S]*?\n  \};\n\}/,
    '  return value;\n}',
    'Media Index derived return value',
  );
  await save(path, s);
}

// Keep examples honest: removed variables cannot silently resurrect retired paths.
{
  const path = '.env.example';
  let s = await text(path);
  s = s.split('\n').filter((line) => !/^(MEDIA_INDEX_|YOUTUBE_|YTDLP_)/.test(line.trim())).join('\n');
  await save(path, s);
}

// The verifier reports the same usage records as the normal footage path.
{
  const path = 'src/services/retrieval/simplemem/rerank.ts';
  let s = await text(path);
  s = mustReplace(
    s,
    /  expectedBytes: number;\n\}/,
    '  expectedBytes: number;\n  onUsage?: VideoUsageReporter;\n}',
    'SimpleMem verifier usage callback type',
  );
  s = s.replace('          onUsage: (row) => usage.push(row),', "          onUsage: (row) => { usage.push(row); input.onUsage?.(row); },");
  await save(path, s);
}

// Replace the old reranker test with a test of the actual-footage boundary.
await save('test/simplememRerank.test.ts', `import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';\n\nconst run = vi.fn();\nconst uploadFile = vi.fn();\nconst remove = vi.fn();\nconst searchVideoChunk = vi.fn();\nvi.mock('../src/lib/exec.js', () => ({ run }));\nvi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => ({ uploadFile, remove }) }));\nvi.mock('../src/services/search/openrouterVideo.js', () => ({ searchVideoChunk }));\n\nconst { rerankSimpleMemCandidates } = await import('../src/services/retrieval/simplemem/rerank.js');\nconst candidates = [\n  { startSeconds: 10, endSeconds: 15, score: 0.9, description: 'first', mauIds: ['a'], frames: 1 },\n  { startSeconds: 30, endSeconds: 36, score: 0.8, description: 'second', mauIds: ['b'], frames: 1 },\n];\n\ndescribe('Omni-SimpleMem candidate verification', () => {\n  beforeEach(() => {\n    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));\n    run.mockResolvedValue({ stdout: '', stderr: '' });\n    uploadFile.mockResolvedValue(undefined);\n    remove.mockResolvedValue(undefined);\n  });\n  afterEach(() => vi.unstubAllGlobals());\n\n  it('keeps only moments the normal footage watcher confirms', async () => {\n    searchVideoChunk\n      .mockResolvedValueOnce({ matches: [], warnings: [], rawResponse: '{\"matches\":[]}', provider: 'openrouter', model: 'qwen', promptVersion: 'p1' })\n      .mockResolvedValueOnce({ matches: [{ startSeconds: 0.5, endSeconds: 3, confidence: 0.95, description: 'confirmed' }], warnings: [], rawResponse: '{}', provider: 'openrouter', model: 'qwen', promptVersion: 'p1' });\n    const result = await rerankSimpleMemCandidates({\n      query: 'find the right sign', candidates, videoUrl: 'https://signed/video', videoKey: 'proxy', expectedBytes: 123,\n    });\n    expect(result.candidates).toEqual([{ ...candidates[1], score: 0.95, description: 'confirmed' }]);\n    expect(result.failed[0]?.description).toBe('first');\n    expect(result.result.metrics.verifier).toBe('clipit-actual-footage');\n    expect(searchVideoChunk).toHaveBeenCalledTimes(2);\n  });\n});\n`);

// Retire implementation files, workers, experiments, and tests. Historical DB
// migrations stay immutable; old rows may exist, but no current code can read,
// write, queue, or invoke the retired system.
const retired = [
  'src/services/media/ytdlp.ts',
  'src/services/mediaIndex/cost.ts',
  'src/services/mediaIndex/coverage.ts',
  'src/services/mediaIndex/qwen.ts',
  'src/services/mediaIndex/search.ts',
  'src/services/mediaIndex/sourceIdentity.ts',
  'src/services/mediaIndex/vectors.ts',
  'src/services/mediaIndex/windows.ts',
  'src/db/repositories/mediaIndex.ts',
  'src/worker/handlers/mediaIndexing.ts',
  'src/worker/mediaIndexReadiness.ts',
  'src/scripts/mediaIndexExperiment.ts',
  'modal/clipit_embedding.py',
  'modal/clipit_reranker.py',
  'modal/probes.example.json',
  'test/mediaIndexCoverage.test.ts',
  'test/mediaIndexInsert.test.ts',
  'test/mediaIndexProbes.test.ts',
  'test/mediaIndexQwen.test.ts',
  'test/mediaIndexReadiness.test.ts',
  'test/mediaIndexRunFence.integration.test.ts',
  'test/mediaIndexSearch.test.ts',
  'test/mediaIndexStaleThreshold.test.ts',
  'test/mediaIndexVectors.test.ts',
  'test/mediaIndexWindows.test.ts',
  'test/mediaIndexingFailureReport.test.ts',
  'test/youtubeIngestionDisabled.test.ts',
  'test/ytdlp.test.ts',
];
for (const path of retired) await rm(at(path), { force: true });

console.log('SimpleMem migration cleanup applied.');
