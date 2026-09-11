import { readFile, writeFile, unlink } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No test change made to ${path}`);
  await writeFile(path, after);
}

await edit('test/footageExpiry.test.ts', (s) => s
  .replace('  deleteScenes: vi.fn(),\n', '')
  .replace("vi.mock('../src/db/repositories/scenes.js', () => ({ deleteScenes: (...args: unknown[]) => clears.deleteScenes(...args) }));\n", '')
  .replace("    // Everything derived from the footage goes with it: the notes, the\n    // transcript and a SimpleMem memory that is frames of the\n", "    // Everything still derived from the footage goes with it: the transcript\n    // and a SimpleMem memory that is frames of the\n")
  .replace("    expect(clears.deleteScenes).toHaveBeenCalledWith('v1');\n", ''));

await edit('test/platformReports.test.ts', (s) => s
  .replace(", indexStatus: 'ready'", '')
  .replace(", answeredFrom: 'notes'", ", answeredFrom: 'simplemem'")
  .replace(", indexStatus: 'ready', transcriptStatus: 'ready'", ", transcriptStatus: 'ready'"));

await unlink('scripts/cleanup-retired-retrieval-tests.mjs');
