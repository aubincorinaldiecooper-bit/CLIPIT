from pathlib import Path


def read(p): return Path(p).read_text()
def write(p, s): Path(p).write_text(s)

# The first-pass removal intentionally preserves runtime behavior. Clean the
# stale architecture comments left around the surviving preparation,
# transcript, SimpleMem, and actual-footage paths so current code no longer
# describes the retired notes system.
p = 'src/worker/handlers/clipSearch.ts'
s = read(p)
replacements = {
    '/** Milliseconds this question has already spent parked for the notes or the transcript, across every re-queue. */':
        '/** Milliseconds this question has already spent parked for the transcript, across every re-queue. */',
    "     * from the notes' and the transcript's allowances. A six-minute\n     * preparation (a 4 GB file, 2026-09-04) must not use up the four minutes\n     * the notes are allowed afterwards, or a slow file would be sent to the\n     * footage — fifty times the cost — for an answer the notes were about to\n     * give (Devin's finding on #95).\n":
        "     * from the transcript allowance. A slow preparation must not consume\n     * the bounded wait reserved for speech evidence once the video is ready.\n",
    "     // — the same way it waits for the notes and the transcript further down.\n":
        "     // — before retrieval or actual-footage search can begin.\n",
    "     * question is re-run, and it goes straight to the footage, because the\n     * notes have already had their turn and did not settle it.\n":
        "     * question is re-run and goes straight to actual footage rather than\n     * trusting a previous retrieval result.\n",
    "     // It sits above the notes path deliberately. Answering from memory is a\n     // real answer and reaches finishClipRequest on its own; if the plan were\n     // recorded further down, a question answered from the notes would never be\n     // marked as owing a deck at all.\n":
        "     // It sits above retrieval deliberately. A SimpleMem answer is a real\n     // answer and reaches completion on its own, so the deck obligation must\n     // exist before either retrieval or the footage fallback can return.\n",
    "     * Memory before a full footage read.\n     *\n     * The video was read once at upload; a question it can answer costs a\n     * second and a fraction of a cent instead of re-reading the whole video.\n     * A partial set of in-progress notes was already tried above; that lets an\n     * early question finish without waiting. Corrections skip every memory.\n     *\n     * Finding nothing here is NOT an answer. The notes are what the indexer\n     * thought worth writing down, so their silence means \"not mentioned\", not\n     * \"not present\" — and the search falls through to the footage rather than\n     * reporting an absence it cannot vouch for.\n     */\n     // Recorded whether or not the notes are consulted, because the two cases\n     // answer different questions later: notes read and silent says reading at\n     // upload is not covering what people ask, while no notes at all says\n     // nothing about the reading and everything about the video's age.\n":
        "     * Memory before a full footage read.\n     *\n     * SimpleMem is the upload-time memory/retrieval system. Its candidates are\n     * never evidence by themselves: they are verified against actual footage.\n     * A miss or unavailable memory falls through to the full footage search.\n     */\n",
    "     // Reading the footage is the only path that can report a real absence, so\n     // it is the only one that runs when the notes came up empty.\n":
        "     // Actual footage is the fallback truth source when memory cannot settle\n     // the request; retrieval silence is never treated as proof of absence.\n",
    "     // (the deck plan is declared earlier — see above, before the notes path)\n":
        "     // (the deck plan is declared earlier, before retrieval can answer)\n",
    " * Two paths reach a completed request: the notes, and the footage. Both owe\n * the creator the same thing: the moments they found, with their pictures,\n":
        " * Retrieval and actual-footage paths can both reach completion. Both owe\n * the creator the same thing: verified moments, with their pictures,\n",
    "    // lost if this process stops. Notes and footage are both Clipit's own\n    // search; only the external retrieval systems are the other thing.\n":
        "    // lost if this process stops.\n",
}
for old, new in replacements.items():
    s = s.replace(old, new)
write(p, s)

# The preparation fencing test should continue proving that questions can be
# submitted before preprocessing completes. The legacy notes-index wait was
# intentionally removed, so asserting its presence is now the wrong contract.
p = 'test/searchFencing.test.ts'
s = read(p)
s = s.replace(
    "    // Its own allowance: the wait for preparation is re-queued with the\n"
    "    // notes' and transcript's counter untouched, so a slow preparation\n"
    "    // cannot spend the allowance those get once the video is ready\n"
    "    // (Devin's finding on #95).\n",
    "    // Its own allowance: preparation waiting is tracked separately from\n"
    "    // the transcript wait, so a slow upload cannot consume speech-evidence\n"
    "    // time once the video is ready.\n",
)
s = s.replace("    expect(handler).toContain('indexPending && waitedMs < env.INDEX_WAIT_TIMEOUT_MS');\n", '')
write(p, s)

# Guard against accidentally leaving the old active architecture in current
# source comments/docs. Compatibility field names and historical migrations are
# intentionally not rewritten here.
for p in ['src/worker/handlers/clipSearch.ts', 'src/worker/handlers/preprocess.ts', 'src/worker/main.ts']:
    text = read(p).lower()
    forbidden_phrases = [
        'answer from notes', 'answered from notes', 'notes path', 'notes came up empty',
        'notes first', 'notes-first', 'video into notes', 'read the video into notes',
    ]
    found = [phrase for phrase in forbidden_phrases if phrase in text]
    if found:
        raise SystemExit(f'{p}: stale legacy notes wording remains: {found}')
