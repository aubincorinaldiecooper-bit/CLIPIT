# Clipit's Qwen services on Modal

Two private deployments, invoked through Modal's SDK. There is no HTTP
endpoint and nothing to reach without Clipit's own API token.

| App | Class | Model | Job |
| --- | --- | --- | --- |
| `clipit-embedding` | `QwenEmbeddingService` | Qwen3-VL-Embedding-2B | Where should we look? |
| `clipit-reranker` | `QwenRerankerService` | Qwen3-VL-Reranker-2B | Which of these moments is it? |

## Read this before deploying

**These files replace what is currently deployed.** The live services already
load their weights and embed text correctly; what they do not yet expose is
the contract the Media Index needs. Diff them against whatever is running and
keep the model-loading and pooling that has already been proven to work — the
two `_encode` / `_score` methods are deliberately the only model-specific
parts, and they are the parts most likely to differ from what is live.

Deploy with `modal deploy modal/clipit_embedding.py` (and the reranker) into
the `main` environment. `clipit_reranker.py` imports the video transport from
`clipit_embedding.py`, so deploy from this directory.

## The contract, and why it is shaped this way

    one private video URL  +  [{id, start, end}, ...]   ->   one vector per id

**The video is fetched once per call, not once per interval.** A twelve-minute
proxy asked for 144 windows would otherwise be downloaded 144 times.

**Caching is keyed on `video_key`, never on the URL.** Clipit signs a fresh URL
for every request, so a cache keyed on the URL string would never hit once and
would silently re-download the same file forever. The key is the video's stable
storage key; the URL is a credential with an expiry. They are different things
and both are required.

**Every interval carries an id chosen by the caller, echoed back verbatim.**
Nothing is ever matched by position in a list. Array position has already cost
this codebase real bugs, and a batch that comes back reordered or partially
failed must be impossible to misread.

**A range that cannot be read comes back in `failed`, with a reason.** It is
never dropped and never returned as a zero vector. A zero vector sorts like a
real answer, and "there is nothing there" and "nobody managed to look" are
different facts that this system is not allowed to return as the same one.

**Every reply names its model, its dimension and its frame sampling.** Change
how frames are picked and you change every vector. A stored embedding whose
sampling is unknown cannot be compared with a new one, and comparing them
anyway produces confident, well-ordered, meaningless rankings.

## What these services cannot do

**They do not hear.** Qwen3-VL is vision and language. An embedding made here
carries what is VISIBLE and nothing audible. Speech reaches the index as text,
through `embed_texts`, over transcript windows. A non-speech sound — applause,
a door, an engine — has no representation anywhere in this stack. If that
matters, it needs a different model, and that is a decision, not an oversight.

**Reranker scores are comparable within one call and nothing promises they are
comparable across calls.** Rank and take the top few. Never threshold.
