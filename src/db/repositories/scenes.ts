import { queryOne, queryRows } from '../pool.js';
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
 * How far into the video the notes actually reach.
 *
 * Real, measured, and it moves — it is the furthest second any note describes.
 * A screen can say "read 8 of 20 minutes" from this without anybody inventing
 * a percentage.
 */
export async function sceneProgress(videoId: string): Promise<{ count: number; readThroughSeconds: number }> {
  const row = await queryOne<{ count: number; read_through: number | null }>(
    'SELECT COUNT(*)::int AS count, MAX(end_seconds) AS read_through FROM video_scenes WHERE video_id = $1',
    [videoId],
  );
  return {
    count: row?.count ?? 0,
    readThroughSeconds: row?.read_through === null || row?.read_through === undefined ? 0 : Number(row.read_through),
  };
}

/** Replaces the whole scene index for a video; batched like the transcript. */
export async function replaceScenes(videoId: string, scenes: NewVideoScene[]): Promise<number> {
  await clearScenes(videoId);
  return insertScenes(videoId, scenes, 0);
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
