# Getting smarter after each session

Footage is deleted when the session that uploaded it ends. The question this
document answers is what the system keeps instead, and how that turns into a
product that reads video better next month than it does today.

## What survives a session

Everything below is text, holds no video, and outlives the footage:

| kept | why it teaches us something |
|---|---|
| the question, as typed | what people actually ask of a video |
| whether the notes could answer it | whether reading at upload was enough |
| whether they then said "look again" | our answer was wrong and they knew it |
| the moments found: time, description, confidence | what we claimed to see |
| thumbs up or down on each | whether we were right |
| the moments we discarded as uncertain | what we nearly missed, or nearly invented |

What is deliberately **not** kept: the footage, the scene notes, and the
transcript. Those describe someone's video rather than our reading of it, and
once the footage is gone there is nothing left to check them against.

## The three things this can improve

### 1. What the indexer writes down

The single most actionable signal in the list is **questions the notes could
not answer**. When someone asks about text on a sign and the notes never
recorded any text, the failure is not in the search — it is that the indexer
was not told to write signs down.

So: gather the questions that fell through to the footage, and read them. A
recurring subject in that list is a line missing from the indexing prompt.

### 2. What "High" and "Likely" mean

Confidence is currently the model's opinion of its own answer, and it decides
the label a person reads. Pair confidence with the thumbs verdict on the same
match and the calibration falls out: if matches at 0.9 are voted down as often
as matches at 0.5, the number is decoration and the label should be derived
from something else — how long the thing is on screen, how directly it answers
what was asked.

**This needs volume before it means anything.** A dozen verdicts is an anecdote.

### 3. Where the confidence threshold sits

`MIN_MATCH_CONFIDENCE` is 0.3, which was a guess. The uncertain moments we now
record are the evidence for moving it: if the moments discarded just under the
line get thumbs up when a person jumps to them, the line is too high.

## What this is not

**It is not automatic tuning.** Nothing in this loop edits a prompt or moves a
threshold on its own, and it should not until there is a set of known-good
videos to test a change against. A system that rewrites its own prompts from
user reactions, with no way to check whether the rewrite made things worse, is
a system that gets quietly worse — and the failure is invisible, because the
same signal that caused the change is the only thing measuring it.

The loop is: **collect, read, decide, change one thing, watch the numbers.**
The collecting and the reading are automated. The deciding is not.

## What is built

A daily line in the logs, carrying:

- how many questions were answered from memory versus the footage
- how often people said "look again" after an answer
- thumbs up against thumbs down, and the average confidence of each
- the questions the notes could not answer, verbatim

The last one is the one to actually read. It is a list of things people wanted
from their video that we had not thought to write down.

## Privacy note, stated rather than buried

Questions are kept as typed, detached from the session and from any identifier,
because the wording is the signal — "find where the sign says OPEN" and "find
the shop front" fail differently. A question can still name a person ("where
does Emma sing"), so the text is a person's words even when nothing links it
back to them. If that becomes uncomfortable, the mitigation is to drop the
question text and keep only the aggregate, at the cost of the one signal in
this document that is directly actionable.
