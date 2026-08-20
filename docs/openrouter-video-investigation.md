# OpenRouter actual-video MVP

Status: **implemented MVP decision**, reviewed 2026-08-20.

## One production path

The MVP uses one visual-understanding model:

`actual MP4 chunk + user's natural-language instruction → qwen/qwen3.6-flash through OpenRouter → timestamp range(s)`

Qwen3.6 Flash is the only production visual model. There is no
model comparison, fallback, escalation, or routing cascade. Do not add another
model or a cost-control behavior that reduces search coverage without asking
first.

### Why Qwen3.6 Flash and not Qwen3-VL

Neither Qwen3-VL size works. **No Qwen3-VL model has a video endpoint on
OpenRouter** — 32B and 235B A22B were both refused with `404 — No endpoints
found that support input video` before reaching a provider. The family
understands video; OpenRouter does not serve it that way. Qwen3.6 Flash takes
native `video_url` input and is the production model.

`google/gemini-2.5-flash` is kept as a comparison point only. It is not a
fallback the code selects: there is still exactly one production model, and no
cascade.

The failure that cost two rounds was in the error message rather than the
code. Its replacement list was sorted alphabetically and cut at a limit, so a
Qwen model that could not route video suggested Amazon, ByteDance and Google
and hid every other Qwen behind "+55 more" — reading as "no Qwen model can do
this" when the answer was in the part not shown. Suggestions are now ordered
same-vendor first: someone who chose a vendor deliberately is most likely
replacing it with its sibling.

### The dead end, recorded so it is not retried

The original choice was `qwen/qwen3-vl-32b-instruct`, then
`qwen/qwen3-vl-235b-a22b-instruct` on the theory that 32B's single provider was
the problem and a multi-provider sibling would route. It did not. Both were
refused identically. The lesson is the general one above: a model card listing
video says nothing about whether OpenRouter has an endpoint serving it that way.

A `modelCapabilities` preflight sends one small MP4 before any fan-out, so a
slug that will not route video fails in about a second instead of after ten
multi-megabyte uploads. It is what caught both dead ends for the price of one
probe each.

## Reasoning: budgeted, measured

**Reasoning is on, with a 2,500-token budget** (`OPENROUTER_VIDEO_REASONING_MAX_TOKENS`).
Do not disable it, and do not raise the budget, without reading this section.

It was briefly disabled, on the reasonable-sounding argument that locating a
moment is not a reasoning task and thinking tokens spend money and wall-clock
on an answer that is a short JSON array. The per-chunk numbers from the first
successful production run contradict that:

| chunk | completion tokens | matches |
|-------|-------------------|---------|
| 9, 5, 8, 2 | 468–943 | 0 |
| 3 | 1,595 | 0 |
| 6 | 2,486 | 1 |
| 1 | 3,074 | 2 |
| 0 | 3,887 | 1 |
| 4 | 13,431 | 0 |

Every chunk that found a match spent more than every chunk that found nothing,
and the gap is far too large to be output length — two matches of JSON is
roughly 150 tokens, not 3,000. Whatever consumes those tokens correlates with
*finding moments*, and chunk 0, which located the acceptance case at `00:54`,
sits near the top of the spend.

Disabling it would therefore have been a cost-control change that reduces
search coverage, which the rule at the top of this document forbids without
asking. It was shipped as a latency fix and never examined as a coverage one.

### What the measurement said

A full run with `reasoning_tokens` recorded per chunk (clipRequestId
`6884a9c6-5225-49ff-ae26-8419b8561b17`, "clip every time a cybertruck is seen",
visual mode) settled it. Reasoning was 87–99% of every completion, so the
tokens are thinking, not verbose prose the parser strips. But the productive
spend is a **band**, not a slope:

| reasoning tokens | outcome |
|------------------|---------|
| 438–1,700 | every chunk that found a moment |
| 7,692 | 0 matches, 142s of body time — 89% of the run's wall clock |
| exhausted | **no answer at all**; the chunk covering `00:16:01–00:18:01` was lost |

Above the band, more thinking bought nothing and cost coverage. That is not
the "cheaper versus better" trade this document forbids taking blind — at the
top of the range it was neither.

**So: budget it, do not disable it.** 2,500 keeps the entire productive band
with headroom. Raise it from a measurement showing matches found above 2,500,
not from the intuition that more thinking must be better.

### The rule: a chunk is never lost to thinking

The chunk that returned no answer is the failure this section exists to
prevent. It was a 200, it was billed, and the two minutes of video it covered
were reported to the user as containing nothing — indistinguishable from the
moment being absent.

Three things now stand between that and a user:

1. **`max_tokens` is the answer budget plus the thinking budget**, not one
   ceiling for both. Providers differ on whether reasoning is charged against
   `max_tokens`; on the ones that charge it, sending the answer budget alone
   hands the model a ceiling it can exhaust before answering.
2. **A blank answer is not "no matches".** `""` parses to zero matches and
   would otherwise be stored as a considered negative result.
3. **An empty answer is retried without thinking** — once, not as a ladder.
   Retrying identically would think its way to the same silence at the same
   price, so the retry has to differ. `chunksAnsweredWithoutThinking` in the
   completion log counts it; anything above zero means the budget is too tight
   for that material.

Both attempts are billed and both are recorded. Usage is now reported before
the answer is validated, because counting only calls that answered understated
the cost of exactly the calls worth knowing about.

The probe in `modelCapabilities` does disable reasoning, and should: it asks
whether a route exists, using a test pattern there is nothing to think about.

### Migrating an existing deployment

`OPENROUTER_VIDEO_MODEL` is optional, and any environment that sets it
explicitly overrides the default above — including with a Qwen3-VL slug that
refuses every video request. Check each environment and either clear the
variable or set it to the model named above. The Railway `worker` service does
not set it, so it takes the default.

The preflight makes a missed environment loud rather than silent: the search
fails immediately naming the configured slug, instead of returning "nothing
matches" as though the video genuinely lacked the moment.

OpenRouter STT remains a separate path that creates reusable timestamped speech.
Mixed searches give the model both the actual MP4 and the chunk-local transcript.
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

Every video request records:

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

### The known-good result

First search that reached the model at all, 2026-08-20 04:12 UTC, clip request
`0623cbe3-79ea-4e94-be2d-14a8dd5c58b5`. Instruction: *find the part where they
show the car that says "bought with investor money"*.

| | |
|---|---|
| Source | 1179.272s, 10 chunks of 120s |
| Mode | `both` (transcript available) |
| Model | `qwen/qwen3.6-flash` via Alibaba, reasoning at model default |
| Matches | **4**, including chunk 0 (`0-121s`) — the window holding `00:54` |
| Failed | 1 — chunk 7 (`841-961s`), provider content filter |
| Cost | **$0.07718**, $0.003927 per source minute |
| Wall clock | **277,408ms** |

**This is the accuracy floor.** Every later change that saves money or time —
a reasoning cap, the retrieval index, fewer frames per second, longer chunks —
must be re-run against this instruction and still return a match covering
`00:54`. A change that loses it is wrong regardless of what it saves, and the
saving is not a reason to keep it.

Note the cost and wall clock were measured before the request timers were
split, so `latencyMs` in that run covered upload and time-to-first-byte only;
generation was invisible. Later runs report `headersMs`, `bodyMs` and
`downloadMs` separately and are not directly comparable on latency, only on
total elapsed. Matches and cost compare cleanly.
