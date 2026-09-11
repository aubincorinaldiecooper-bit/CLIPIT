"""Clipit's HTTP boundary around upstream Omni-SimpleMem.

The upstream library owns memory construction and retrieval. This service owns
only the product contract upstream does not provide:

* one isolated memory namespace per Clipit video;
* durable mapping from a frame memory back to source seconds (upstream computes
  the timestamp while extracting the frame, then drops it);
* stable HTTP shapes that the TypeScript worker validates before trusting;
* replace/delete semantics that line up with Clipit's footage retention.

A search result from this service is still only a candidate. Clipit verifies the
candidate against actual footage before it can become user-facing evidence.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

import simplemem
from simplemem import create
from simplemem.multimodal.core.config import OmniMemoryConfig


DATA_ROOT = Path(os.environ.get("SIMPLEMEM_DATA_DIR", "/data/simplemem")).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)
TIMELINE_FILE = "clipit_timeline.json"

# The worker intentionally indexes one video at a time. Serializing sidecar
# operations keeps upstream model/store objects from competing for RAM and
# prevents a query from opening a half-written per-video index.
operation_lock = asyncio.Lock()

app = FastAPI(title="Clipit Omni-SimpleMem", version="1")


class QueryBody(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=20, ge=1, le=200)


def _safe_video_id(value: str) -> str:
    """Allow opaque ids without allowing them to become filesystem paths."""
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 128:
        raise HTTPException(status_code=400, detail="invalid video id")
    if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in cleaned):
        raise HTTPException(status_code=400, detail="invalid video id")
    return cleaned


def _video_dir(video_id: str) -> Path:
    return DATA_ROOT / _safe_video_id(video_id)


def _config() -> OmniMemoryConfig:
    """Build the upstream config explicitly so /health reports what will run."""
    config = OmniMemoryConfig()

    api_key = os.environ.get("SIMPLEMEM_API_KEY") or os.environ.get("OPENAI_API_KEY")
    api_base = os.environ.get("SIMPLEMEM_API_BASE") or os.environ.get("OPENAI_API_BASE")
    if api_key:
        config.llm.api_key = api_key
    if api_base:
        config.llm.api_base_url = api_base

    # Defaults remain upstream-compatible; deployment can point these at the
    # same OpenAI-compatible provider Clipit already uses without code changes.
    config.llm.caption_model = os.environ.get("SIMPLEMEM_CAPTION_MODEL", config.llm.caption_model)
    config.llm.summary_model = os.environ.get("SIMPLEMEM_SUMMARY_MODEL", config.llm.summary_model)
    config.llm.query_model = os.environ.get("SIMPLEMEM_QUERY_MODEL", config.llm.query_model)
    config.llm.whisper_model = os.environ.get("SIMPLEMEM_TRANSCRIPTION_MODEL", config.llm.whisper_model)

    # Keep the embedding model name in the upstream-supported form. The
    # upstream EmbeddingService understands the bare OpenAI model identifiers
    # and otherwise falls back to a local sentence-transformer.
    config.embedding.model_name = os.environ.get("SIMPLEMEM_TEXT_EMBED_MODEL", config.embedding.model_name)
    config.embedding.visual_embedding_model = os.environ.get(
        "SIMPLEMEM_VISUAL_MODEL", config.embedding.visual_embedding_model
    )
    config.entropy_trigger.visual_model_name = config.embedding.visual_embedding_model
    return config


def _models(config: OmniMemoryConfig) -> dict[str, str]:
    return {
        "caption": config.llm.caption_model,
        "visual": config.embedding.visual_embedding_model,
        "text_embedding": config.embedding.model_name,
        "transcription": config.llm.whisper_model,
    }


def _timeline_path(video_dir: Path) -> Path:
    return video_dir / TIMELINE_FILE


def _write_timeline(video_dir: Path, payload: dict[str, Any]) -> None:
    target = _timeline_path(video_dir)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)


def _read_timeline(video_dir: Path) -> dict[str, Any]:
    target = _timeline_path(video_dir)
    if not target.exists():
        raise HTTPException(status_code=409, detail="video memory has no Clipit timeline metadata")
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="video timeline metadata is unreadable") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("frames"), dict):
        raise HTTPException(status_code=500, detail="video timeline metadata is invalid")
    return raw


def _open_memory(video_dir: Path):
    return create(mode="omni", config=_config(), data_dir=str(video_dir))


def _modality(item: dict[str, Any]) -> str:
    value = item.get("modality_type") or item.get("modality") or "text"
    value = str(value).lower()
    allowed = {"text", "visual", "audio", "video", "multimodal"}
    return value if value in allowed else "text"


def _index_sync(video_id: str, source: Path, fps: float, max_frames: int, duration_seconds: float) -> dict[str, Any]:
    started = time.perf_counter()
    final_dir = _video_dir(video_id)
    backup_dir = final_dir.with_name(f"{final_dir.name}.previous")

    if backup_dir.exists():
        shutil.rmtree(backup_dir, ignore_errors=True)
    if final_dir.exists():
        final_dir.replace(backup_dir)
    final_dir.mkdir(parents=True, exist_ok=True)

    memory = None
    try:
        memory = _open_memory(final_dir)
        # add_video exposes max_frames but not fps; the processor's public fps
        # setting is the sampling clock upstream itself uses to derive frame
        # indices. Clipit persists the same clock below rather than inventing a
        # second timeline.
        memory.video_processor.fps = fps
        result = memory.add_video(
            str(source),
            session_id=f"clipit:{video_id}",
            tags=[f"clipit_video:{video_id}"],
            max_frames=max_frames,
        )
        if not result.success or result.mau is None:
            raise RuntimeError(result.error or "Omni-SimpleMem did not create a video memory")

        metadata = result.metadata or {}
        frame_maus = metadata.get("frame_maus") or []
        frames: dict[str, dict[str, float | int]] = {}

        # Upstream currently saves frame_index but discards the `idx / fps`
        # timestamp it computed during extraction. Recreate exactly that value,
        # keyed by MAU id, and keep it beside the upstream store.
        for frame in frame_maus:
            frame_id = str(getattr(frame, "id", "") or "")
            frame_meta = getattr(frame, "metadata", None)
            frame_index = getattr(frame_meta, "frame_index", None) if frame_meta is not None else None
            if not frame_id or not isinstance(frame_index, int) or frame_index < 0:
                continue
            frames[frame_id] = {
                "frameIndex": frame_index,
                "seconds": frame_index / fps,
            }

        processed = int(metadata.get("frames_processed") or len(frame_maus))
        skipped = int(metadata.get("frames_skipped") or 0)
        extracted = max(0, processed + skipped)
        covered = min(duration_seconds, extracted / fps) if extracted else 0.0

        _write_timeline(
            final_dir,
            {
                "schemaVersion": 1,
                "videoId": video_id,
                "fps": fps,
                "durationSeconds": duration_seconds,
                "framesExtracted": extracted,
                "framesProcessed": processed,
                "framesSkipped": skipped,
                "frames": frames,
            },
        )

        # close() flushes upstream vector stores; the sidecar does not claim a
        # video is ready until that durable write has completed.
        memory.close()
        memory = None
        shutil.rmtree(backup_dir, ignore_errors=True)

        return {
            "videoMauId": str(result.mau.id),
            "fps": fps,
            "framesExtracted": extracted,
            "framesProcessed": processed,
            "framesSkipped": skipped,
            "coveredThroughSeconds": covered,
            "audioTranscribed": metadata.get("audio_mau") is not None,
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }
    except Exception:
        if memory is not None:
            try:
                memory.close()
            except Exception:
                pass
        shutil.rmtree(final_dir, ignore_errors=True)
        if backup_dir.exists():
            backup_dir.replace(final_dir)
        raise


def _query_sync(video_id: str, question: str, top_k: int) -> dict[str, Any]:
    started = time.perf_counter()
    video_dir = _video_dir(video_id)
    if not video_dir.exists():
        raise HTTPException(status_code=404, detail="video memory not found")

    timeline = _read_timeline(video_dir)
    frame_map = timeline["frames"]
    memory = _open_memory(video_dir)
    try:
        result = memory.query(question, top_k=top_k)
        items = []
        for row in result.items:
            if not isinstance(row, dict):
                continue
            mau_id = str(row.get("id") or "")
            if not mau_id:
                continue
            mapped = frame_map.get(mau_id)
            score = row.get("score", 0.0)
            try:
                score = float(score)
            except (TypeError, ValueError):
                score = 0.0
            items.append(
                {
                    "mauId": mau_id,
                    "modality": _modality(row),
                    "score": score,
                    "summary": str(row.get("summary") or "")[:500],
                    "frameIndex": mapped.get("frameIndex") if isinstance(mapped, dict) else None,
                    "seconds": mapped.get("seconds") if isinstance(mapped, dict) else None,
                }
            )
        return {
            "items": items,
            "totalCandidates": int(getattr(result, "total_candidates", len(items)) or len(items)),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }
    finally:
        memory.close()


def _delete_sync(video_id: str) -> None:
    video_dir = _video_dir(video_id)
    shutil.rmtree(video_dir, ignore_errors=True)
    shutil.rmtree(video_dir.with_name(f"{video_dir.name}.previous"), ignore_errors=True)


@app.get("/health")
async def health() -> dict[str, Any]:
    config = _config()
    return {"ok": True, "models": _models(config), "version": simplemem.__version__}


@app.put("/videos/{video_id}")
async def index_video(
    video_id: str,
    file: UploadFile = File(...),
    fps: float = Form(..., gt=0, le=2),
    max_frames: int = Form(..., ge=1, le=200_000),
    duration_seconds: float = Form(..., gt=0),
) -> dict[str, Any]:
    _safe_video_id(video_id)
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    fd, raw_path = tempfile.mkstemp(prefix="clipit-simplemem-", suffix=suffix)
    os.close(fd)
    temp_path = Path(raw_path)
    try:
        with temp_path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                output.write(chunk)
        async with operation_lock:
            return await asyncio.to_thread(
                _index_sync, video_id, temp_path, float(fps), int(max_frames), float(duration_seconds)
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SimpleMem indexing failed: {type(exc).__name__}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/videos/{video_id}/query")
async def query_video(video_id: str, body: QueryBody) -> dict[str, Any]:
    _safe_video_id(video_id)
    async with operation_lock:
        try:
            return await asyncio.to_thread(_query_sync, video_id, body.query.strip(), body.top_k)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"SimpleMem query failed: {type(exc).__name__}") from exc


@app.delete("/videos/{video_id}")
async def delete_video(video_id: str) -> dict[str, bool]:
    _safe_video_id(video_id)
    async with operation_lock:
        await asyncio.to_thread(_delete_sync, video_id)
    return {"ok": True}
