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

/** Replaces the whole scene index for a video; batched like the transcript. */
export async function replaceScenes(videoId: string, scenes: NewVideoScene[]): Promise<number> {
  await queryOne('DELETE FROM video_scenes WHERE video_id = $1', [videoId]);
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
      params.push(offset + index, scene.startSeconds, scene.endSeconds, scene.description);
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
