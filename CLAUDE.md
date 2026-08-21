# Working rules for this repository

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
