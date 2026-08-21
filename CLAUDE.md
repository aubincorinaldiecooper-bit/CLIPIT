# Working rules for this repository

## Explain in plain English, always

Every summary, explanation, and status update is written for someone who is
not reading the code. This is a standing rule, not a per-message request — it
was asked for three times before it was written down here.

What that means in practice:

- **Say what it means for the person using the app**, before anything about
  how the code does it. "Ask a question and it answers in a second instead of
  two minutes" comes before any mention of a cache, a queue, or a schema.
- **Short sentences. Ordinary words.** If a term only makes sense to someone
  who has read this repository — coverage channel, serializer, escalate,
  P1, chunk grid, fall through — either replace it or explain it in the same
  breath, once.
- **Name the problem in the world, not in the file.** "It said your video had
  nothing at 16 minutes when it had never looked there" is the point.
  "`chunkErrors` was not persisted" is the mechanism, and it comes second, if
  at all.
- **No status-report voice.** Do not list what was touched. Say what changed
  and what it fixes.

Commit messages, pull request descriptions, and code comments are the place
for precision and detail. Chat is the place for being understood.

## Ask before changing direction

**Never change the product's direction as a side effect of another change.** If
a piece of work would remove, disable, or replace an architectural decision —
even to make a merge fit together, even when the alternative is a red build —
stop and ask first. Say what would be lost, and wait for an answer.

This is written here because it has already happened once, and the cost was
high. On 18 August the scene index was built so the model would read a video
once, at upload, instead of speed-reading all of it inside every question.
Eighteen hours later, reconciling it with the actual-video search left it
switched off — `index_status = 'unavailable'`, reason "Scene indexing is not
used". No one decided that on its merits. It was a consequence, and it stood
for days while every question re-read entire videos from scratch.

A decision that is expensive to reverse must be made deliberately, by the
person who owns the product, in advance.

## Never report an absence you did not verify

"Nothing matches" and "we did not look" are different answers and must never be
returned as the same one. This is the failure this codebase keeps circling:

- a chunk a provider refused, reported as clean coverage;
- a model that ran out of room mid-answer, parsed as zero matches;
- an empty scene index, reported as an empty video.

Every one of them tells a user their video lacks something it contains. If a
region was not examined, say so and name it.

## Answer from memory; look again when corrected

This is how a person answers a question about something they have read, and it
is the shape the product should have:

1. A video is read **once, at upload**, and what it contains is written down.
2. A question is answered **from those notes** — fast, and cheap enough that
   asking many questions is normal.
3. When the user says the answer is wrong — "are you sure", "look again", "you
   missed it" — that is **not a new question**. It is a correction, and the
   response is to go back and look harder at the same one, ending at the
   footage itself if the notes cannot settle it.

The notes are a record of what the indexer thought worth writing down, not a
complete account of the video. Their silence is not evidence of absence.

## Cost is never traded for coverage without asking

Cheaper searches that find less are a product decision, not an optimisation.
Measure first, then ask. The reasoning budget in
`docs/openrouter-video-investigation.md` is the worked example: it was disabled
as a cost fix, reverted on evidence that it was load-bearing, and finally
bounded from a measurement that showed where the value stopped.

## Model output is untrusted input

Everything a model returns passes through validation before it reaches the
database (`src/services/search/modelResponse.ts`). It arrives as free text that
is supposed to be JSON and is frequently something else.

## Credentials stay server-side

`OPENROUTER_API_KEY` is a server secret, never exposed to the browser, never
committed, and the process fails at startup if it is missing.

## The user's instruction is the search

There are no predetermined clip categories. Whatever the user typed is what is
searched for, passed through verbatim.
