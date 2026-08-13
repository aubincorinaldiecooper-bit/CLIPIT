import pg from 'pg';
import { env } from '../config/env.js';

const { Pool, types } = pg;

// `numeric` (OID 1700) arrives as a string by default; every numeric column in
// this schema holds a second offset that we always want as a JS number.
types.setTypeParser(1700, (value: string) => Number(value));
// `int8` (OID 20) is only used for counters here, all far below 2^53.
types.setTypeParser(20, (value: string) => Number(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (error) => {
  // Idle client errors must not take the process down.
  console.error(JSON.stringify({ level: 'error', msg: 'postgres idle client error', err: error.message }));
});

export type QueryParam = unknown;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never[]);
}

export async function queryRows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: QueryParam[] = [],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
