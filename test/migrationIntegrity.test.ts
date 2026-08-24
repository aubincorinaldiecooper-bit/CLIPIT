import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

/**
 * A migration that has run cannot be edited.
 *
 * The runner records a checksum per file and REFUSES TO START when an
 * applied migration's content changes (src/db/migrate.ts). That is the right
 * behaviour — silently diverging schemas are worse — but it means editing a
 * migration already on main does not add a column: it takes the service down
 * at boot, on every instance, until someone notices.
 *
 * This nearly shipped. A column was appended to a migration that had already
 * deployed minutes earlier; the next deploy would have crash-looped. So the
 * rule is enforced here rather than remembered: anything already on main is
 * frozen, and a change to the schema is a NEW file.
 */
describe('migrations already on main are frozen', () => {
  it('never edits a migration that main already carries', async () => {
    let merged: string[];
    try {
      const { stdout } = await run('git', ['ls-tree', '--name-only', 'origin/main', 'src/db/migrations/']);
      merged = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.endsWith('.sql'));
    } catch {
      // No git, no origin/main (a shallow CI clone, a fresh worktree): the
      // check cannot run, and saying so beats a false pass.
      console.warn('migration freeze check skipped: origin/main is not readable here');
      return;
    }
    expect(merged.length).toBeGreaterThan(0);

    const modified: string[] = [];
    for (const file of merged) {
      const { stdout: onMain } = await run('git', ['show', `origin/main:${file}`], { maxBuffer: 10_000_000 });
      const here = await readFile(path.join(process.cwd(), file), 'utf8');
      if (onMain !== here) modified.push(path.basename(file));
    }

    expect(
      modified,
      `These migrations are already applied in production and must not change — ` +
        `the runner checksums them and refuses to boot on a mismatch. Put the change in a NEW migration: ${modified.join(', ')}`,
    ).toEqual([]);
  }, 60_000);

  it('numbers every migration uniquely and in order', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
    const numbers = files.map((file) => Number(file.slice(0, 3)));

    expect(numbers.every((value) => Number.isInteger(value))).toBe(true);
    // Duplicates would apply in an order that depends on the rest of the
    // filename — a schema that differs between two databases built from the
    // same repository.
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const [index, value] of numbers.entries()) {
      if (index > 0) expect(value).toBeGreaterThan(numbers[index - 1]!);
    }
  });
});
