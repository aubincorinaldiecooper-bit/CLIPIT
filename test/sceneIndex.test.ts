import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../src/services/search/modelResponse.js';
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

describe('the fullwidth colon that threw away real chunks', () => {
  /**
   * From production, 2026-09-01, video 05e8510c: MiniCPM wrote
   * `"description："` — a fullwidth colon standing in for the `":` that
   * should close the key — and minutes of a real basketball video were
   * recorded as unreadable over that one character. Two chunks died with two
   * different log messages ("failed to parse" and "no JSON object").
   *
   * The logged payloads are truncated, so the exact production responses
   * cannot be replayed here. What these pin instead is the malformation
   * CLASS through every route it can take out of the parser: the misplaced
   * quote desyncs the extractor's string tracking, and depending on what the
   * description happens to contain, the response then fails to parse whole,
   * yields a bogus briefly-balanced slice, or extracts nothing at all. The
   * repair runs on the whole response and re-reads it, so all three recover
   * the same way.
   */
  const repairWarning = 'response JSON repaired: fullwidth colon after a key name';

  it('recovers the bare-JSON shape that failed at parse (the chunk-0 log line)', () => {
    const raw =
      '{"scenes":[{"start_seconds":0,"end_seconds":14.5,"description："The segment shows a basketball game between the Miami Heat and the Boston Celtics, with players actively moving and shooting the ball."}]}';
    // Control: this really is the parse-failure symptom.
    expect(() => JSON.parse(raw)).toThrow();

    const result = parseModelScenes(raw, 121);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.description).toContain('Miami Heat');
    // Recovered, not fine: the warning keeps the model misbehaviour visible
    // in the same logs that used to record the chunk as unreadable.
    expect(result.warnings).toContain(repairWarning);
  });

  it('recovers a description whose own escaped quotes join the desync (the "MIAMI" shape)', () => {
    const raw =
      'Here is the scene breakdown:\n' +
      '{"scenes":[{"start_seconds":0,"end_seconds":14.5,"description："The video shows a player in a red \\"MIAMI\\" jersey shooting while others defend."}]}';
    // Control: unrepaired, extraction hands back a slice that cannot parse.
    const slice = extractJsonObject(raw);
    expect(slice === null || (() => { try { JSON.parse(slice); return false; } catch { return true; } })()).toBe(true);

    const result = parseModelScenes(raw, 121);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.description).toContain('"MIAMI"');
    expect(result.warnings).toContain(repairWarning);
  });

  it('recovers when the desync swallows the closing braces entirely', () => {
    // A brace inside the description is ordinary string content once the
    // value is a real string — and an extraction-breaking token while the
    // desync has the scanner reading the description as bare text.
    const raw =
      'Scene notes follow.\n' +
      '{"scenes":[{"start_seconds":0,"end_seconds":12,"description："The crowd rises, celebrating {wildly as the buzzer sounds."}]}';
    // Control: unrepaired, the scanner never gets back to depth zero.
    expect(extractJsonObject(raw)).toBeNull();

    const result = parseModelScenes(raw, 60);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.description).toContain('celebrating {wildly');
    expect(result.warnings).toContain(repairWarning);
  });

  it('leaves a fullwidth colon in ordinary description text alone', () => {
    const valid =
      '{"scenes":[{"start_seconds":0,"end_seconds":10,"description":"The scoreboard reads 比分：3-2 as the quarter ends."}]}';
    const result = parseModelScenes(valid, 60);
    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]!.description).toContain('比分：3-2');
    // Straight parse succeeded; no repair ran, so none is claimed.
    expect(result.warnings).not.toContain(repairWarning);
  });

  it('still reports genuinely unreadable answers as unreadable', () => {
    const result = parseModelScenes('the model answered in free prose with no JSON at all', 60);
    expect(result.scenes).toHaveLength(0);
    expect(result.warnings).toContain('response contained no JSON object');
  });
});
