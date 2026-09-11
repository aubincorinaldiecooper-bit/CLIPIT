# Working rules for this repository

## Never say anything untrue, and never leave a false impression

No form of lying is acceptable here. Neither is anything misleading.

- Never say you checked something unless you checked that exact thing.
- Never state an inference as a fact.
- Never report work as done, passing, deployed, watched, or verified when it is not.
- Correct mistakes as soon as they are noticed.
- Search metadata, titles, snippets, embeddings, and memory candidates are not footage evidence.

## Explain in plain English, always

Every summary, explanation, and status update is written for someone who is not reading the code.

- Say what it means for the person using the app before how the code does it.
- Prefer short sentences and ordinary words.
- Name the product problem before the implementation detail.
- Do not use status-report language when a plain explanation will do.

Commit messages, pull request descriptions, and code comments are where implementation precision belongs.

## Every delivered clip is vertical

Every clip Clipit makes is 9:16. This is a product rule, not a default and not something the person's wording can change.

The rule lives in `src/services/search/presentationTarget.ts`. Existing historical landscape files may still be described and played as they actually are, but any new or re-rendered deliverable is vertical.

## Ask before changing product direction

Never remove, disable, or replace an architectural decision as a side effect of another change. If a change alters what the product fundamentally does, say what would change and wait for approval.

Cleanup is different: code and documentation that describe a retired architecture should be removed once the replacement has been explicitly chosen.

## Current retrieval architecture

The current memory system is Omni-SimpleMem.

1. After preprocessing, SimpleMem indexes the video when `SIMPLEMEM_INDEX_ENABLED=true`.
2. When `RETRIEVAL_PRIMARY=simplemem`, a question goes to SimpleMem first.
3. SimpleMem returns timestamped candidates. Those candidates are leads, not final evidence.
4. Clipit opens the corresponding actual footage and verifies it through the configured video provider.
5. If memory is unavailable, incomplete, or inconclusive, Clipit may fall back to direct actual-footage search.
6. A final conversational answer is written only from grounded evidence already produced by the retrieval path.

There is no upload-time notes/scene-index retrieval system and no Media Index runtime path. Do not reintroduce either as a fallback.

## Never report an absence you did not verify

"Nothing matches" and "we did not look" are different answers.

If a region was not examined, a provider failed, memory did not cover it, or verification could not read it, report that as unexamined or inconclusive. Never convert missing coverage into a claim that the event is absent.

SimpleMem silence is not evidence of absence. Search metadata is not evidence of presence. Actual-footage verification is the grounding boundary.

## Memory proposes; footage verifies

SimpleMem exists to make retrieval fast and reusable. It narrows where Clipit should look. The configured video model decides what is actually visible in the relevant footage.

The current video-provider seam supports:

- OpenRouter/Qwen for actual-footage calls.
- MiniCPM-V on Modal as an optional self-hosted provider.

Those providers are alternatives behind the same footage-verification contract. MiniCPM is intentionally retained.

## Transcription is separate evidence

Speech-to-text remains a separate path for spoken content. Transcript evidence can answer speech questions, but it does not prove visual events. Visual claims still require visual evidence.

## Cost is never traded for coverage without asking

A cheaper path that looks at less footage is a product decision, not a hidden optimization. Measure first, then change deliberately.

## Model output is untrusted input

Everything a model returns must be validated before it reaches persistent state or the user. Free-form model output is not trusted merely because the request succeeded.

## Credentials stay server-side

OpenRouter, Modal, storage, SimpleMem, and other infrastructure credentials are server-side only. Never log signed media URLs or secret values.

## The user's instruction is the search

There are no predetermined clip categories. Whatever the user asks for is what Clipit searches for.
