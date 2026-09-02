import { queryOne, queryRows } from '../pool.js';
import { mergeOverlappingRanges } from '../../services/timestamps.js';
import type { VideoScene } from '../../domain/types.js';

interface SceneRow {
  id: string;
  video_id: string;
  scene_index: number;
  start_seconds: number;
  end_seconds: number;
  description: string;
}

function mapScene(row: SceneRow): VideoScene {
  return {
    id: row.id,
    videoId: row.video_id,
    sceneIndex: row.scene_index,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    description: row.description,
  };
}

export interface NewVideoScene {
  startSeconds: number;
  endSeconds: number;
  description: string;
}

/**
 * Adds notes for one chunk, as soon as that chunk has been read.
 *
 * Written per chunk rather than all at the end so the notes are usable while
 * the rest of the video is still being read. A question asked a minute after
 * upload can be answered from the part that has been read, with the unread
 * part named — which is far better than two minutes of nothing.
 *
 * `sceneIndexOffset` keeps the stored order stable while chunks finish out of
 * order, which they do: they run four at a time and the short ones land first.
 */
export async function appendScenes(
  videoId: string,
  scenes: NewVideoScene[],
  sceneIndexOffset: number,
): Promise<number> {
  if (scenes.length === 0) return 0;
  return insertScenes(videoId, scenes, sceneIndexOffset);
}

/** Clears a video's notes. Used at the start of a read, so a retry is clean. */
export async function clearScenes(videoId: string): Promise<void> {
  await queryOne('DELETE FROM video_scenes WHERE video_id = $1', [videoId]);
}

/**
 * How much of the video the notes describe: the seconds their scenes cover,
 * overlaps merged. Real, measured, and it moves — a screen can say "read 8
 * of 20 minutes" from this without anybody inventing a percentage.
 *
 * NOT the furthest second any note reaches, which this once was. Parts are
 * read several at a time and finish out of order, so the furthest reached
 * said the whole video was read while a middle stretch was not: on
 * 2026-09-02 a 685-second video read "through 685 s" with 361–601 s still
 * unread, and the answer said "I'm only 11 minutes in" of an 11-minute
 * video. Overlaps merged with a second's tolerance, as the coverage gaps
 * are.
 */
export async function coveredSeconds(videoId: string): Promise<number> {
  return coverageOf(await sceneRanges(videoId));
}

/**
 * The notes so far: how many, and how much of the video they describe (see
 * coveredSeconds). Both from ONE read of the rows: while a read is still
 * appending notes, two reads can see two moments — a count of none beside
 * coverage of something — and the search branches on the count (Codex's
 * finding on #86).
 */
export async function sceneProgress(videoId: string): Promise<{ count: number; readThroughSeconds: number }> {
  const ranges = await sceneRanges(videoId);
  return { count: ranges.length, readThroughSeconds: coverageOf(ranges) };
}

async function sceneRanges(videoId: string): Promise<Array<{ startSeconds: number; endSeconds: number }>> {
  const rows = await queryRows<{ start_seconds: number; end_seconds: number }>(
    'SELECT start_seconds, end_seconds FROM video_scenes WHERE video_id = $1',
    [videoId],
  );
  return rows.map((row) => ({ startSeconds: Number(row.start_seconds), endSeconds: Number(row.end_seconds) }));
}

function coverageOf(ranges: Array<{ startSeconds: number; endSeconds: number }>): number {
  const merged = mergeOverlappingRanges(ranges, 1);
  return Number(merged.reduce((sum, range) => sum + Math.max(0, range.endSeconds - range.startSeconds), 0).toFixed(3));
}

async function insertScenes(videoId: string, scenes: NewVideoScene[], sceneIndexOffset: number): Promise<number> {
  if (scenes.length === 0) return 0;

  const ordered = [...scenes].sort((a, b) => a.startSeconds - b.startSeconds);

  const batchSize = 500;
  let inserted = 0;

  for (let offset = 0; offset < ordered.length; offset += batchSize) {
    const batch = ordered.slice(offset, offset + batchSize);
    const values: string[] = [];
    const params: unknown[] = [videoId];

    batch.forEach((scene, index) => {
      const base = params.length;
      params.push(sceneIndexOffset + offset + index, scene.startSeconds, scene.endSeconds, scene.description);
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    });

    await queryOne(
      `INSERT INTO video_scenes (video_id, scene_index, start_seconds, end_seconds, description)
       VALUES ${values.join(', ')}`,
      params,
    );
    inserted += batch.length;
  }

  return inserted;
}

/** Drops the notes for a video whose footage is gone. */
export async function deleteScenes(videoId: string): Promise<void> {
  await queryOne('DELETE FROM video_scenes WHERE video_id = $1', [videoId]);
}

export async function listScenes(videoId: string): Promise<VideoScene[]> {
  const rows = await queryRows<SceneRow>(
    'SELECT * FROM video_scenes WHERE video_id = $1 ORDER BY start_seconds ASC, scene_index ASC',
    [videoId],
  );
  return rows.map(mapScene);
}
