# CLIPIT — backend

User-directed AI video clipping. Give it a long video, describe the moment you
want in plain language, and get back playable MP4 clips.

```
upload / YouTube URL
  → ingest
  → preprocess (probe, proxy, configurable 2-minute analysis chunks)
  → transcribe (once, over the whole source)
  → user enters a clip instruction
  → Qwen3-VL 32B searches each actual MP4 chunk (video and/or transcript)
  → map chunk-local timestamps to source timestamps
  → FFmpeg cuts the clips from the original
  → playable signed URLs
```

The instruction is entirely the user's. There are no predefined clip
categories anywhere in the codebase — "clip every time I score", "find the part
where I explain why I left", and "clip the boss fight" all take the same path.

---

## Stack

| Concern | Choice |
| --- | --- |
| Runtime | Node.js 22, TypeScript (ESM) |
| API | Fastify 5 |
| Database | PostgreSQL |
| Queues | Redis + BullMQ |
| Media | FFmpeg / FFprobe, yt-dlp |
| Storage | S3-compatible adapter (Railway bucket, S3, R2, MinIO) |
| Video understanding | OpenRouter (`qwen/qwen3-vl-32b-instruct`), actual MP4 chunks |
| Speech-to-text | OpenRouter (`openai/whisper-1`), YouTube captions preferred |

Visual and mixed searches send each actual MP4 analysis chunk to one production
model, Qwen3-VL 32B through OpenRouter. There is no fallback model, routing
cascade, scene-index summary, or sampled-frame primary search stage. OpenRouter
STT remains separate for timestamped speech.

The provider decision and functional acceptance case are recorded in
[`docs/openrouter-video-investigation.md`](docs/openrouter-video-investigation.md).

Two processes run from one image:

```bash
npm run start:api      # HTTP only — no media work happens here
npm run start:worker   # ingestion, preprocessing, transcription, search, clip cutting
```

---

## How the search works

A six-hour VOD is never sent to the model in one request. Preprocessing cuts a
low-resolution **analysis proxy** into fixed **analysis chunks**
(`ANALYSIS_CHUNK_SECONDS`, default 120s), each stored with its global start and
end. A search fans out over those chunks.

Each chunk is searched with one or both kinds of evidence:

- **Video** — the actual H.264 MP4 analysis chunk, sent to Qwen3-VL 32B as a
  base64 video data URL so actions, OCR, and temporal context remain available.
- **Transcript** — the slice of the video's transcript covering that chunk,
  rebased to chunk-local time.

Once every chunk has been searched, matches describing the same moment are
merged — whether they are duplicate detections inside one chunk or the two
halves of a moment split across a chunk boundary. See
`src/services/search/aggregateMatches.ts`.

Which one is used comes from the instruction itself
(`src/services/search/instructionMode.ts`): "explain", "mentions", "why" and
friends route to the transcript; "score", "boss fight", "on screen" route to
video; anything ambiguous searches both. Callers can override it per request
with `mode`, and the resolved choice is returned as `resolvedMode`.

If no transcript is available, a spoken-word search degrades to visual rather
than failing.

### Timestamp mapping

The model only ever sees one chunk and reports seconds relative to that chunk.
All conversion happens in `src/services/timestamps.ts`:

```
global_start = chunk_global_start + local_start
global_end   = chunk_global_start + local_end
```

That module also handles what model output actually looks like in practice —
reversed ranges, negative starts, timestamps past the end of the chunk,
zero-length matches, absurdly long matches — and is covered by 36 unit tests.

### Transcription

Audio is extracted **once** from the full source and transcribed in a single
pass; the analysis chunk grid is never used as the transcription unit. The
extracted audio is split into `TRANSCRIBE_SEGMENT_SECONDS` pieces only to
respect the STT request-size limit, and each piece's offset is added back so
every stored timestamp is global.

