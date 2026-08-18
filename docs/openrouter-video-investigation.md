# OpenRouter production video investigation

Status: **architecture decision / benchmark gate**, reviewed 2026-08-18.

## Decision

- Production video understanding and STT are **OpenRouter-first**.
- Use `google/gemini-2.5-flash` as the first production video-understanding
  candidate. It is the model used in OpenRouter's own video-input examples and
  gives the best initial balance of native video support, context, price, and
  speed. Pinning a model is not enough: provider routing must also select a
  route that accepts the chosen media representation.
- Keep the existing MiniCPM path only as a shadow/background benchmark. The
  shared public credential used by `api.modelbest.cn` is not a production
  dependency and must not be used as a failover.
- Keep OpenRouter STT separate from visual understanding. Captions remain the
  first choice and OpenRouter Whisper remains the fallback. A video model's
  narration is not a replacement for a timestamped transcript.

This selects the candidate to test, not a claim that the current MiniCPM search
client has already been migrated. Production cutover is gated by the empirical
checks below.

## What OpenRouter supports

OpenRouter's chat-completions schema accepts an actual video as a
`video_url` content part. Despite the name, its `url` may contain either an
HTTP(S) URL or a `data:video/mp4;base64,...` URL. The documented formats are
MP4, MPEG, MOV, and WebM. Model discovery must confirm that
`input_modalities` contains `video`.

The important constraint is the provider behind OpenRouter. OpenRouter
documents that Google AI Studio accepts only YouTube URLs and that Google's
Vertex route does not accept video URLs. Therefore an arbitrary presigned
Railway/S3 MP4 URL is **not a portable production input for the selected
Gemini model**. Treat base64 as the required transport for private Railway
chunks. A presigned URL may be evaluated only as a route-specific optimization
after a probe proves it works; it must have a base64 fallback and must never be
made public merely to satisfy a provider.

Example request shape:

```json
{
  "model": "google/gemini-2.5-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Return matching ranges as JSON." },
      {
        "type": "video_url",
        "video_url": { "url": "data:video/mp4;base64,AAAA..." }
      }
    ]
  }]
}
```

Primary references:

- [OpenRouter video-input guide](https://openrouter.ai/docs/guides/overview/multimodal/videos)
- [OpenRouter model discovery](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt)
- [OpenRouter Gemini 2.5 Flash model and current pricing](https://openrouter.ai/google/gemini-2.5-flash)
- [Google Gemini video-understanding limits and sampling](https://ai.google.dev/gemini-api/docs/video-understanding)

## Limits and operational envelope

OpenRouter does not publish one universal video duration or file-size limit;
the effective limit is route/model/provider-specific. Its guidance explicitly
says to inspect model-specific limits and split long videos. Consequently, a
Gemini upstream limit is not an OpenRouter service-level guarantee.

For CLIPIT, retain chunked analysis and establish a deliberately smaller,
measured envelope:

| Item | Initial production posture |
| --- | --- |
| Input | Actual H.264 MP4 analysis chunk, no audio; transcript supplied as text when needed |
| Transport | Base64 data URL by default (about 4/3 the binary size) |
| Duration | Start at 2 minutes; test 2, 5, and 10 minutes before retaining today's 10-minute grid |
| Binary size | Target at most 18 MiB until the routed provider's accepted request size is proven |
| Context | Reject or re-chunk based on measured `usage.prompt_tokens`, not nominal context alone |
| Output | Existing strict JSON match schema; small output token cap |

The proxy must be re-chunked when either duration **or encoded bytes** exceeds
the validated envelope. Duration alone is insufficient because bitrate varies
with the scene, and JSON base64 adds roughly 33% before HTTP overhead.

Google's native Gemini documentation is useful for estimating video token
volume, but it still needs verification through OpenRouter usage records. At
the commonly documented default sampling rate, budget roughly 300 video tokens
per second (about 18,000/minute); a low-media-resolution mode is roughly 100
tokens per second where the routed API supports it. These are planning values,
not hard limits.

## Timestamp quality

Native video input removes the several-second blind spots caused by sending
only sampled stills, but model-produced timestamps are not frame-accurate.
Gemini's video understanding samples temporally and is prompted using
`MM:SS`-style locations. Expect second-scale grounding at best and do not
promise exact edit points without measurement.

The production prompt should request chunk-local seconds in the existing JSON
schema. Continue to clamp/map results through `src/services/timestamps.ts` and
add edit handles. Evaluate timestamp quality against human-labelled events:

- median and p95 absolute start/end error;
- intersection-over-union of predicted and labelled ranges;
- recall for events shorter than 1, 2, and 5 seconds;
- drift at the beginning, middle, and end of 2/5/10-minute chunks;
- spoken-only, visual-only, and audiovisual instructions separately.

Cutover target: at least the current frame pipeline's recall, median boundary
error no worse than 2 seconds, and p95 no worse than 5 seconds on the agreed
fixture set. These are product acceptance criteria, not vendor guarantees.

## Cost and latency

At the published `google/gemini-2.5-flash` input price of $0.30 per million
tokens, a planning estimate is:

- default video resolution: 18,000 tokens/minute, about **$0.0054/minute**;
- low media resolution: 6,000 tokens/minute, about **$0.0018/minute**;
- a 10-minute chunk: about **$0.054** default or **$0.018** low resolution,
  plus transcript input and output tokens.

Prices and tokenization can change, so deployment must read current model
metadata and record OpenRouter's actual `usage.cost`. Do not turn these
estimates into fixed billing logic.

There is no defensible latency number without authenticated probes on the same
route and media sizes production will use. Capture upload time, time to first
token, total latency, provider name, retries, media bytes, duration, token
usage, and cost. Report p50/p95 for 2/5/10-minute chunks at concurrency 1 and
the intended worker concurrency. Base64 upload time is part of user latency.

## Benchmark and cutover checklist

1. Query OpenRouter model metadata at deploy/test time and fail closed if the
   selected model no longer advertises video input.
2. Run the same labelled MP4 fixtures through Gemini actual-video input, the
   current sampled-frame implementation, and MiniCPM shadow mode.
3. Probe base64 at increasing byte sizes. Separately probe a short-lived
   presigned Railway URL against each eligible provider route; never infer URL
   support from a successful YouTube request.
4. Measure timestamp metrics, recall, malformed-response rate, cost, and
   latency. Include silent video, variable frame rate, scene cuts, on-screen
   text, and sub-two-second events.
5. Choose a validated chunk duration/byte ceiling and implement automatic
   byte-aware re-chunking before switching the production search client.
6. Keep MiniCPM calls asynchronous and non-authoritative after cutover; shadow
   failures must never affect a user request.

## Rejected directions

- **`api.modelbest.cn` as production or failover:** rejected because its shared
  public key is not reliable production infrastructure.
- **Presigned Railway URL as the only transport:** rejected because the chosen
  Google routes do not generally accept arbitrary video URLs.
- **Whole multi-hour source in one request:** rejected on reliability, cost,
  latency, and timestamp-quality grounds even if a provider advertises a large
  nominal context window.
- **Replacing STT with video-model audio understanding:** rejected because the
  clipping pipeline needs reusable, auditable segment timestamps.
