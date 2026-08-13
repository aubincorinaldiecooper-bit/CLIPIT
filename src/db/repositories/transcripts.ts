import { queryOne, queryRows } from '../pool.js';
import type { TranscriptSegment, TranscriptSource } from '../../domain/types.js';

interface SegmentRow {
  id: string;
  video_id: string;
  segment_index: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
  source: TranscriptSource;
}

function mapSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    videoId: row.video_id,
    segmentIndex: row.segment_index,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    text: row.text,
    source: row.source,
  };
}

export interface NewTranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/** Replaces the whole transcript for a video; inserted in batches to stay under the parameter limit. */
export async function replaceTranscript(
  videoId: string,
  segments: NewTranscriptSegment[],
  source: TranscriptSource,
): Promise<number> {
  await queryOne('DELETE FROM transcript_segments WHERE video_id = $1', [videoId]);
  if (segments.length === 0) return 0;

  const batchSize = 500;
  let inserted = 0;

  for (let offset = 0; offset < segments.length; offset += batchSize) {
    const batch = segments.slice(offset, offset + batchSize);
    const values: string[] = [];
    const params: unknown[] = [videoId, source];

    batch.forEach((segment, index) => {
      const base = params.length;
      params.push(offset + index, segment.startSeconds, segment.endSeconds, segment.text);
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $2)`);
    });

    await queryOne(
      `INSERT INTO transcript_segments (video_id, segment_index, start_seconds, end_seconds, text, source)
       VALUES ${values.join(', ')}`,
      params,
    );
    inserted += batch.length;
  }

  return inserted;
}

/** Segments overlapping [startSeconds, endSeconds). Timestamps are already global. */
export async function listTranscriptSegmentsInRange(
  videoId: string,
  startSeconds: number,
  endSeconds: number,
): Promise<TranscriptSegment[]> {
  const rows = await queryRows<SegmentRow>(
    `SELECT * FROM transcript_segments
      WHERE video_id = $1 AND end_seconds > $2 AND start_seconds < $3
      ORDER BY start_seconds ASC`,
    [videoId, startSeconds, endSeconds],
  );
  return rows.map(mapSegment);
}

export async function countTranscriptSegments(videoId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM transcript_segments WHERE video_id = $1',
    [videoId],
  );
  return row?.count ?? 0;
}