For YouTube sources, creator or automatic captions are downloaded by yt-dlp in
the same pass as the video and used when present; OpenRouter STT is the
fallback. Rolling auto-captions ("hello" / "hello everyone" / "hello everyone
welcome") are de-duplicated word-by-word before storage.

---

## Local development

Requires Node 22, PostgreSQL, Redis, `ffmpeg`, `ffprobe`, and `yt-dlp` on PATH,
plus an S3-compatible bucket (MinIO works).

```bash
npm install
cp .env.example .env      # fill in the credentials
npm run migrate:dev       # or let either process migrate on boot

npm run dev:api           # terminal 1
npm run dev:worker        # terminal 2

npm test                  # unit tests, no services required
npm run typecheck
```

Migrations run automatically when the API or worker starts, so a fresh deploy
is usable without a manual step.

---

## API

All `/api` routes require a session token except `POST /api/sessions`.
`GET /health` is open.

```
POST   /api/sessions                        issue an anonymous session token
GET    /api/sessions/current                who am I

POST   /api/videos                          create from YouTube URL, or reserve an upload
POST   /api/videos/upload-url               issue / reissue a presigned upload URL
POST   /api/videos/:videoId/uploaded        signal that the upload finished
GET    /api/videos/:videoId                 status, metadata, chunk grid

POST   /api/videos/:videoId/clip-requests   start a search
GET    /api/clip-requests/:requestId        search status, progress, matches

POST   /api/clip-requests/:requestId/generate   render matches into clips

GET    /api/clips/:clipId                   clip status + signed playback URL
GET    /health                              liveness + dependency checks
```

### Walkthrough

**1. Get a session token.** Store it; it is returned once.

```bash
curl -sX POST $API/api/sessions
# { "token": "…", "tokenType": "Bearer", "sessionId": "…", "expiresAt": "…" }
```

Send it on everything below as `-H "Authorization: Bearer $TOKEN"`.

**2a. YouTube source.**

```bash
curl -sX POST $API/api/videos -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sourceType":"youtube","url":"https://youtube.com/watch?v=..."}'
```

**2b. Upload source.** The response carries a presigned `PUT` URL — the file
goes straight to storage and never passes through the API server.

```bash
curl -sX POST $API/api/videos -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"sourceType":"upload","filename":"stream.mp4"}'
# { "video": { "id": "…" }, "upload": { "method": "PUT", "url": "https://…", "headers": {…} } }

curl -X PUT "$UPLOAD_URL" -H 'Content-Type: video/mp4' --upload-file stream.mp4

curl -sX POST $API/api/videos/$VIDEO_ID/uploaded -H "Authorization: Bearer $TOKEN"
```

`/uploaded` verifies the object is really in storage before queueing, and is
idempotent — calling it again once the pipeline has started just reports
current state. It is the only way an upload enters the pipeline; reading
`GET /api/videos/:videoId` has no side effects.

**3. Wait for preprocessing.** Poll until `status` is `ready`.

```bash
curl -s $API/api/videos/$VIDEO_ID -H "Authorization: Bearer $TOKEN"
# { "video": { "status": "preprocessing",
#              "progress": { "stage": "preprocessing", "percent": 60, "message": "…" },
#              "transcript": { "status": "running", … }, … } }
```

`status: ready` means searchable. The transcript reports separately — a search
that needs it waits up to `TRANSCRIPT_WAIT_TIMEOUT_MS` and then proceeds
visually.

**4. Search with any instruction.**

```bash
curl -sX POST $API/api/videos/$VIDEO_ID/clip-requests -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"instruction":"Find every time I beat the boss."}'
# 202 { "clipRequest": { "id": "…", "status": "pending" } }
```

Optional `"mode"`: `auto` (default), `visual`, `transcript`, `both`.

**5. Read the matches.**

```bash
curl -s $API/api/clip-requests/$REQUEST_ID -H "Authorization: Bearer $TOKEN"
```

```json
{
  "clipRequest": {
    "status": "completed",
    "resolvedMode": "visual",
    "progress": { "percent": 100, "chunksTotal": 6, "chunksCompleted": 6, "chunksFailed": 0 },
    "failedChunks": [],
    "matches": [
      {
        "id": "…",
        "startSeconds": 1842.5,
        "endSeconds": 1878.2,
        "startTimecode": "00:30:42",
        "description": "The requested event occurs here.",
        "confidence": 0.91,
        "source": "visual",
        "clip": null
      }
    ]
  }
}
```

Timestamps are already source-global. A chunk that fails to search is listed in
`failedChunks` and does not fail the request.

**6. Generate clips.** Omit `matchIds` to render every match.

```bash
curl -sX POST $API/api/clip-requests/$REQUEST_ID/generate -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"matchIds":["<match-id>"]}'
# 202 { "clips": [ { "id": "…", "status": "pending" } ] }
```

**7. Play it.**

```bash
curl -s $API/api/clips/$CLIP_ID -H "Authorization: Bearer $TOKEN"
# { "clip": { "status": "ready", "url": "https://…signed…", "urlExpiresAt": "…" } }
```

Clips are cut from the **original** source (never the proxy) as MP4 / H.264 /
AAC with `+faststart`.

### Errors

```json
{ "error": { "code": "conflict", "message": "Video is not ready for search yet (status: preprocessing)" } }
```

`400` validation · `401` missing/expired token · `404` unknown or not yours ·
`409` wrong state · `422` nothing to generate · `429` rate limited ·
`502` a dependency (storage, model) is unreachable, named in the message.

---

## Auth and abuse control

`POST /api/sessions` mints an anonymous bearer token; only its SHA-256 hash is
stored. Resources are owned by the session that created them, and another
session gets `404` (not `403`) so ids cannot be probed.

The session layer is deliberately thin: requests carry a `Principal`
(`sessionId` plus a reserved `userId`), and every row has both columns. Adding
real accounts means populating `userId` — no route logic changes.

Redis-backed fixed-window limits apply **per session and per IP** to session
creation, video creation, searches, generation, and reads. Per-IP matters
because anonymous sessions are free to mint.

Provider credentials (OpenRouter, storage, database) are read only in
the server process and are never returned by any endpoint.

---

## Background jobs

| Queue | Work |
| --- | --- |
| `video-ingestion` | confirm the upload, or download with yt-dlp (+ captions) |
| `video-preprocessing` | ffprobe, build the proxy, cut analysis chunks |
| `video-transcription` | parse captions, or extract audio once and run STT |
| `clip-search` | fan out over chunks, call Qwen with actual MP4s, store matches |
| `clip-generation` | cut the clip from the original, upload, sign |

All long-running work happens in the worker. Job IDs are derived from the row
they act on, so a duplicate enqueue collapses into the existing job. Real
progress is written to both the job and the database and is exposed on
`GET /api/videos/:id` and `GET /api/clip-requests/:id`.

`OPENROUTER_VIDEO_CONCURRENCY` is enforced by a process-wide semaphore, so it holds
regardless of how many searches run at once.

---

## Storage layout

```
originals/<videoId>/<filename>        source media (+ captions.vtt for YouTube)
proxies/<videoId>/proxy.mp4           analysis proxy
proxies/<videoId>/chunks/0000.mp4     analysis chunks
clips/<videoId>/<clipId>.mp4          generated clips
```

`/tmp` (`WORK_DIR`) is used only for transient ffmpeg / yt-dlp work and is
always cleaned up; nothing durable lives there.

---

## Railway deployment

Deploy **one image, two services**, plus Postgres, Redis, and a bucket. Nothing
here provisions Railway resources — create them in the dashboard.

**1. Postgres and Redis.** Add both from the Railway dashboard.

**2. Bucket.** Add a Railway Storage Bucket (or bring your own S3/R2) and copy
its credentials into `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_ENDPOINT_URL`, `AWS_REGION`, `BUCKET_NAME`.

Uploads go **browser → bucket**, bypassing the API, which makes them a
cross-origin request. A bucket with no CORS rule blocks them before a single
byte is sent, and — because no response is ever received — the browser reports
no status code, only a generic error. The API therefore applies the rule itself
on boot, from `BUCKET_CORS_ORIGINS` (defaulting to `API_CORS_ORIGIN`).

This is deliberately non-fatal: if the credentials can write objects but not
bucket policy, the API still starts and logs

```
could not configure bucket CORS — browser uploads will fail with no status
code until this is set manually
```

in which case set the policy yourself, allowing `PUT`, `GET`, `HEAD` from the
frontend's origin. Set `BUCKET_CORS_AUTOCONFIGURE=false` to opt out entirely.

**3. API service.** Point it at this repo; the `Dockerfile` is detected
automatically.

- Start command: `npm run start:api`
- Health check path: `/health`

**4. Worker service.** Same repo, same Dockerfile, no domain and no health
check.

- Start command: `npm run start:worker`

**5. Variables.** Set the same set on both services. Use references for the
managed ones:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DATABASE_SSL=true

AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
AWS_ENDPOINT_URL=…
AWS_REGION=…
BUCKET_NAME=…

OPENROUTER_API_KEY=…

MAX_SOURCE_DURATION_SECONDS=21600
ANALYSIS_CHUNK_SECONDS=120
OPENROUTER_VIDEO_CONCURRENCY=2
```

`PORT` is injected by Railway. Everything else has a working default — see
`.env.example`.

Both processes validate their configuration at startup and exit with a readable
message listing exactly what is missing, rather than failing on the first job.

**Sizing.** The worker does all the transcoding; give it more CPU and memory
than the API. `MAX_SOURCE_DURATION_SECONDS=21600` (6 hours) means a single job
can pull a very large file into `/tmp`, so keep disk headroom in mind when
raising it.

---

## YouTube ingestion on a hosted platform

Expect this ingestion failure on any cloud host, including Railway:

```
ERROR: [youtube] <id>: Sign in to confirm you're not a bot.
       Use --cookies-from-browser or --cookies for the authentication.
```

Nothing is wrong with yt-dlp — it ran, and YouTube refused it. The request
egresses from a shared datacenter IP that a great many other containers also
use, and YouTube challenges those addresses by default. The same URL downloads
fine from a laptop and fails from the server. No alternative downloader avoids
it, because the block is on the address, not the client.

Getting YouTube working from a server takes three separate things. The image
ships the first two; the third is deployment configuration.

### 1. A current yt-dlp

YouTube changes deliberately and often, and breaks old versions in the process.
`YTDLP_VERSION` in the `Dockerfile` is expected to move regularly — a yt-dlp
more than a few months old fails for reasons fixed upstream long ago. This is
the cheapest thing to check first and the most often overlooked.

### 2. A JavaScript runtime, plus `yt-dlp-ejs`

YouTube protects its format URLs with JavaScript signature challenges. Solving
them needs a real JS engine *and* the `yt-dlp-ejs` components — which the
official standalone executable bundles but a `pip` install does not. yt-dlp
will not use a runtime it was not explicitly told about, so the worker always
passes `--js-runtimes` from `YTDLP_JS_RUNTIMES` (default `node`, always present
in this Node-based image). Without this, extraction fails no matter what else
is configured. Verify with:

```
yt-dlp --verbose --js-runtimes node --simulate 2>&1 | grep -E 'JS runtimes|ejs'
# [debug] Optional libraries: …, yt_dlp_ejs-0.8.0
# [debug] JS runtimes: node-22.22.2
```

The image build asserts both, so a regression fails the build rather than every
YouTube job.

### 3. A PO-token provider — the actual bot-check remedy

YouTube demands a Proof-of-Origin token from addresses it has flagged. Minting
one requires running YouTube's own attestation JavaScript, which is what
[bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
does; its stated purpose is to "bypass the 'Sign in to confirm you're not a
bot' message when invoking yt-dlp from an IP address flagged by YouTube". The
yt-dlp plugin is installed in the image and does nothing until you run the
provider and point the worker at it:

1. Deploy `brainicism/bgutil-ytdlp-pot-provider` as its own service. It listens
   on **4416** and needs no variables, no volume, and no public domain.
2. On the **worker**, set
   `YTDLP_POT_BASE_URL=http://<provider-service>.railway.internal:4416`.

Keep the provider image and the `bgutil-ytdlp-pot-provider` pip package roughly
in step; they are versioned together.

### If that still is not enough

Two fallbacks, in order:

**Cookies.** Export a jar for `youtube.com` from a logged-in browser in
Netscape format and set `YTDLP_COOKIES_FILE` (a path) or `YTDLP_COOKIES_CONTENT`
(the contents, written to `WORK_DIR` at startup — the inline form is what a
container without a persistent disk needs). These are live session credentials:
use a throwaway Google account, treat the variable as a secret, and expect to
refresh it when the bot check returns.

**A residential address.** `YTDLP_PROXY` routes yt-dlp's traffic only — not the
rest of the pipeline — through an `http(s)` or `socks5://` proxy. The block is
on the source IP, so this addresses the cause directly. Self-hosting an exit on
a home connection works as well as a paid pool.

`YTDLP_EXTRACTOR_ARGS=youtube:player_client=android` is worth one attempt, but
do not treat it as a fix.

### What the failure looks like now

A bot check is raised as a non-retryable `ExternalServiceError`, so the worker
fails the job on the first attempt instead of spending its retry budget on an
answer that will not change. The video's `errorMessage` lists the remedies you
have *not* yet configured, so it gets shorter as you work through the list.

**Uploads bypass all of this.** If the goal is to exercise the pipeline rather
than YouTube specifically, upload a file and skip this section entirely.

---

## Known limitations

- Visual search depends on the routed OpenRouter provider accepting the actual
  base64 MP4 payload. Chunk duration is configurable and defaults to two
  minutes; payload size and provider limits require production observation.
- Aggregation merges matches that overlap substantially or sit within
  `MATCH_MERGE_GAP_SECONDS` of each other, so a moment split across a chunk
  boundary is reported once. A merged match is anchored to the chunk of its
  earliest contributor, so when it spans a boundary its *local* timestamps
  extend past that chunk's end. Clips are always cut from the global range.
- Live streams are rejected; the VOD must have ended.
- YouTube ingestion from a datacenter IP generally requires cookies — see
  [YouTube ingestion on a hosted platform](#youtube-ingestion-on-a-hosted-platform).
  Uploads are unaffected.
- Clip generation re-downloads the original per clip, so generating many clips
  from one video repeats that download.
