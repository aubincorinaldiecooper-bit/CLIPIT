import { describe, expect, it } from 'vitest';
import { parseSceneResponse, SCENE_INDEX_SYSTEM_PROMPT } from '../src/services/search/sceneIndex.js';
import { buildIndexSearchUserMessage, INDEX_SEARCH_SYSTEM_PROMPT } from '../src/services/search/prompt.js';

/**
 * The scene index is what every future query answers from, so its parser and
 * prompts are pinned the same way the match parser is.
 */

describe('parseSceneResponse', () => {
  it('parses a well-formed response', () => {
    const { scenes, warnings } = parseSceneResponse(
      JSON.stringify({
        scenes: [
          { start_seconds: 0, end_seconds: 14.5, description: 'Two men talk at a desk; a name tag reads ALEX.' },
          { start_seconds: 14.5, end_seconds: 30, description: 'A grey pickup truck passes the window.' },
        ],
      }),
    );
    expect(warnings).toEqual([]);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toEqual({
      startSeconds: 0,
      endSeconds: 14.5,
      description: 'Two men talk at a desk; a name tag reads ALEX.',
    });
  });

  it('tolerates fences, prose, and string numbers', () => {
    const { scenes } = parseSceneResponse(
      'Here is the index:\n```json\n{"scenes":[{"start_seconds":"5","end_seconds":"9.5","description":"A door opens."}]}\n```',
    );
    expect(scenes).toEqual([{ startSeconds: 5, endSeconds: 9.5, description: 'A door opens.' }]);
  });

  it('drops malformed entries without dropping the batch', () => {
    const { scenes, warnings } = parseSceneResponse(
      JSON.stringify({
        scenes: [
          { start_seconds: 'not a number', end_seconds: 4, description: 'bad' },
          { start_seconds: 10, end_seconds: 12, description: '   ' },
          { start_seconds: 20, end_seconds: 25, description: 'A goal is scored.' },
        ],
      }),
    );
    expect(scenes).toEqual([{ startSeconds: 20, endSeconds: 25, description: 'A goal is scored.' }]);
    expect(warnings).toHaveLength(2);
  });

  it('never throws on garbage', () => {
    expect(parseSceneResponse('').scenes).toEqual([]);
    expect(parseSceneResponse('no json here at all').scenes).toEqual([]);
    expect(parseSceneResponse('{"scenes": "wrong shape"}').scenes).toEqual([]);
    expect(parseSceneResponse('{"unrelated": true}').scenes).toEqual([]);
  });

  it('caps runaway descriptions', () => {
    const { scenes } = parseSceneResponse(
      JSON.stringify({ scenes: [{ start_seconds: 0, end_seconds: 5, description: 'x'.repeat(5000) }] }),
    );
    expect(scenes[0]!.description).toHaveLength(1000);
  });
});

describe('index prompts', () => {
  it('the indexing prompt demands neutral, complete coverage — no categories', () => {
    expect(SCENE_INDEX_SYSTEM_PROMPT).toMatch(/every distinct scene/i);
    expect(SCENE_INDEX_SYSTEM_PROMPT).toMatch(/on-screen text/i);
    expect(SCENE_INDEX_SYSTEM_PROMPT).toMatch(/"scenes"/);
    // The index is built before any instruction exists; nothing may pre-filter.
    expect(SCENE_INDEX_SYSTEM_PROMPT).not.toMatch(/instruction/i);
  });

  it('the search prompt keeps the matches contract on the global clock', () => {
    expect(INDEX_SEARCH_SYSTEM_PROMPT).toMatch(/FROM THE START OF THE VIDEO/);
    expect(INDEX_SEARCH_SYSTEM_PROMPT).toMatch(/"matches"/);
    expect(INDEX_SEARCH_SYSTEM_PROMPT).toMatch(/empty matches array/i);
  });

  it('builds the user message from both evidence sections with bounds', () => {
    const message = buildIndexSearchUserMessage({
      instruction: 'find the part where they see a cyber truck',
      durationSeconds: 1179.272,
      scenes: [{ startSeconds: 610, endSeconds: 640, description: 'An angular metallic pickup drives past.' }],
      transcript: [{ startSeconds: 612, endSeconds: 615, text: 'whoa, is that a Cybertruck?' }],
    });

    expect(message).toContain('USER INSTRUCTION: find the part where they see a cyber truck');
    expect(message).toContain('between 0 and 1179.3 seconds');
    expect(message).toContain('VISUAL SCENE INDEX');
    expect(message).toContain('[610.0s - 640.0s] An angular metallic pickup drives past.');
    expect(message).toContain('TRANSCRIPT');
    expect(message).toContain('whoa, is that a Cybertruck?');
  });

  it('omits evidence sections that are empty', () => {
    const message = buildIndexSearchUserMessage({
      instruction: 'anything',
      durationSeconds: 60,
      scenes: [],
      transcript: [{ startSeconds: 1, endSeconds: 2, text: 'hello' }],
    });
    expect(message).not.toContain('VISUAL SCENE INDEX');
    expect(message).toContain('TRANSCRIPT');
  });
});
