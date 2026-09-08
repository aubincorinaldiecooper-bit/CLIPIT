import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * The run fence, against a real PostgreSQL.
 *
 * GATED, and honestly so: without a reachable database these SKIP rather than
 * pass. A skipped test that reads as green is the thing this file exists to
 * catch, because the bug it covers survived a fully-mocked suite of 949 tests.
 *
 * WHAT IT COVERS
 *
 * A run's identity is the moment it opened. beginIndexRun writes now() and
 * returns it; storing windows, writing a status and the liveness heartbeat all
 * re-present that value and require an exact match, so a superseded worker
 * cannot overwrite a newer run's work.
 *
 * PostgreSQL keeps microseconds. A JavaScript Date keeps milliseconds. The
 * round trip through node-postgres therefore threw away the microseconds and
 * the fence compared two values that were never equal — measured at 0 matches
 * in 20 runs before migration 050. Every window rejected, every status write
 * refused, every heartbeat lost, at full GPU price, for ever.
 *
 * No mock can see this: it lives entirely in what the database and the driver
 * do to a value in transit. Hence a real connection, and hence this file.
 */

const CONNECTION = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function reachable(): Promise<boolean> {
  if (!CONNECTION) return false;
  const probe = new pg.Client({ connectionString: CONNECTION, connectionTimeoutMillis: 2_000 });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await reachable();
let client: pg.Client;

const suite = describe.skipIf(!dbAvailable);

beforeAll(async () => {
  if (!dbAvailable) return;
  client = new pg.Client({ connectionString: CONNECTION });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS media_index_fence_probe');
  // The shape migration 050 leaves behind.
  await client.query(`
    CREATE TABLE media_index_fence_probe (
      video_id   TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ(3) NOT NULL
    )`);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.query('DROP TABLE IF EXISTS media_index_fence_probe');
  await client.end();
});

suite('a run can recognise its own identity', () => {
  /** What beginIndexRun does: write now(), hand the value back. */
  async function openRun(videoId: string): Promise<Date> {
    const opened = await client.query<{ started_at: Date }>(
      `INSERT INTO media_index_fence_probe (video_id, started_at)
       VALUES ($1, now())
       ON CONFLICT (video_id) DO UPDATE SET started_at = now()
       RETURNING started_at`,
      [videoId],
    );
    return opened.rows[0].started_at;
  }

  /** What storeIndexedWindows, setMediaIndexStatus and touchMediaIndexRun do. */
  async function fencePasses(videoId: string, runStartedAt: Date): Promise<boolean> {
    const found = await client.query(
      'SELECT 1 FROM media_index_fence_probe WHERE video_id = $1 AND started_at = $2',
      [videoId, runStartedAt],
    );
    return (found.rowCount ?? 0) > 0;
  }

  it('matches the value it was just handed, every time', async () => {
    // Twenty-five runs, because the failure was probabilistic in principle and
    // total in practice: a match needed now() to land on an exact millisecond.
    for (let i = 0; i < 25; i += 1) {
      const runStartedAt = await openRun(`video-${i}`);
      expect(await fencePasses(`video-${i}`, runStartedAt)).toBe(true);
    }
  });

  it('stores nothing finer than a millisecond, whatever the caller writes', async () => {
    // The point of putting the precision on the column instead of rounding at
    // the call site: a later `now()` written by anyone cannot reintroduce the
    // microseconds that broke this.
    await openRun('video-precision');
    const stored = await client.query<{ text: string }>(
      'SELECT started_at::text AS text FROM media_index_fence_probe WHERE video_id = $1',
      ['video-precision'],
    );
    const fraction = stored.rows[0].text.split('.')[1] ?? '';
    // e.g. "248+00" — at most three digits before the timezone.
    expect(fraction.replace(/\+.*$/, '').length).toBeLessThanOrEqual(3);
  });

  it('still refuses a run that has been superseded', async () => {
    // The fence must keep doing its actual job. An older worker holding the
    // previous identity writes nothing once a newer run has opened.
    const first = await openRun('video-superseded');
    const second = await openRun('video-superseded');

    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
    expect(await fencePasses('video-superseded', second)).toBe(true);
    if (second.getTime() !== first.getTime()) {
      expect(await fencePasses('video-superseded', first)).toBe(false);
    }
  });
});
