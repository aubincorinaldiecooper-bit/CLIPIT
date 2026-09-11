import { readFile, writeFile, unlink } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change made to ${path}`);
  await writeFile(path, after);
}

await edit('src/domain/types.ts', (s) => s
  .replace("\n/** State of the ingest-time visual understanding (scene index) for a video. */\nexport type IndexStatus = 'pending' | 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';\n", '')
  .replace(/\/\*\*[\s\S]*?Whether a question was answered from the notes taken at upload,[\s\S]*?export type AnsweredFrom = 'notes' \| 'footage' \| 'media_index' \| 'simplemem';/, `/** Which evidence path actually produced the verified moments. */\nexport type AnsweredFrom = 'footage' | 'simplemem';`)
  .replace(/\/\*\*[\s\S]*?Which system found the moments: Clipit's own notes-then-footage search,[\s\S]*?export type RetrievalSystem = 'clipit' \| 'simplemem' \| 'media_index';/, `/** Which retrieval system produced the moments. */\nexport type RetrievalSystem = 'clipit' | 'simplemem';`)
  .replace(/\n  \/\/ The Media Index's own reasons\.[\s\S]*?\| 'index_footage_replaced';/, ';')
  .replace(/\n  indexStatus: IndexStatus;[\s\S]*?\n  sceneCount: number;/, '')
  .replace(/\n\/\*\*[\s\S]*?One entry in a video's scene index:[\s\S]*?\n}\n\nexport interface VideoChunk/, '\nexport interface VideoChunk'));

await edit('src/db/repositories/videos.ts', (s) => s
  .replace("import { coveredSeconds } from './scenes.js';\n", '')
  .replace(/\n  IndexStatus,/, '')
  .replace(/\n  index_status: IndexStatus;\n  index_error: string \| null;\n  scene_count: number;/, '')
  .replace(/\n    indexStatus: row\.index_status,[\s\S]*?\n    sceneCount: row\.scene_count,/, '')
  .replace(/\n\/\*\*[\s\S]*?export async function getVideoWithReadProgress\(videoId: string\): Promise<Video \| null> \{[\s\S]*?\n}\n/, '\n'));

await edit('src/api/serializers.ts', (s) => s
  .replace(/\n    index: \{[\s\S]*?\n    \},\n    createdAt:/, '\n    createdAt:'));

await edit('src/api/routes/videos.ts', (s) => s
  .replace('  getVideoWithReadProgress,\n', '')
  .replace(/\n    \/\/ This route is a pure read\.[\s\S]*?const video = await getVideoWithReadProgress\(videoId\);/, `\n    // Pure status/read endpoint. SimpleMem progress is retrieval state, not\n    // an upload-time notes index, so this route reads the video row directly.\n    const video = await getVideo(videoId);`)
  .replace('the bytes — original, small copy, segments, clips, stills, notes and transcript', 'the bytes — original, small copy, segments, clips, stills and transcript')
  .replace('the preparation, the notes, the transcript', 'the preparation and transcript'));

await edit('src/services/retention.ts', (s) => s
  .replace("import { deleteScenes } from '../db/repositories/scenes.js';\n", '')
  .replace('  // Notes and transcript are derived data. SimpleMem\'s durable archive is\n', '  // Transcript is derived data. SimpleMem\'s durable archive is\n')
  .replace('  await Promise.all([deleteScenes(videoId), deleteTranscript(videoId)]);', '  await deleteTranscript(videoId);'));

