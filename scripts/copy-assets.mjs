// Copies non-TypeScript runtime assets (SQL migrations) into dist/ after tsc.
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'src', 'db', 'migrations');
const to = path.join(root, 'dist', 'db', 'migrations');

await mkdir(path.dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied migrations -> ${path.relative(root, to)}`);
