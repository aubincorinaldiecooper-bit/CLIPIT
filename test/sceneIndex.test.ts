import { describe, expect, it } from 'vitest';
import { parseModelScenes } from '../src/services/search/sceneIndex.js';

const CHUNK_SECONDS = 120;

describe('reading a video into notes', () => {
  it('keeps scenes with their positions inside the chunk', () => {
    const result = parseModelScenes(
      '{"scenes":[{"start_seconds":0,"end_seconds":14.5,"description":"A red pickup truck pulls into a driveway"},{"start_seconds":14.5,"end_seconds":40,"description":"Two people unload boxes"}]}',
      CHUNK_SECONDS,
    );

    expect(result.warnings).toEqual([]);
    expect(result.scenes).toEqual([
      { startSeconds: 0, endSeconds: 14.5, description: 'A red pickup truck pulls into a driveway' },
      { startSeconds: 14.5, endSeconds: 40, description: 'Two people unload boxes' },
    ]);
  });

  /**
   * A model that overshoots the end of a segment by a second still saw
   * something real there. Dropping the scene would lose the only note covering
   * that stretch, and a gap in the notes is invisible downstream — nothing can
   * tell it apart from a stretch where nothing happened.
   */
  it('clamps a scene that runs past the end of the chunk rather than dropping it', () => {
    const result = parseModelScenes(
      `{"scenes":[{"start_seconds":110,"end_seconds":${CHUNK_SECONDS + 8},"description":"Credits roll"}]}`,
      CHUNK_SECONDS,
    );

    expect(result.scenes).toEqual([{ startSeconds: 110, endSeconds: CHUNK_SECONDS, description: 'Credits roll' }]);
  });

  it('rejects a scene that does not describe a stretch of time', () => {
    const result = parseModelScenes(
      '{"scenes":[{"start_seconds":30,"end_seconds":30,"description":"A frozen instant"},{"start_seconds":40,"end_seconds":35,"description":"Backwards"}]}',
      CHUNK_SECONDS,
    );

    expect(result.scenes).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects a scene with no description, since an empty note recalls nothing', () => {
    const result = parseModelScenes(
      '{"scenes":[{"start_seconds":0,"end_seconds":10,"description":"   "}]}',
      CHUNK_SECONDS,
    );

    expect(result.scenes).toEqual([]);
    expect(result.warnings[0]).toMatch(/empty description/);
  });

  it('reads scenes out of a chatty or fenced answer', () => {
    const result = parseModelScenes(
      'Here are the scenes:\n```json\n{"scenes":[{"start_seconds":"5","end_seconds":"9","description":"A sign reads OPEN"}]}\n```',
      CHUNK_SECONDS,
    );

    expect(result.scenes).toEqual([{ startSeconds: 5, endSeconds: 9, description: 'A sign reads OPEN' }]);
  });

  /**
   * The distinction this whole file exists to protect. For a SEARCH, zero
   * results is a legitimate answer — the video may genuinely not contain what
   * was asked for. For a READ, zero scenes cannot be: two minutes of video
   * always contains something, so an empty result means the read failed.
   *
   * The parser reports it plainly with a warning, and the handler treats it as
   * a failed chunk. Storing it as an empty stretch would tell every later
   * question that nothing happens there.
   */
  it.each([
    ['', 'response contained no JSON object'],
    ['I could not watch this video.', 'response contained no JSON object'],
    ['{"scenes":[{"start_seconds":0,"end_seconds":12,"desc', 'response contained no JSON object'],
    ['{"notes":"a car drives past"}', 'response did not contain a "scenes" array'],
  ])('reports an unreadable answer instead of calling it an empty stretch: %s', (raw, warning) => {
    const result = parseModelScenes(raw, CHUNK_SECONDS);

    expect(result.scenes).toEqual([]);
    expect(result.warnings).toContain(warning);
  });
});
