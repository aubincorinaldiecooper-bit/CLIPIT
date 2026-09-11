# CLIPIT — backend

Clipit is a video-understanding and clipping backend. A person uploads a video, asks for a moment in plain language, and Clipit returns grounded moments that can be kept and rendered as vertical 9:16 clips.

## Current architecture

The active retrieval system is:

```text
upload
  → preprocess source and build playback/analysis media
  → transcribe audio
  → SimpleMem indexes the video
  → person asks a question
  → SimpleMem proposes timestamped candidate moments
  → Clipit verifies those candidates against the actual footage
  → final answer is written from grounded evidence
  → Keep renders the selected moment as a vertical clip
```

SimpleMem is memory and retrieval, not final evidence. A SimpleMem candidate must be verified against the actual footage before Clipit treats a visual claim as grounded.

If SimpleMem is unavailable, incomplete, or inconclusive, Clipit can fall back to direct actual-footage search. Missing memory is never treated as proof that something is absent.

The retired upload-time notes/scene-index system and the experimental Media Index runtime are not part of the current architecture.

## Video providers

Actual-footage calls sit behind a provider seam:

- **OpenRouter / Qwen** — the default hosted video-understanding path.
- **MiniCPM-V on Modal** — an optional self-hosted path using Clipit's own GPU deployment.

The two providers are alternatives behind the same footage-reading contract. MiniCPM remains intentionally supported so Clipit can compare or switch providers without changing the retrieval layer.

## SimpleMem

`tools/simplemem/sidecar.py` wraps Omni-SimpleMem and exposes Clipit's internal contract:

- `GET /health`
- `GET /ready`
- `PUT /videos/:videoId`
- `POST /videos/:videoId/query`
- `DELETE /videos/:videoId`

The sidecar preserves timestamped memories, stores durable archives in S3-compatible storage, and restores its local cache when needed.

Important controls:

- `SIMPLEMEM_INDEX_ENABLED=true` indexes videos after preprocessing.
- `RETRIEVAL_PRIMARY=simplemem` makes SimpleMem the first retrieval path.
- `SIMPLEMEM_URL` points at the internal sidecar.
- `SIMPLEMEM_INTERNAL_TOKEN` authenticates internal requests.

## Grounding rule

Clipit does not claim it watched footage when it only saw metadata, search results, embeddings, or memory candidates.

For visual questions:

```text
candidate timestamp
  → open exact source interval
  → configured video model watches the footage
  → only verified result becomes evidence
```

For speech questions, timestamped transcription is separate evidence. Transcript evidence can establish what was said; it does not establish a visual event.

## Media pipeline

Uploads go directly to S3-compatible storage through signed URLs. The worker then:

1. probes the source;
2. creates analysis/playback media and the chunk timeline;
3. transcribes the audio;
4. indexes the video into SimpleMem;
5. answers retrieval jobs;
6. renders selected clips when the person presses Keep.

Preprocessing prefers the single-decode path. A separate-pass FFmpeg path remains as a compatibility fallback when the optimized pass fails.

All newly made or re-rendered deliverables are 9:16 vertical clips.

## Processes

Two Node processes run from the same image:

```bash
npm run start:api
npm run start:worker
```

The API handles HTTP, authentication, signed upload/playback URLs, and request state. The worker handles media processing, transcription, SimpleMem indexing, footage verification, clipping, rendering, retention, and scheduled work.

The SimpleMem sidecar runs separately from `Dockerfile.simplemem`.

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22 + TypeScript |
| API | Fastify |
| Database | PostgreSQL |
| Queues | Redis + BullMQ |
| Media | FFmpeg / FFprobe |
| Storage | S3-compatible object storage |
| Video memory | Omni-SimpleMem |
| Actual-footage understanding | OpenRouter/Qwen or MiniCPM-V on Modal |
| Speech-to-text | OpenRouter Whisper |

## Local development

Requires Node 22, PostgreSQL, Redis, FFmpeg/FFprobe, an S3-compatible bucket, and an OpenRouter key for model-backed features.

```bash
npm install
cp .env.example .env
npm run migrate:dev
npm run dev:api
npm run dev:worker
```

Validation:

```bash
npm run typecheck
npm test
```

Migrations run on process startup as well.

## Core API shape

```text
POST   /api/sessions
POST   /api/videos
POST   /api/videos/upload-url
POST   /api/videos/:videoId/uploaded
GET    /api/videos/:videoId
POST   /api/videos/:videoId/clip-requests
GET    /api/clip-requests/:requestId
POST   /api/clip-requests/:requestId/generate
GET    /api/clips/:clipId
GET    /health
```

The exact request/response schemas live in the route code and serializers; this README intentionally describes the current product architecture rather than duplicating every API field.

## Product invariants

- The person's instruction is the search; there are no fixed clip categories.
- Search metadata is never evidence.
- SimpleMem proposes; actual footage verifies.
- Unexamined footage is never reported as absent.
- Model output is validated before persistence.
- Credentials and signed media URLs remain server-side.
- Every new deliverable is vertical.