await edit('src/db/repositories/clipRequests.ts', (s) => s
  .replace(/\/\*\*[\s\S]*?export async function recordSearchApproach\([\s\S]*?\n}\n\n\/\*\*\n \* Records which system answered,/, `/** Records the request a correction refers to. */\nexport async function recordCorrection(requestId: string, correctionOf: string): Promise<void> {\n  await queryOne(\n    \`UPDATE clip_requests\n        SET corrected_request_id = $2, updated_at = now()\n      WHERE id = $1\`,\n    [requestId, correctionOf],\n  );\n}\n\n/**\n * Records which system answered,`)
  .replace(/\/\*\*[\s\S]*?export interface LearningSummary \{[\s\S]*?\n}\n\nexport async function summariseLearning[\s\S]*?\n}\n\s*$/, `/** Current learning signals, independent of retired retrieval systems. */\nexport interface LearningSummary {\n  answeredFromSimpleMem: number;\n  answeredFromFootage: number;\n  corrections: number;\n  approved: number;\n  rejected: number;\n  averageConfidenceApproved: number | null;\n  averageConfidenceRejected: number | null;\n}\n\nexport async function summariseLearning(sinceHours: number): Promise<LearningSummary> {\n  const interval = \`${'${Math.max(1, Math.floor(sinceHours))}'} hours\`;\n  const requests = await queryOne<{ from_simplemem: number; from_footage: number; corrections: number }>(\n    \`SELECT\n       count(*) FILTER (WHERE answered_from = 'simplemem')::int AS from_simplemem,\n       count(*) FILTER (WHERE answered_from = 'footage')::int AS from_footage,\n       count(*) FILTER (WHERE corrected_request_id IS NOT NULL)::int AS corrections\n     FROM clip_requests\n     WHERE status = 'completed' AND created_at >= now() - $1::interval\`,\n    [interval],\n  );\n  const verdicts = await queryOne<{ approved: number; rejected: number; avg_approved: number | null; avg_rejected: number | null }>(\n    \`SELECT\n       count(*) FILTER (WHERE feedback = 'approved')::int AS approved,\n       count(*) FILTER (WHERE feedback = 'rejected')::int AS rejected,\n       avg(confidence) FILTER (WHERE feedback = 'approved') AS avg_approved,\n       avg(confidence) FILTER (WHERE feedback = 'rejected') AS avg_rejected\n     FROM clip_matches\n     WHERE feedback IS NOT NULL AND feedback_at >= now() - $1::interval\`,\n    [interval],\n  );\n  return {\n    answeredFromSimpleMem: requests?.from_simplemem ?? 0,\n    answeredFromFootage: requests?.from_footage ?? 0,\n    corrections: requests?.corrections ?? 0,\n    approved: verdicts?.approved ?? 0,\n    rejected: verdicts?.rejected ?? 0,\n    averageConfidenceApproved: verdicts?.avg_approved == null ? null : Number(Number(verdicts.avg_approved).toFixed(3)),\n    averageConfidenceRejected: verdicts?.avg_rejected == null ? null : Number(Number(verdicts.avg_rejected).toFixed(3)),\n  };\n}\n`));

await edit('src/worker/handlers/clipSearch.ts', (s) => s
  .replace('  recordSearchApproach,\n', '  recordCorrection,\n')
  .replace('      await recordSearchApproach(clipRequestId, { notesConsulted: false, correctionOf: previous.id });', '      await recordCorrection(clipRequestId, previous.id);')
  .replace(/\n    \/\*\*[\s\S]*?Memory before a full footage read\.[\s\S]*?\n    \/\*\*\n     \* Omni-SimpleMem is the memory\/retrieval layer\./, `\n    /**\n     * Omni-SimpleMem is the memory/retrieval layer.`));

await edit('src/worker/handlers/learningReport.ts', (s) => s
  .replace("      // 'notes' means recalled; 'footage' means the video was re-read.\n", '')
  .replace('  const answered = summary.answeredFromNotes + summary.answeredFromFootage;', '  const answered = summary.answeredFromSimpleMem + summary.answeredFromFootage;')
  .replace('    // Is reading at upload paying off? This is the number that says so.\n    answeredFromMemory: summary.answeredFromNotes,', '    answeredFromMemory: summary.answeredFromSimpleMem,')
  .replace('    memoryShare: answered > 0 ? Number((summary.answeredFromNotes / answered).toFixed(2)) : null,\n    // The notes were read and had nothing. Distinct from a video with no notes.\n    notesSilent: summary.notesSilent,', '    memoryShare: answered > 0 ? Number((summary.answeredFromSimpleMem / answered).toFixed(2)) : null,')
  .replace(/\n  \/\/ The part worth actually reading:[\s\S]*?\n  }\n}\n$/, '\n}\n'));

