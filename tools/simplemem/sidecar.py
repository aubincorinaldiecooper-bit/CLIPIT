"""Clipit's HTTP boundary around upstream Omni-SimpleMem.

Upstream owns memory construction and retrieval. This service adds only the
product contract it does not provide: one namespace per Clipit video, source-
second coordinates for frame memories, stable HTTP reply shapes, and delete /
replace semantics that follow Clipit's footage retention.

Two upstream details are made explicit here because both are correctness
boundaries for Clipit:

1. The video processor computes `timestamp = frame_index / fps` but persists
   only `frame_index`. We persist that same coordinate beside the memory.
2. Text questions and visual frames are separate vector spaces by default.
   Clipit deliberately points text, visual embedding, and the frame-change
   trigger at the SAME CLIP model and dimension. That makes a text question
   capable of retrieving a visual frame without inventing a second index.

SimpleMem only proposes candidate moments. Clipit still verifies a candidate
against the actual source interval before it can become user-facing evidence.
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
SHARED_CLIP_MODEL = os.environ.get("SIMPLEMEM_CLIP_MODEL", "openai/clip-vit-base-patch32")
SHARED_CLIP_DIM = int(os.environ.get("SIMPLEMEM_CLIP_DIM", "512"))
PROCESS_AUDIO = os.environ.get("SIMPLEMEM_PROCESS_AUDIO", "false").lower() in {"1", "true", "yes", "on"}

# Clipit's worker indexes one video at a time. Serializing sidecar operations
# prevents an upstream store from being queried while its files are replaced
# and bounds local model RAM to one active operation.
operation_lock = asyncio.Lock()
app = FastAPI(title="Clipit Omni-SimpleMem", version="1")


class QueryBody(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=20, ge=1, le=200)


def _safe_video_id(value: str) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 128:
        raise HTTPException(status_code=400, detail="invalid video id")
    if any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in cleaned):
        raise HTTPException(status_code=400, detail="invalid video id")
    return cleaned


def _video_dir(video_id: str) -> Path:
    return DATA_ROOT / _safe_video_id(video_id)


def _config() -> OmniMemoryConfig:
    config = OmniMemoryConfig()

    api_key = os.environ.get("SIMPLEMEM_API_KEY") or os.environ.get("OPENAI_API_KEY")
    api_base = os.environ.get("SIMPLEMEM_API_BASE") or os.environ.get("OPENAI_API_BASE")
    if api_key:
        config.llm.api_key = api_key
    if api_base:
        config.llm.api_base_url = api_base

    config.llm.caption_model = os.environ.get("SIMPLEMEM_CAPTION_MODEL", config.llm.caption_model)
    config.llm.summary_model = os.environ.get("SIMPLEMEM_SUMMARY_MODEL", config.llm.summary_model)
    config.llm.query_model = os.environ.get("SIMPLEMEM_QUERY_MODEL", config.llm.query_model)
    config.llm.whisper_model = os.environ.get("SIMPLEMEM_TRANSCRIPTION_MODEL", config.llm.whisper_model)

    # One cross-modal space. Upstream's HybridVectorStore puts a visual/video
    # MAU into the text-searchable store when these dimensions are equal.
    config.embedding.model_name = SHARED_CLIP_MODEL
    config.embedding.embedding_dim = SHARED_CLIP_DIM
    config.embedding.visual_embedding_model = SHARED_CLIP_MODEL
    config.embedding.visual_embedding_dim = SHARED_CLIP_DIM
    config.entropy_trigger.visual_encoder = "clip"
    config.entropy_trigger.visual_model_name = SHARED_CLIP_MODEL
    return config


def _models(config: OmniMemoryConfig) -> dict[str, str]:
    return {
        "caption": config.llm.caption_model,
        "visual": config.embedding.visual_embedding_model,
        "text_embedding": config.embedding.model_name,
        "transcription": config.llm.whisper_model if PROCESS_AUDIO else "disabled-native-clipit-transcript",
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
    memory = create(mode="omni", config=_config(), data_dir=str(video_dir))
    # Clipit already has a timestamped transcript and routes transcript-only
    # questions there. Upstream's video audio memory is one untimed transcript,
    # so processing it by default would add cost without adding a usable moment.
    if not PROCESS_AUDIO:
        memory.video_processor.process_audio = False
        memory.video_processor.audio_processor = None
    return memory


def _modality(item: dict[str, Any]) -> str:
    value = str(item.get("modality_type") or item.get("modality") or "text").lower()
    return value if value in {"text", "visual", "audio", "video", "multimodal"} else "text"


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
        # add_video exposes max_frames but not fps. This is the same sampling
        # clock upstream uses internally when it computes idx/fps.
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
        for frame in frame_maus:
            frame_id = str(getattr(frame, "id", "") or "")
            frame_meta = getattr(frame, "metadata", None)
            frame_index = getattr(frame_meta, "frame_index", None) if frame_meta is not None else None
            if not frame_id or not isinstance(frame_index, int) or frame_index < 0:
                continue
            frames[frame_id] = {"frameIndex": frame_index, "seconds": frame_index / fps}

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
                "crossModalModel": SHARED_CLIP_MODEL,
                "crossModalDim": SHARED_CLIP_DIM,
            },
        )

        # close() flushes upstream vector stores. The sidecar does not report
        # ready until the memory and Clipit coordinates are both durable.
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

    frame_map = _read_timeline(video_dir)["frames"]
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
            try:
                score = float(row.get("score", 0.0))
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
