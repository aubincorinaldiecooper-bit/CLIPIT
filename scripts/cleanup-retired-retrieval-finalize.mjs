import { readFile, writeFile, unlink } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after !== before) await writeFile(path, after);
}

await edit('src/domain/types.ts', (s) => s
  .replace("  | 'primary_failed';", "  | 'primary_failed'\n  | 'disabled';")
  .replace("  | 'primary_failed'\n  ;", "  | 'primary_failed'\n  | 'disabled';"));

await edit('src/db/repositories/videos.ts', (s) => s.replace(/\nexport async function setIndexStatus\([\s\S]*?\n}\n\ninterface ChunkRow/, '\ninterface ChunkRow'));

await edit('src/api/serializers.ts', (s) => s.replace(
/            request\.answeredFrom === 'notes'[\s\S]*?: request\.chunksFailed > 0/,
"            request.answeredFrom === 'simplemem'\n              ? 'Answered from Omni-SimpleMem video memory'\n              : request.chunksFailed > 0"));

await edit('src/worker/handlers/clipSearch.ts', (s) => s
  .replace("  // lost if this process stops. Notes and footage are both Clipit's own\n  // search; only the external retrieval systems are the other thing.\n", "  // lost if this process stops. SimpleMem is the memory path; direct footage\n  // search is Clipit's grounding fallback.\n")
  .replace(/        input\.answeredFrom === 'media_index'[\s\S]*?            : 'clipit',/, "        input.answeredFrom === 'simplemem' ? 'simplemem' : 'clipit',"));

await edit('src/services/reports/platformReports.ts', (s) => s
  .replace(/\n    indexStatus: string \| null;/g, '')
  .replace(/\n          indexStatus: input\.video\.indexStatus,/g, '')
  .replace("      `- Notes: ${v.indexStatus ?? '?'} · Transcript: ${v.transcriptStatus ?? '?'}`, '');", "      `- Transcript: ${v.transcriptStatus ?? '?'}`, '');"));

await edit('src/db/migrations/054_retire_legacy_retrieval.sql', (s) => s.replace(
"  DROP COLUMN IF EXISTS scene_count,\n  DROP COLUMN IF EXISTS index_ms;",
"  DROP COLUMN IF EXISTS scene_count,\n  DROP COLUMN IF EXISTS index_ms,\n  DROP COLUMN IF EXISTS analysis_config;"));

await Promise.all([
  unlink('scripts/cleanup-retired-retrieval-followup.mjs').catch(() => undefined),
  unlink('scripts/cleanup-retired-retrieval-finalize.mjs').catch(() => undefined),
]);