await edit('src/db/repositories/performance.ts', (s) => s
  .replace("  /** 'notes' — recalled from what was written at upload. 'footage' — re-read. */\n", '')
  .replace(/\n  \/\*\*[\s\S]*?Reading a video at upload\.[\s\S]*?const reads = await queryOne<[\s\S]*?\n  \);/, `\n  /** SimpleMem indexing wall clock and model cost for current video memory. */\n  const reads = await queryOne<{\n    reads: number;\n    median_seconds: string | null;\n    p95_seconds: string | null;\n    median_cost: string | null;\n    total_cost: string | null;\n    median_ratio: string | null;\n  }>(\n    \`WITH per_video AS (\n       SELECT s.video_id AS id,\n              s.index_ms / 1000.0 AS seconds,\n              v.duration_seconds,\n              COALESCE(SUM(u.cost_usd), 0) AS cost\n         FROM simplemem_index s\n         JOIN videos v ON v.id = s.video_id\n         LEFT JOIN model_usage u ON u.video_id = s.video_id AND u.stage = 'indexing'\n        WHERE s.index_ms IS NOT NULL\n          AND s.updated_at >= now() - $1::interval\n        GROUP BY s.video_id, s.index_ms, v.duration_seconds\n     )\n     SELECT count(*)::int AS reads,\n            percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds,\n            percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds) AS p95_seconds,\n            percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS median_cost,\n            SUM(cost) AS total_cost,\n            percentile_cont(0.5) WITHIN GROUP (\n              ORDER BY CASE WHEN seconds > 0 THEN duration_seconds / seconds END\n            ) AS median_ratio\n       FROM per_video\`,\n    [interval],\n  );`));

await edit('src/db/repositories/usage.ts', (s) => s
  .replace(/\n  \/\/ The Media Index's two halves,[\s\S]*?\n  \| 'rerank'/, '')
  .replace("const INGESTION_STAGES: UsageStage[] = ['transcription', 'indexing', 'embedding'];", "const INGESTION_STAGES: UsageStage[] = ['transcription', 'indexing'];")
  .replace(/\/\/ What it costs to make one video searchable\.[\s\S]*?\/\/ 'rerank' is deliberately absent: it runs per question, not per video\.\n/, ''));

await unlink('src/db/repositories/scenes.ts');

await writeFile('src/db/migrations/054_retire_legacy_retrieval.sql', `-- Retire storage that belonged only to the removed notes and Media Index systems.\n-- Historical migration files remain frozen; this forward migration removes their live schema.\n\nDROP TABLE IF EXISTS video_scenes;\nDROP TABLE IF EXISTS media_index_status;\nDROP TABLE IF EXISTS media_index;\n\nALTER TABLE videos\n  DROP COLUMN IF EXISTS index_status,\n  DROP COLUMN IF EXISTS index_error,\n  DROP COLUMN IF EXISTS scene_count,\n  DROP COLUMN IF EXISTS index_ms;\n\nALTER TABLE clip_requests\n  DROP COLUMN IF EXISTS notes_consulted;\n\n-- Preserve old rows without pretending they came from the current system.\nUPDATE clip_requests SET answered_from = NULL WHERE answered_from IN ('notes', 'media_index');\nUPDATE clip_requests SET retrieval_primary = NULL WHERE retrieval_primary = 'media_index';\nUPDATE clip_requests SET retrieval_system = NULL WHERE retrieval_system = 'media_index';\n\nALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_answered_from_check;\nALTER TABLE clip_requests\n  ADD CONSTRAINT clip_requests_answered_from_check\n  CHECK (answered_from IS NULL OR answered_from IN ('footage', 'simplemem'));\n\nALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_primary_check;\nALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_system_check;\nALTER TABLE clip_requests\n  ADD CONSTRAINT clip_requests_retrieval_primary_check\n  CHECK (retrieval_primary IS NULL OR retrieval_primary IN ('clipit', 'simplemem'));\nALTER TABLE clip_requests\n  ADD CONSTRAINT clip_requests_retrieval_system_check\n  CHECK (retrieval_system IS NULL OR retrieval_system IN ('clipit', 'simplemem'));\n`);
