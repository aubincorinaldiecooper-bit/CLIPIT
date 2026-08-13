import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `.sql` files live next to the compiled output after `npm run build`
 * (see scripts/copy-assets.mjs); when running from source via tsx they are
 * already in place.
 */
function migrationsDir(): string {
  const candidates = [path.join(here, 'migrations'), path.join(process.cwd(), 'src', 'db', 'migrations')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Could not locate migrations directory (looked in: ${candidates.join(', ')})`);
  return found;
}

/**
 * Arbitrary constant identifying this application's migration lock. Any
 * process holding it is the only one allowed to inspect and apply migrations.
 */
const MIGRATION_LOCK_ID = 8_143_027;

export async function runMigrations(): Promise<void> {
  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    // The API and the worker both migrate on boot and start concurrently on
    // Railway. Without this lock both can read the same migration as
    // unapplied, both apply it, and the loser hits a duplicate key on
    // schema_migrations and exits during startup. The lock is taken before the
    // applied set is read so the waiter sees a fresh view.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (row) => [row.name, row.checksum],
      ),
    );

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }

      logger.info('applying migration', { migration: file });
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }

    logger.info('migrations up to date', { count: files.length });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
