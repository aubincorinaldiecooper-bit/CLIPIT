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

## Clip production is dormant for the current MVP

The 9:16 production/rendering implementation is retained for later, but it is not part of the current video-understanding MVP. `VERTICAL_CLIP_PIPELINE_ENABLED` stays false unless the owner explicitly brings clip production back into scope. Do not enable it as a side effect of unrelated work.

## Every delivered clip is vertical

When clip production is enabled again, every clip Clipit makes is 9:16. This is a product rule, not a default and not something the person's wording can change.

The rule lives in `src/services/search/presentationTarget.ts`. Existing historical landscape files may still be described and played as they actually are, but any new or re-rendered deliverable is vertical.

## Ask before changing product direction

Never remove, disable, or replace an architectural decision as a side effect of another change. If a change alters what the product fundamentally does, say what would change and wait for approval.

Cleanup is different: code and documentation that describe a retired architecture should be removed once the replacement has been explicitly chosen.

## Current retrieval architecture

The engine that reads footage is VideoChat3 on Modal, with Qwen embeddings and the Qwen reranker between its two reads. Omni-SimpleMem is the persistent memory around that engine.

1. After preprocessing, SimpleMem indexes the video when `SIMPLEMEM_INDEX_ENABLED=true`.
2. With `RETRIEVAL_PRIMARY=videochat3` (the default), a question about an uploaded video goes to SimpleMem first when uploads are indexed. SimpleMem returns timestamped candidates. Those candidates are leads, not final evidence; they go through Qwen embedding, Qwen reranking, and VideoChat3 verification of the actual footage.
3. When memory has no verified answer, the footage is read the way an internet video is read: VideoChat3 watches the analysis proxy for the question, Qwen embeddings and the Qwen reranker order what it flagged, and VideoChat3 re-opens each candidate before it becomes evidence. A watch that verified nothing completes the request; the stretch after the watch's event cap, if it is reached, is recorded as unexamined.
4. The direct per-chunk footage search (OpenRouter/Qwen, or MiniCPM-V on Modal) runs only for a question about speech, which the watcher cannot hear. It is not a fallback for visual or mixed questions: when the VideoChat3 pipeline fails, the request completes with the whole video on record as unexamined, never by re-reading the video chunk by chunk. With `RETRIEVAL_PRIMARY=simplemem` the per-chunk search is the fallback for every memory miss; with `clipit` it is the only path.
5. A final conversational answer is written only from grounded evidence already produced by the retrieval path.

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
