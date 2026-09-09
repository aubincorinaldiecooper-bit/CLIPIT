import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
 * Every write a run makes proves it is still the current run by presenting its
 * identity back — storing windows, writing a status, and the heartbeat. The
 * identity used to be `started_at`, the moment the run opened, and that failed
 * twice over.
 *
 * It could never match: PostgreSQL keeps microseconds, a JavaScript Date keeps
 * milliseconds, and node-postgres hands one back. Measured here before the fix
 * at 0 matches in 20 runs — every window rejected, every status write refused,
 * every heartbeat lost, at full GPU price.
 *
 * And rounding it to survive that trip would have made two runs beginning in
 * the same millisecond share one identity, letting the older overwrite the
 * newer. now() is transaction_timestamp, taken when the transaction BEGINS.
 *
 * So the identity is a minted uuid. These prove it round-trips, and that two
 * runs opened back to back never collide however close together they are.
 *
 * No mock can see any of this: it lives in what the database and the driver do
 * to a value in transit.
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
      run_id     UUID,
      started_at TIMESTAMPTZ(3) NOT NULL
    )`);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.query('DROP TABLE IF EXISTS media_index_fence_probe');
  await client.end();
});

/** What beginIndexRun does: mint an id, write it, hand it back. */
async function openRun(videoId: string): Promise<string> {
  const runId = randomUUID();
  const opened = await client.query<{ run_id: string }>(
    `INSERT INTO media_index_fence_probe (video_id, run_id, started_at)
     VALUES ($1, $2, now())
     ON CONFLICT (video_id) DO UPDATE SET run_id = $2, started_at = now()
     RETURNING run_id`,
    [videoId, runId],
  );
  return opened.rows[0].run_id;
}

/** What storeIndexedWindows, setMediaIndexStatus and touchMediaIndexRun do. */
async function fencePasses(videoId: string, runId: string): Promise<boolean> {
  const found = await client.query(
    'SELECT 1 FROM media_index_fence_probe WHERE video_id = $1 AND run_id = $2',
    [videoId, runId],
  );
  return (found.rowCount ?? 0) > 0;
}

suite('a run can recognise its own identity', () => {
  it('matches the value it was just handed, every time', async () => {
    // Twenty-five runs. With a timestamp identity this needed now() to land on
    // an exact millisecond and measured 0 in 20; an id has nothing to round.
    for (let i = 0; i < 25; i += 1) {
      const runId = await openRun(`video-${i}`);
      expect(await fencePasses(`video-${i}`, runId)).toBe(true);
    }
  });

  it('refuses a run that has been superseded', async () => {
    // The fence still doing its actual job: an older worker holding the
    // previous identity writes nothing once a newer run has opened.
    const first = await openRun('video-superseded');
    const second = await openRun('video-superseded');

    expect(second).not.toBe(first);
    expect(await fencePasses('video-superseded', second)).toBe(true);
    expect(await fencePasses('video-superseded', first)).toBe(false);
  });

  it('gives two runs opened in the same millisecond different identities', async () => {
    // The reason a rounded timestamp was not good enough. now() is taken when
    // the transaction BEGINS, so two deliveries of one video that start inside
    // the same millisecond would have shared an identity — and the older would
    // then have passed every fence belonging to the newer, overwriting its
    // windows and its coverage with nothing to detect it.
    const ids: string[] = [];
    const stamps: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      ids.push(await openRun('video-rapid'));
      stamps.push(
        (await client.query<{ text: string }>(
          "SELECT to_char(started_at, 'YYYY-MM-DD HH24:MI:SS.MS') AS text FROM media_index_fence_probe WHERE video_id = 'video-rapid'",
        )).rows[0].text,
      );
    }

    // Every identity distinct, whatever the clock did.
    expect(new Set(ids).size).toBe(ids.length);

    // And this is not a vacuous check: the timestamps DID repeat, so a
    // millisecond identity really would have collided here.
    expect(new Set(stamps).size).toBeLessThan(stamps.length);

    // Only the newest passes.
    const newest = ids[ids.length - 1];
    expect(await fencePasses('video-rapid', newest)).toBe(true);
    for (const stale of ids.slice(0, -1)) {
      expect(await fencePasses('video-rapid', stale)).toBe(false);
    }
  });

  it('a fenced write never resurrects a row retention removed', async () => {
    // The fence reads as ownership — write this only if the row is still mine
    // — and an upsert cannot say that. PostgreSQL applies the ON CONFLICT
    // condition to the UPDATE branch only, so with no row present it takes the
    // INSERT path and the fence passes unconditionally.
    //
    // Rows go missing on purpose: retention deletes both media index tables
    // when it claims a video's footage. An indexing job still in flight would
    // then re-create a status row describing footage that no longer exists.
    await openRun('video-retained');
    const runId = await openRun('video-retained');

    // Retention claims the footage.
    await client.query("DELETE FROM media_index_fence_probe WHERE video_id = 'video-retained'");

    // The in-flight run writes its next status. An UPDATE touches nothing.
    const written = await client.query(
      `UPDATE media_index_fence_probe SET started_at = now()
        WHERE video_id = $1 AND run_id = $2`,
      ['video-retained', runId],
    );
    expect(written.rowCount).toBe(0);

    // And the row stays gone, rather than being quietly recreated.
    const after = await client.query(
      'SELECT 1 FROM media_index_fence_probe WHERE video_id = $1',
      ['video-retained'],
    );
    expect(after.rowCount).toBe(0);

    // The shape that used to run in its place puts the row back — this is the
    // bug, demonstrated rather than described.
    await client.query(
      `INSERT INTO media_index_fence_probe (video_id, run_id, started_at)
       VALUES ($1, $2, now())
       ON CONFLICT (video_id) DO UPDATE SET started_at = now()
       WHERE media_index_fence_probe.run_id = $2`,
      ['video-retained', runId],
    );
    const resurrected = await client.query(
      'SELECT 1 FROM media_index_fence_probe WHERE video_id = $1',
      ['video-retained'],
    );
    expect(resurrected.rowCount).toBe(1);

    await client.query("DELETE FROM media_index_fence_probe WHERE video_id = 'video-retained'");
  });

  it('queueing a replacement revokes the run that was in flight', async () => {
    // Re-processing replaces the footage at the same key. Preprocessing writes
    // `queued` for the new attempt, and until this the old run's id stayed on
    // the row — so a handler still working on the REPLACED footage passed
    // every fence and could store its windows and its coverage over the top,
    // describing a video that no longer exists.
    //
    // Nulling run_id on the queued transition revokes the old run atomically
    // with the queueing, before the replacement opens one of its own.
    const inFlight = await openRun('video-replaced');
    expect(await fencePasses('video-replaced', inFlight)).toBe(true);

    // What preprocessing does when the footage is replaced.
    await client.query(
      "UPDATE media_index_fence_probe SET run_id = NULL WHERE video_id = 'video-replaced'",
    );

    // The old handler writes on. Nothing of its lands.
    expect(await fencePasses('video-replaced', inFlight)).toBe(false);

    // And a null id is not a wildcard: it must not match anything either.
    const wildcard = await client.query(
      'SELECT 1 FROM media_index_fence_probe WHERE video_id = $1 AND run_id IS NOT NULL AND run_id = $2',
      ['video-replaced', inFlight],
    );
    expect(wildcard.rowCount).toBe(0);

    // The replacement opens its own run and owns the row from there.
    const replacement = await openRun('video-replaced');
    expect(replacement).not.toBe(inFlight);
    expect(await fencePasses('video-replaced', replacement)).toBe(true);
  });

  it('keeps started_at round-trippable, since it is still read into a Date', async () => {
    // No longer the identity, but still handed to JavaScript for reporting. A
    // stored value that cannot survive that trip is a trap either way.
    await openRun('video-precision');
    const stored = await client.query<{ text: string }>(
      'SELECT started_at::text AS text FROM media_index_fence_probe WHERE video_id = $1',
      ['video-precision'],
    );
    const fraction = (stored.rows[0].text.split('.')[1] ?? '').replace(/\+.*$/, '');
    expect(fraction.length).toBeLessThanOrEqual(3);
  });
});
