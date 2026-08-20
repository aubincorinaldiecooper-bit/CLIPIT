# OpenRouter actual-video MVP

Status: **implemented MVP decision**, reviewed 2026-08-19.

## One production path

The MVP uses one visual-understanding model:

`actual MP4 chunk + user's natural-language instruction → qwen/qwen3-vl-235b-a22b-instruct through OpenRouter → timestamp range(s)`

Qwen3-VL 235B A22B Instruct is the only production visual model. There is no
model comparison, fallback, escalation, or routing cascade. Do not add another
model or a cost-control behavior that reduces search coverage without asking
first.

### Why 235B and not 32B

The original choice was `qwen/qwen3-vl-32b-instruct`. In production every
request against it was refused with `404 — No endpoints found that support
input video`: the model advertises video, but no provider serving that slug on
OpenRouter exposes a video endpoint. The family decision held; the size did not.
235B A22B is served by several providers, and its stronger OCR is what the
acceptance case below actually turns on.

The `-instruct` variant is deliberate. Its `-thinking` sibling spends tokens and
wall-clock on reasoning that a short JSON array of timestamps does not need, and
that prose can reach the strict parser as output it has to reject. Reasoning is
never requested — see the test in `test/openrouterVideo.test.ts`.

A `modelCapabilities` preflight now sends one 814-byte MP4 before any fan-out,
so a slug that will not route video fails in about a second instead of after ten
multi-megabyte uploads.

### Migrating an existing deployment

`OPENROUTER_VIDEO_MODEL` is optional, and any environment that sets it
explicitly overrides the default above — including with the 32B slug that
refuses every video request. Check each environment and either clear the
variable or set it to the model named above. The Railway `worker` service does
not set it, so it takes the default.

The preflight makes a missed environment loud rather than silent: the search
fails immediately naming the configured slug, instead of returning "nothing
matches" as though the video genuinely lacked the moment.

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

Chunks are independent, so `OPENROUTER_VIDEO_CONCURRENCY` sets how much of a
search runs at once; it defaults to 4. Ten chunks at the previous value of 2
meant five sequential rounds of the slowest call in each pair. Change it from
measured end-to-end latency — logged as `elapsedMs` on `clip search complete`,
alongside the chunk count, chunk length, concurrency and model that produced it
— rather than from an estimate, and before reaching for further architecture.

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

## Quoted phrases are not necessarily speech

A quoted phrase in an instruction may be spoken, or it may be text visible in
the frame. `find the scene where it shows the car that say "bought with
investor money"` scores on both sides of the classifier — `say` and the quotes
read as speech, `shows`/`scene`/`car` read as visual — so it resolves to `both`
once a transcript exists.

`both` is the correct mode: it gives the model more evidence, not less. The
hazard is downstream. Told to require every requested condition, a model can
find the car, fail to find the phrase in the transcript, and discard a correct
match — a false negative indistinguishable from the moment not being there.

`SYSTEM_PROMPT` therefore states that a quoted phrase may be satisfied by
on-screen text or by speech unless the instruction says which, and that "say"
applied to an object means text visible on it. Do not tighten this back into
"require all modalities" without a case showing it over-matches.

The prompt alone is not enough, because `transcript` mode sends no video at
all. `Find "SALE"` once scored as pure speech and routed there, so the phrase
could never be matched against what was on screen — the routing decided the
outcome before the model saw anything. A quoted phrase is therefore no longer
counted as a spoken signal; on its own it resolves to `both`. Words naming
things text is written on — sign, banner, jersey, licence plate, hood, caption
— are visual signals for the same reason.

Unquoted spoken instructions still resolve to `transcript` and still skip the
upload, and an explicitly requested `transcript` search is always honoured.

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
