import { readFile, writeFile, unlink } from 'node:fs/promises';

async function edit(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change made to ${path}`);
  await writeFile(path, after);
}

await edit('src/domain/types.ts', (s) => s.replace(
`export type ChunkFailureCode =
  /**
   * Not a failure of this search at all: the stretch was never described when
   * the video was read at upload, so an answer from the notes cannot speak for
   * it. Reported the same way as an unsearched chunk because it means the same
   * thing to the person reading it — nobody looked there.
   */
  | 'not_in_notes'
  /**
   * Not a failure at all: when this question was asked, the video had not been
   * read that far yet. Distinct from \`not_in_notes\`, which means the read
   * finished and that stretch is missing from it — one resolves itself in a
   * minute, the other never will, and telling a person "I couldn't look there"
   * about the first is simply untrue.
   */
  | 'not_read_yet'
  | 'provider_content_filter'`,
`export type ChunkFailureCode =
  | 'provider_content_filter'`));

await edit('src/services/search/readiness.ts', (s) => s.replace(
` * These were one thing: the video's \`ready\` status, set at the end of
 * preprocessing after the analysis copy, the watchable copy, the poster and
 * every segment had been stored. The send button waited for all of it — in
 * the observed session, sixty-one seconds after "uploaded" — although the
 * only one of those outputs an answer depends on is the analysis segments
 * the notes are read from, and the answer ALSO waits for those notes, for up
 * to four minutes, quite happily.
 *
 * So the two are separated. A question is ACCEPTED the moment the video's
 * bytes have landed: there is a video to ask about, and the words are the
 * person's to send. The ANSWER waits for what it genuinely needs — the
 * preparation, then the notes, then (for a spoken question) the transcript —
 * inside the search job, the same way it already waited for the last two.`,
` * These were once one thing: the video's \`ready\` status, set only after
 * preprocessing had stored every derived media artifact. The send button
 * therefore waited for preparation even though the user's question already
 * existed and could safely be queued.
 *
 * The two are separated. A question is ACCEPTED the moment the video's bytes
 * have landed. The ANSWER waits inside the search job for what it genuinely
 * needs: preparation, retrieval availability, and — for a spoken question —
 * the transcript.`));

await edit('test/clipSearchCompletion.test.ts', (s) => s
  .replace('  recordSearchApproach: vi.fn(),', '  recordCorrection: vi.fn(),')
  .replace("completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes',", "completeRequest({ clipRequestId: 'request-1', answeredFrom: 'footage',")
  .replace("toHaveBeenCalledWith('request-1', 'attempt-1', 'notes', 'clipit')", "toHaveBeenCalledWith('request-1', 'attempt-1', 'footage', 'clipit')"));

await edit('test/platformReports.test.ts', (s) => s.replaceAll("answeredFrom: 'notes'", "answeredFrom: 'simplemem'"));

await unlink('scripts/finalize-legacy-residue.mjs');
await unlink('.github/workflows/finalize-legacy-residue.yml');
