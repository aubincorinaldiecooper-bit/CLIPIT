# CLIPIT — backend

Clipit is a video-understanding backend. A person uploads a video, asks about what happened in plain language, and Clipit returns grounded moments and answers. The clip-production system is retained but dormant for the current MVP.

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
- `RETRIEVAL_PRIMARY=videochat3` (the default) reads an uploaded video the way an internet video is read: VideoChat3 watches the analysis proxy for the question, Qwen embeddings and the Qwen reranker order what it flagged, and VideoChat3 re-opens each candidate before it becomes evidence. When uploads are indexed, SimpleMem is asked first and a hit goes through the same verification; a miss is not an answer, so the footage is watched. The direct per-chunk footage search runs only for questions about speech (the watcher has no sound); a failed VideoChat3 read completes the request with the video on record as unexamined rather than re-reading it chunk by chunk. Needs `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` on the worker.
- `RETRIEVAL_PRIMARY=simplemem` makes SimpleMem the first retrieval path, with the per-chunk footage search as the fallback.
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
6. leaves clip production dormant unless it is explicitly re-enabled.

Preprocessing prefers the single-decode path. A separate-pass FFmpeg path remains as a compatibility fallback when the optimized pass fails.

All newly made or re-rendered deliverables are 9:16 vertical clips.

## Clip production

Clip production is retained in the repository but **dormant for the current MVP**. `VERTICAL_CLIP_PIPELINE_ENABLED=false` prevents new Keep/generate and caption-render work from entering the production queue. Existing read-only clip/library behavior can remain available while the MVP focuses on video search and understanding.

When deliberately re-enabled later, produced clips remain 9:16. MiniCPM stays available as an optional framing/video provider.

## Processes

Two Node processes run from the same image:

```bash
npm run start:api
npm run start:worker
```

The API handles HTTP, authentication, signed upload/playback URLs, and request state. The worker handles media processing, transcription, SimpleMem indexing, footage verification, retention, and scheduled work. Clip rendering code is retained but dormant for the MVP.

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
