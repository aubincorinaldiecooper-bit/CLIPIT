# OpenRouter actual-video MVP

Status: **implementation decision**, reviewed 2026-08-18.

## One production path

The MVP uses one visual-understanding model:

`actual MP4 chunk + user's natural-language instruction → qwen/qwen3-vl-32b-instruct through OpenRouter → timestamp range(s)`

Qwen3-VL 32B is the only production visual model. There is no model comparison,
fallback, escalation, or routing cascade. Do not add another model or a
cost-control behavior that reduces search coverage without asking first.

OpenRouter STT remains a separate path that creates reusable timestamped speech.
Mixed searches give Qwen both the actual MP4 and the chunk-local transcript.
Visual searches give it the MP4. This preserves visual actions, OCR/on-screen
text, and temporal context instead of reducing the video to sampled-frame text
summaries.

## Media transport and chunks

OpenRouter chat completions accepts video in a `video_url` content part whose
value can be a base64 data URL. Private Railway chunks are downloaded by the
worker and sent as `data:video/mp4;base64,...`; they do not need to be exposed by
a public or presigned URL.

Analysis chunk duration is controlled by `ANALYSIS_CHUNK_SECONDS` and defaults
to 120 seconds. The existing low-resolution H.264 proxy remains the analysis
media; generated clips still come from the original. If real provider limits
require shorter chunks, change the configuration rather than introducing a
second model.

Reference: [OpenRouter video inputs](https://openrouter.ai/docs/guides/overview/multimodal/videos).

## Reliability and observability

Every Qwen request records:

- selected model and routed provider (when returned);
- total request latency;
- video duration and binary size;
- complete JSON payload size, including base64 expansion;
- prompt, completion, and total tokens; and
- OpenRouter-reported USD cost.

Retryable transport and provider failures use bounded exponential retries. A
chunk failure is recorded by the existing job flow; it does not invoke another
model. Model output continues through the existing untrusted-JSON parser,
timestamp clamps, source-time mapping, and overlap aggregation.

## Functional acceptance

Use the known black-car scene around source time `00:54` as an acceptance case,
not a comparison benchmark. A visual instruction such as “find the black car”
must return a range covering that scene. Also exercise:

1. an action that requires temporal understanding rather than one isolated frame;
2. visible text in a sign, caption, scoreboard, or overlay; and
3. a mixed instruction requiring both something visible and something spoken.

For each case, verify the returned range maps to source time and produces a
playable clip. Capture the request metrics above so chunk size and concurrency
can later be optimized from real usage without prematurely reducing coverage.
