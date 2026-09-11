import { readFile, writeFile, unlink } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change made to ${path}`);
  await writeFile(path, after);
}

await edit('src/config/env.ts', (s) => s
  .replace(
`  // --- Retrieval primary: Omni-SimpleMem tried first, Clipit's own search as the fallback
  /**
   * Which system a question goes to first. \`clipit\` is today's behaviour
   * exactly: notes, then footage. \`simplemem\` asks the Omni-SimpleMem sidecar
   * first and falls back to the Clipit path when the memory is not ready,
   * cannot place the question in time, or finds nothing — each recorded on
   * the request as its own reason, so the two can be compared from rows.
   */`,
`  // --- Retrieval primary: Omni-SimpleMem first, direct footage search as fallback
  /**
   * Which retrieval system a question goes to first. \`clipit\` means direct
   * actual-footage search. \`simplemem\` asks Omni-SimpleMem first, verifies
   * candidates against the actual footage, and falls back to direct footage
   * when memory is not ready, cannot place the question in time, or finds
   * nothing. Each handoff reason is recorded so the paths stay measurable.
   */`)
  .replace(
`   * How many calls carrying video may be in flight at once — the whole
   * account, covering both reading a video at upload and searching its
   * footage. One number because the provider's limit is one limit: giving
   * reading its own allowance simply meant reading and searching could add up
   * to more than either was allowed.
   *
   * Measured: ten chunks at 4 read a 20-minute video in 130 seconds, three
   * rounds of about forty-five. 8 makes it two. Raise it from a real upload,
   * not a guess — past the provider's ceiling this turns into retries, which
   * makes everything slower rather than faster.`,
`   * How many actual-footage model calls may be in flight at once across the
   * worker. Verification and direct footage search share one provider ceiling;
   * separate limits would let the two paths exceed it together.
   *
   * Measured footage searches showed that raising concurrency reduces the
   * number of chunk rounds only while the provider can really sustain it.
   * Raise this from observed searches, not a guess — past the provider's
   * ceiling retries make the system slower rather than faster.`)
  .replace(
`   * A question is accepted the moment the video's bytes have landed; the
   * answer waits here for the video to be prepared (its analysis segments),
   * polling at this rate, before it goes on to wait for the notes above.
   * Past the timeout the question fails with a plain message rather than
   * sitting forever on a preparation that will not finish.`,
`   * A question is accepted the moment the video's bytes have landed; the
   * answer waits here for the video to be prepared (its analysis segments),
   * polling at this rate. Past the timeout the question fails with a plain
   * message rather than sitting forever on a preparation that will not finish.`)
  .replace('/** Room for the answer to a notes lookup: a list of moments, nothing more. */\n  OPENROUTER_VIDEO_TEMPERATURE:', '/** Sampling temperature for actual-footage video search responses. */\n  OPENROUTER_VIDEO_TEMPERATURE:'));

await edit('src/domain/types.ts', (s) => s.replace(
  ' * See services/mediaIndex/search.ts and services/retrieval/simplemem/candidates.ts.',
  ' * See services/retrieval/simplemem/candidates.ts.',
));

await edit('src/worker/handlers/clipSearch.ts', (s) => s
  .replace(
`   * Milliseconds spent parked for the video's preparation, counted apart
   * from the notes' and the transcript's allowances. A six-minute
   * preparation (a 4 GB file, 2026-09-04) must not use up the four minutes
   * the notes are allowed afterwards, or a slow file would be sent to the
   * footage — fifty times the cost — for an answer the notes were about to
   * give (Devin's finding on #95).`,
`   * Milliseconds spent parked for the video's preparation, counted apart
   * from the transcript wait. A large upload can spend minutes preparing;
   * that time must not consume the separate allowance for speech readiness.`)
  .replace(
`    // answer waits here for the video to be prepared — its analysis segments
    // — the same way it waits for the notes and the transcript further down.`,
`    // answer waits here for the video to be prepared — its analysis segments
    // — before retrieval or transcript-dependent search can proceed.`)
  .replace(
`    // It sits above the retrieval path deliberately. Answering from memory is a
    // real answer and reaches finishClipRequest on its own; if the plan were
    // recorded further down, a question answered from the notes would never be
    // marked as owing a deck at all.`,
`    // It sits above the retrieval path deliberately. Answering from SimpleMem is
    // a real answer and reaches completion on its own; if the plan were recorded
    // further down, a memory answer would never be marked as owing a deck at all.`));

await unlink('scripts/finalize-legacy-cleanup.mjs');
await unlink('.github/workflows/finalize-legacy-cleanup.yml');
