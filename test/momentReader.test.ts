import { describe, expect, it } from 'vitest';
import { MomentReader, questionFor } from '../src/services/scout/momentReader.js';
import { frameIdForPosition, positionFromFrameId, type GanderChunk } from '../src/services/scout/ganderSession.js';

function chunk(overrides: Partial<GanderChunk> = {}): GanderChunk {
  return {
    text: '',
    consumedFrameIds: [],
    endOfTurn: false,
    isListen: false,
    index: 1,
    ...overrides,
  };
}

/** Frames as the scout names them: one per second of video. */
function framesFrom(startSeconds: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => frameIdForPosition((startSeconds + index) * 1000, index + 1));
}

describe('naming a frame for where it came from', () => {
  it('survives the round trip', () => {
    const id = frameIdForPosition(93_500, 7);
    expect(positionFromFrameId(id)).toBe(93_500);
  });

  it('is a name the runtime will accept', () => {
    // The runtime refuses anything outside [A-Za-z0-9_.:-], up to 256 characters.
    const id = frameIdForPosition(7_200_000, 12_345);
    expect(id).toMatch(/^[A-Za-z0-9_.:-]{1,256}$/);
  });

  it('reads nothing out of a name it did not write', () => {
    expect(positionFromFrameId('some-other-frame')).toBeNull();
  });
});

describe('reading moments out of what the model says', () => {
  it('says nothing when the model says nothing', () => {
    const reader = new MomentReader({ query: 'a dog on a skateboard' });
    expect(reader.take(chunk({ consumedFrameIds: framesFrom(0, 3), isListen: true }))).toBeNull();
    expect(reader.take(chunk({ text: 'Nothing much is happening.', endOfTurn: true }))).toBeNull();
    expect(reader.moments).toEqual([]);
  });

  it('takes the timestamps from the frames, not from the words', () => {
    const reader = new MomentReader({ query: 'a dog on a skateboard' });
    reader.take(chunk({ consumedFrameIds: framesFrom(10, 1), isListen: true }));
    // The model names a time of its own. It is not used: a number the model
    // invented looks exactly like one that is real.
    const moment = reader.take(
      chunk({
        text: 'MOMENT: A dog rolls past on a skateboard. I think this is around 4:00.',
        consumedFrameIds: framesFrom(11, 3),
        endOfTurn: true,
      }),
    );

    expect(moment).toEqual({
      startSeconds: 10,
      endSeconds: 13,
      description: 'A dog rolls past on a skateboard.',
    });
  });

  it('refuses a moment the model claimed while looking at nothing', () => {
    const reader = new MomentReader({ query: 'a dog on a skateboard' });
    const moment = reader.take(chunk({ text: 'MOMENT: A dog appears.', endOfTurn: true }));

    // No frames went into it, so there is no honest span to give it.
    expect(moment).toBeNull();
    expect(reader.moments).toEqual([]);
  });

  it('keeps one sentence, however much the model kept talking', () => {
    const reader = new MomentReader({ query: 'the wave' });
    const moment = reader.take(
      chunk({
        text: 'MOMENT: She waves at the camera. Then she turns away. Then the clip ends.',
        consumedFrameIds: framesFrom(4, 2),
        endOfTurn: true,
      }),
    );

    expect(moment?.description).toBe('She waves at the camera.');
  });

  it('gives a moment seen in one frame a length rather than a point', () => {
    const reader = new MomentReader({ query: 'the wave' });
    const moment = reader.take(
      chunk({ text: 'MOMENT: She waves.', consumedFrameIds: framesFrom(30, 1), endOfTurn: true }),
    );

    // The coordinator refuses a moment whose end does not come after its start.
    expect(moment?.startSeconds).toBe(30);
    expect(moment?.endSeconds).toBeGreaterThan(30);
  });

  it('finds a moment late in a video it watched in silence', () => {
    // The model is asked to say nothing until something happens, and it does.
    // So a first finding a minute and a half in has a minute and a half of
    // quiet watching behind it. Counting all of that would make the moment
    // the whole video so far, and it would then be thrown away for being too
    // long — losing exactly the findings the scout exists to produce.
    const reader = new MomentReader({ query: 'the wave', maxMomentSeconds: 60 });
    for (let second = 0; second < 90; second += 1) {
      reader.take(chunk({ consumedFrameIds: framesFrom(second, 1), isListen: true }));
    }
    const moment = reader.take(
      chunk({ text: 'MOMENT: She waves.', consumedFrameIds: framesFrom(90, 1), endOfTurn: true }),
    );

    expect(moment).not.toBeNull();
    expect(moment!.endSeconds).toBe(90);
    // What it is talking about is what it had just been shown, not everything
    // it has ever been shown.
    expect(moment!.endSeconds - moment!.startSeconds).toBeLessThanOrEqual(60);
    expect(moment!.startSeconds).toBe(30);
  });

  it('keeps a short moment short rather than padding it to the window', () => {
    const reader = new MomentReader({ query: 'the wave', maxMomentSeconds: 60 });
    reader.take(chunk({ consumedFrameIds: framesFrom(12, 2), isListen: true }));
    const moment = reader.take(
      chunk({ text: 'MOMENT: She waves.', consumedFrameIds: framesFrom(14, 1), endOfTurn: true }),
    );

    expect(moment?.startSeconds).toBe(12);
    expect(moment?.endSeconds).toBe(14);
  });

  it('carries the frames from listening steps into the turn they belong to', () => {
    const reader = new MomentReader({ query: 'the goal' });
    reader.take(chunk({ consumedFrameIds: framesFrom(20, 2), isListen: true }));
    const moment = reader.take(
      chunk({ text: 'MOMENT: The ball crosses the line.', consumedFrameIds: framesFrom(22, 1), endOfTurn: true }),
    );

    // The model was looking at 20s onwards while it worked this out.
    expect(moment?.startSeconds).toBe(20);
    expect(moment?.endSeconds).toBe(22);
  });

  it('starts a new turn after each one it reads', () => {
    const reader = new MomentReader({ query: 'every time someone laughs' });
    reader.take(chunk({ text: 'MOMENT: He laughs.', consumedFrameIds: framesFrom(5, 1), endOfTurn: true }));
    const second = reader.take(
      chunk({ text: 'MOMENT: She laughs.', consumedFrameIds: framesFrom(40, 2), endOfTurn: true }),
    );

    expect(reader.moments).toHaveLength(2);
    expect(second?.description).toBe('She laughs.');
    // The first turn's frames do not bleed into the second's span.
    expect(second?.startSeconds).toBe(40);
  });

  it('records every frame the model actually consumed', () => {
    const reader = new MomentReader({ query: 'anything' });
    reader.take(chunk({ consumedFrameIds: framesFrom(0, 3), isListen: true }));
    reader.take(chunk({ text: 'Nothing yet.', consumedFrameIds: framesFrom(3, 2), endOfTurn: true }));

    // What was watched is a separate fact from what was found, and the search
    // needs it to tell "we looked and saw nothing" from "we never looked".
    expect(reader.consumed.size).toBe(5);
  });
});

describe('the question the model is given', () => {
  it("carries the search's own words and asks for one shape back", () => {
    const question = questionFor('a dog on a skateboard');
    expect(question).toContain('a dog on a skateboard');
    expect(question).toContain('MOMENT:');
    expect(question).toContain('Do not guess at times');
  });
});
