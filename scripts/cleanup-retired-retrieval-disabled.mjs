import { readFile, writeFile, unlink } from 'node:fs/promises';
const path = 'src/domain/types.ts';
const before = await readFile(path, 'utf8');
const after = before.replace(/  \| 'primary_failed'\s*\n;/, "  | 'primary_failed'\n  | 'disabled';");
if (after === before && !before.includes("| 'disabled'")) throw new Error('Could not restore SimpleMem disabled fallback reason');
if (after !== before) await writeFile(path, after);
await unlink('scripts/cleanup-retired-retrieval-disabled.mjs');
