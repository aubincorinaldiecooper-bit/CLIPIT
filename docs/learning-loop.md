# Getting smarter after each session

Clipit should improve from real usage without silently changing itself from unverified feedback.

## What the current system measures

The useful signals are now about the SimpleMem + footage-verification path:

- what people ask for;
- whether SimpleMem produced useful candidate moments;
- whether actual-footage verification confirmed those candidates;
- when retrieval had to fall back to direct footage search;
- whether a person later corrected the answer;
- which moments were kept or rejected;
- latency and model cost for memory retrieval versus footage work.

The retired notes/scene-index system is not part of this learning loop.

## What survives

Persistent product signals may include the question text, retrieval path, grounded moment timestamps/descriptions, feedback, corrections, and performance/cost measurements.

Source footage and derived transient media remain governed by the retention system. A stored memory candidate is not treated as truth merely because it survived longer than the source media.

## What this can improve

### 1. Retrieval quality

Measure how often SimpleMem points Clipit to a moment that the actual-footage verifier confirms. Poor confirmation rates can indicate weak indexing, weak retrieval, overly broad candidate windows, or a query the memory layer cannot answer reliably.

### 2. Fallback rate

A high direct-footage fallback rate means the memory layer is not saving enough work. The important question is why: memory unavailable, incomplete coverage, no useful candidates, or verification failure. These reasons should remain separate in reporting.

### 3. Confidence calibration

Model confidence is not ground truth. Compare confidence with later evidence such as Keep/reject behavior, explicit feedback, corrections, and verifier agreement before changing user-facing labels or thresholds.

### 4. Cost and latency

Track what the person actually waits for and what each retrieval path costs. A change is useful only if it improves speed/cost without quietly reducing coverage or grounding quality.

## What this is not

This is not automatic self-tuning. The system does not rewrite prompts, move confidence thresholds, or replace retrieval providers solely from user reactions.

The loop is:

```text
collect evidence
  → compare retrieval/verification outcomes
  → identify a specific weakness
  → test one change on known-good examples
  → promote only if it improves the measured result
```

## Grounding rule

SimpleMem candidates are proposals. For visual claims, actual footage remains the grounding boundary. A missing memory result is not proof that an event is absent, and a search result or embedding match is never enough to tell the user that Clipit saw something in the video.

## Privacy

Question text can itself contain personal information even when detached from an account identifier. Keep only what is necessary for product learning, and prefer aggregate measurements when the raw wording is not needed to diagnose retrieval behavior.
