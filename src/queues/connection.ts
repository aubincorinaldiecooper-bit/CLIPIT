import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

function create(label: string): Redis {
  const connection = new Redis(env.REDIS_URL, {
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  connection.on('error', (error: Error) => logger.error('redis connection error', { label, err: error.message }));
  return connection;
}

let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;
let genericConnection: Redis | null = null;

/** Shared by all producers (the API). */
export function getQueueConnection(): Redis {
  if (!queueConnection) queueConnection = create('queues');
  return queueConnection;
}

/** Shared by all BullMQ workers. */
export function getWorkerConnection(): Redis {
  if (!workerConnection) workerConnection = create('workers');
  return workerConnection;
}

/** Non-BullMQ usage (rate limiting, health checks). */
export function getRedis(): Redis {
  if (!genericConnection) genericConnection = create('generic');
  return genericConnection;
}

export async function closeRedis(): Promise<void> {
  await Promise.all(
    [queueConnection, workerConnection, genericConnection].map(async (connection) => {
      if (!connection) return;
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
    }),
  );
  queueConnection = null;
  workerConnection = null;
  genericConnection = null;
}
