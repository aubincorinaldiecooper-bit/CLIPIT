import { runMigrations } from './migrate.js';
import { closePool } from './pool.js';
import { logger } from '../lib/logger.js';

runMigrations()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (error) => {
    logger.error('migration failed', { err: error });
    await closePool().catch(() => undefined);
    process.exit(1);
  });
