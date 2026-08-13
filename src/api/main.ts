import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { closeRedis } from '../queues/connection.js';
import { closeQueues } from '../queues/index.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  // Migrations run on boot so a fresh Railway deploy is usable immediately.
  await runMigrations();

  const app = await buildServer();
  await app.listen({ port: env.PORT, host: env.HOST });

  logger.info('api listening', { port: env.PORT, host: env.HOST, nodeEnv: env.NODE_ENV });

  const shutdown = async (signal: string) => {
    logger.info('api shutting down', { signal });
    try {
      await app.close();
      await closeQueues();
      await closeRedis();
      await closePool();
    } catch (error) {
      logger.error('error during shutdown', { err: error });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error('api failed to start', { err: error });
  process.exit(1);
});
