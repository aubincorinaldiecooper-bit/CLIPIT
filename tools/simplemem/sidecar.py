"""Clipit's HTTP boundary around upstream Omni-SimpleMem.

Upstream owns memory construction and retrieval. This service adds the product
contract it does not provide: one namespace per Clipit video, source-second
coordinates for frame memories, stable HTTP reply shapes, delete/replace
semantics that follow Clipit's footage retention, and durable object-storage
archives so the local Railway disk can remain a disposable hot cache.

SimpleMem proposes candidate moments only. Clipit still verifies a candidate
against the actual source interval before it can become user-facing evidence.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import shutil
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

import simplemem
from simplemem import create
from simplemem.multimodal.core.config import OmniMemoryConfig

sys.path.insert(0, str(Path(__file__).resolve().parent))
from captions import CaptionWriter  # noqa: E402


DATA_ROOT = Path(os.environ.get("SIMPLEMEM_DATA_DIR", "/data/simplemem")).resolve()
DATA_ROOT.mkdir(parents=True, exist_ok=True)
TIMELINE_FILE = "clipit_timeline.json"
ARCHIVE_MARKER_FILE = ".clipit_archived.json"
SHARED_CLIP_MODEL = os.environ.get("SIMPLEMEM_CLIP_MODEL", "openai/clip-vit-base-patch32")
SHARED_CLIP_DIM = int(os.environ.get("SIMPLEMEM_CLIP_DIM", "512"))
PROCESS_AUDIO = os.environ.get("SIMPLEMEM_PROCESS_AUDIO", "false").lower() in {"1", "true", "yes", "on"}
ARCHIVE_REQUIRED = os.environ.get("SIMPLEMEM_ARCHIVE_REQUIRED", "false").lower() in {"1", "true", "yes", "on"}
ARCHIVE_PREFIX = os.environ.get("SIMPLEMEM_ARCHIVE_PREFIX", "simplemem/v1").strip("/") or "simplemem/v1"
CACHE_HIGH_WATER_BYTES = int(os.environ.get("SIMPLEMEM_CACHE_HIGH_WATER_BYTES", str(4 * 1024**3)))
CACHE_LOW_WATER_BYTES = int(os.environ.get("SIMPLEMEM_CACHE_LOW_WATER_BYTES", str(3 * 1024**3)))
ARCHIVE_SCHEMA_VERSION = 1
EMBEDDING_VERSION = os.environ.get("SIMPLEMEM_EMBEDDING_VERSION", "v1").strip() or "v1"
MAX_UPLOAD_BYTES = int(os.environ.get("SIMPLEMEM_MAX_UPLOAD_BYTES", str(2 * 1024**3)))
INTERNAL_TOKEN = os.environ.get("SIMPLEMEM_INTERNAL_TOKEN", "").strip()

operation_lock = asyncio.Lock()
app = FastAPI(title="Clipit Omni-SimpleMem", version="2")
_s3: Any | None = None
log = logging.getLogger("uvicorn.error")


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

    # One cross-modal space. Upstream's HybridVectorStore makes visual/video
    # MAUs text-searchable when text and visual dimensions match.
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


class IndexingRefused(RuntimeError):
    """Indexing that finished but must not be called a memory of the video; the message says why."""


def _open_memory(video_dir: Path):
    config = _config()
    memory = create(mode="omni", config=config, data_dir=str(video_dir))
    # Frame captions go through Clipit's writer: the same prompt and model as
    # upstream, but a blank reply is asked again with more room, and a caption
    # that never arrives is counted instead of being stored as "Image captured"
    # (captions.py). Upstream's process() calls self.generate_summary, so an
    # instance attribute is enough to take that call over.
    processor = memory.video_processor.image_processor
    writer = CaptionWriter(
        processor._get_llm_client,
        processor._normalize_model(config.llm.caption_model),
        load_image=processor._load_image,
        log=log,
    )
    processor.generate_summary = writer.caption
    processor.clipit_captions = writer
    # Clipit already has a timestamped transcript. Upstream's video audio MAU
    # is untimed, so it does not add usable source-time evidence for moments.
    if not PROCESS_AUDIO:
        memory.video_processor.process_audio = False
        memory.video_processor.audio_processor = None
    return memory


def _caption_stats(memory: Any) -> dict[str, Any]:
    writer = getattr(memory.video_processor.image_processor, "clipit_captions", None)
    if writer is None:
        return {"attempted": 0, "captioned": 0, "retried": 0, "failed": 0, "lastError": "captions were not routed through CaptionWriter"}
    return writer.stats.as_dict()


def _modality(item: dict[str, Any]) -> str:
    value = str(item.get("modality_type") or item.get("modality") or "text").lower()
    return value if value in {"text", "visual", "audio", "video", "multimodal"} else "text"


def _env(name: str, fallback: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is not None and value.strip():
        return value.strip()
    if fallback:
        value = os.environ.get(fallback)
        if value is not None and value.strip():
            return value.strip()
    return None


def _archive_bucket() -> str | None:
    return _env("SIMPLEMEM_ARCHIVE_BUCKET", "BUCKET_NAME")


def _archive_configured() -> bool:
    return bool(
        _archive_bucket()
        and _env("SIMPLEMEM_ARCHIVE_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
        and _env("SIMPLEMEM_ARCHIVE_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
    )


def _assert_archive_configuration() -> None:
    if ARCHIVE_REQUIRED and not _archive_configured():
        raise RuntimeError("durable SimpleMem archive is required but S3-compatible storage is not configured")
    if CACHE_LOW_WATER_BYTES <= 0 or CACHE_HIGH_WATER_BYTES <= CACHE_LOW_WATER_BYTES:
        raise RuntimeError("SimpleMem cache watermarks are invalid")
    if MAX_UPLOAD_BYTES <= 0:
        raise RuntimeError("SimpleMem upload byte limit is invalid")


def _assert_internal_token_configuration() -> None:
    if len(INTERNAL_TOKEN) < 32:
        raise RuntimeError("SIMPLEMEM_INTERNAL_TOKEN must be configured with at least 32 characters")


def _authorize_internal(
    token: str | None = Header(default=None, alias="X-Clipit-SimpleMem-Token"),
) -> None:
    _assert_internal_token_configuration()
    if token is None or not hmac.compare_digest(token, INTERNAL_TOKEN):
        raise HTTPException(status_code=401, detail="unauthorized")


def _s3_client():
    global _s3
    if _s3 is not None:
        return _s3
    _assert_archive_configuration()
    if not _archive_configured():
        return None
    force_path = (_env("SIMPLEMEM_ARCHIVE_FORCE_PATH_STYLE", "S3_FORCE_PATH_STYLE") or "false").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    _s3 = boto3.client(
        "s3",
        endpoint_url=_env("SIMPLEMEM_ARCHIVE_ENDPOINT_URL", "AWS_ENDPOINT_URL"),
        region_name=_env("SIMPLEMEM_ARCHIVE_REGION", "AWS_REGION") or "us-east-1",
        aws_access_key_id=_env("SIMPLEMEM_ARCHIVE_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=_env("SIMPLEMEM_ARCHIVE_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
        config=BotoConfig(s3={"addressing_style": "path" if force_path else "auto"}),
    )
    return _s3


def _archive_base(video_id: str) -> str:
    return f"{ARCHIVE_PREFIX}/{_safe_video_id(video_id)}"


def _manifest_key(video_id: str) -> str:
    return f"{_archive_base(video_id)}/manifest.json"


def _archive_key(video_id: str, digest: str) -> str:
    return f"{_archive_base(video_id)}/archives/{digest}.tar.gz"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _archive_marker(video_dir: Path) -> Path:
    return video_dir / ARCHIVE_MARKER_FILE


def _mark_archived(video_dir: Path, manifest: dict[str, Any]) -> None:
    _archive_marker(video_dir).write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")


def _has_archive_marker(video_dir: Path) -> bool:
    return _archive_marker(video_dir).exists()


def _load_manifest(video_id: str) -> dict[str, Any] | None:
    client = _s3_client()
    if client is None:
        return None
    bucket = _archive_bucket()
    assert bucket is not None
    try:
        response = client.get_object(Bucket=bucket, Key=_manifest_key(video_id))
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise
    raw = response["Body"].read()
    manifest = json.loads(raw.decode("utf-8"))
    digest = manifest.get("sha256") if isinstance(manifest, dict) else None
    expected_archive_key = _archive_key(video_id, digest) if isinstance(digest, str) else None
    if (
        not isinstance(manifest, dict)
        or manifest.get("schemaVersion") != ARCHIVE_SCHEMA_VERSION
        or manifest.get("videoId") != video_id
        or not isinstance(digest, str)
        or len(digest) != 64
        or any(ch not in "0123456789abcdef" for ch in digest.lower())
        or manifest.get("archiveKey") != expected_archive_key
    ):
        raise RuntimeError("SimpleMem archive manifest is invalid")
    return manifest


def _read_archive_marker(video_dir: Path) -> dict[str, Any] | None:
    marker = _archive_marker(video_dir)
    if not marker.exists():
        return None
    try:
        value = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _cache_ready(video_dir: Path, expected_video_id: str | None = None) -> bool:
    if not video_dir.is_dir() or not _timeline_path(video_dir).exists():
        return False
    # When durable archives are configured, only a cache entry backed by a
    # committed manifest marker is eligible to suppress archive restoration.
    if _archive_configured():
        marker = _read_archive_marker(video_dir)
        if marker is None or marker.get("videoId") != (expected_video_id or video_dir.name):
            return False
    try:
        # A valid upstream memory contains more than Clipit's two metadata
        # files. This is intentionally format-agnostic; opening it below is the
        # final validation and triggers archive recovery if upstream rejects it.
        return any(
            child.name not in {TIMELINE_FILE, ARCHIVE_MARKER_FILE}
            for child in video_dir.iterdir()
        )
    except OSError:
        return False


def _assert_timeline_compatible(timeline: dict[str, Any]) -> None:
    if (
        timeline.get("crossModalModel") != SHARED_CLIP_MODEL
        or timeline.get("crossModalDim") != SHARED_CLIP_DIM
        or timeline.get("embeddingVersion") != EMBEDDING_VERSION
    ):
        raise HTTPException(
            status_code=409,
            detail="video memory embedding identity changed; reindex required",
        )


def _prepare_cache_for_query(video_id: str) -> tuple[Path, bool]:
    final_dir = _video_dir(video_id)
    backup_dir = final_dir.with_name(f"{final_dir.name}.previous")
    if _cache_ready(final_dir, video_id):
        return final_dir, False

    if final_dir.exists():
        shutil.rmtree(final_dir, ignore_errors=True)

    # A process death during replacement can leave the previous committed cache
    # parked beside the final path. Recover it before paying for an S3 restore.
    if _cache_ready(backup_dir, video_id):
        backup_dir.replace(final_dir)
        return final_dir, False
    if backup_dir.exists():
        shutil.rmtree(backup_dir, ignore_errors=True)

    restored = _restore_sync(video_id)
    if not restored:
        raise HTTPException(status_code=404, detail="video memory not found")
    if not _cache_ready(final_dir, video_id):
        shutil.rmtree(final_dir, ignore_errors=True)
        raise RuntimeError("restored SimpleMem cache is incomplete")
    return final_dir, True


def _archive_sync(video_id: str, video_dir: Path) -> dict[str, Any] | None:
    client = _s3_client()
    if client is None:
        return None
    bucket = _archive_bucket()
    assert bucket is not None

    previous = _load_manifest(video_id)
    previous_key = previous.get("archiveKey") if previous else None
    fd, raw_path = tempfile.mkstemp(prefix=f"clipit-simplemem-{video_id}-", suffix=".tar.gz")
    os.close(fd)
    archive_path = Path(raw_path)
    new_key: str | None = None
    try:
        # This marker describes the cache copy, not the memory itself.
        _archive_marker(video_dir).unlink(missing_ok=True)
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(video_dir, arcname="memory")
        digest = _sha256(archive_path)
        new_key = _archive_key(video_id, digest)
        size = archive_path.stat().st_size

        # Generation objects are immutable/content-addressed. The old manifest
        # continues to point at the old bytes until the new manifest commits.
        client.upload_file(str(archive_path), bucket, new_key)
        manifest = {
            "schemaVersion": ARCHIVE_SCHEMA_VERSION,
            "videoId": video_id,
            "archiveKey": new_key,
            "sha256": digest,
            "sizeBytes": size,
            "createdAtUnix": int(time.time()),
        }
        client.put_object(
            Bucket=bucket,
            Key=_manifest_key(video_id),
            Body=json.dumps(manifest, separators=(",", ":")).encode("utf-8"),
            ContentType="application/json",
        )
        _mark_archived(video_dir, manifest)

        # Only after the new manifest is durable may the previous generation
        # be removed. Failure here leaks bytes but cannot corrupt the live copy.
        if previous_key and previous_key != new_key:
            try:
                client.delete_object(Bucket=bucket, Key=previous_key)
            except Exception as exc:
                log.warning("could not delete previous SimpleMem archive generation: %s", type(exc).__name__)
        return manifest
    except Exception:
        # Once the generation upload succeeded and the manifest write was
        # attempted, an exception cannot tell us whether S3 rejected the write
        # or committed it and only lost the response. Deleting the new
        # generation here could therefore delete the bytes referenced by a
        # successfully committed manifest. Leave a possible orphan instead; a
        # later successful replacement/delete can clean it safely.
        raise
    finally:
        archive_path.unlink(missing_ok=True)


def _safe_extract(tar: tarfile.TarFile, destination: Path) -> None:
    destination_resolved = destination.resolve()
    for member in tar.getmembers():
        target = (destination / member.name).resolve()
        if destination_resolved != target and destination_resolved not in target.parents:
            raise RuntimeError("SimpleMem archive contains an unsafe path")
        if member.issym() or member.islnk():
            raise RuntimeError("SimpleMem archive contains a link")
    tar.extractall(destination)


def _restore_sync(video_id: str) -> bool:
    client = _s3_client()
    if client is None:
        return False
    manifest = _load_manifest(video_id)
    if manifest is None:
        return False
    bucket = _archive_bucket()
    assert bucket is not None

    fd, raw_path = tempfile.mkstemp(prefix=f"clipit-simplemem-restore-{video_id}-", suffix=".tar.gz")
    os.close(fd)
    archive_path = Path(raw_path)
    restore_root = Path(tempfile.mkdtemp(prefix=f".{video_id}.restoring-", dir=DATA_ROOT))
    final_dir = _video_dir(video_id)
    try:
        client.download_file(bucket, manifest["archiveKey"], str(archive_path))
        if _sha256(archive_path) != manifest["sha256"]:
            raise RuntimeError("SimpleMem archive checksum mismatch")
        with tarfile.open(archive_path, "r:gz") as tar:
            _safe_extract(tar, restore_root)
        extracted = restore_root / "memory"
        if not extracted.is_dir() or not _timeline_path(extracted).exists():
            raise RuntimeError("SimpleMem archive is missing required memory metadata")
        if final_dir.exists():
            shutil.rmtree(final_dir, ignore_errors=True)
        extracted.replace(final_dir)
        _mark_archived(final_dir, manifest)
        _touch_cache_entry(final_dir)
        return True
    finally:
        archive_path.unlink(missing_ok=True)
        shutil.rmtree(restore_root, ignore_errors=True)


def _delete_archive_sync(video_id: str) -> None:
    client = _s3_client()
    if client is None:
        return
    bucket = _archive_bucket()
    assert bucket is not None

    # Remove the manifest first so a failed cleanup cannot make an archived
    # memory restorable again. Retries discover leftover generations by prefix.
    client.delete_object(Bucket=bucket, Key=_manifest_key(video_id))
    prefix = f"{_archive_base(video_id)}/"
    continuation: str | None = None
    while True:
        kwargs: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if continuation:
            kwargs["ContinuationToken"] = continuation
        page = client.list_objects_v2(**kwargs)
        keys = [item.get("Key") for item in page.get("Contents", []) if isinstance(item.get("Key"), str)]
        if keys:
            response = client.delete_objects(
                Bucket=bucket,
                Delete={"Objects": [{"Key": key} for key in keys], "Quiet": True},
            )
            errors = response.get("Errors") or []
            if errors:
                raise RuntimeError(f"failed to delete {len(errors)} SimpleMem archive objects")
        if not page.get("IsTruncated"):
            break
        continuation = page.get("NextContinuationToken")
        if not isinstance(continuation, str) or not continuation:
            raise RuntimeError("SimpleMem archive listing truncated without a continuation token")


def _directory_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except FileNotFoundError:
                pass
    return total


def _touch_cache_entry(video_dir: Path) -> None:
    now = time.time()
    try:
        os.utime(video_dir, (now, now))
    except FileNotFoundError:
        pass


def _cache_entries() -> list[Path]:
    entries: list[Path] = []
    for candidate in DATA_ROOT.iterdir():
        if not candidate.is_dir() or candidate.name.startswith(".") or candidate.name.endswith(".previous"):
            continue
        entries.append(candidate)
    return entries


def _enforce_cache_budget() -> dict[str, int]:
    if not _archive_configured():
        size = _directory_size(DATA_ROOT)
        return {"beforeBytes": size, "afterBytes": size, "evicted": 0}
    before = _directory_size(DATA_ROOT)
    if before <= CACHE_HIGH_WATER_BYTES:
        return {"beforeBytes": before, "afterBytes": before, "evicted": 0}

    candidates: list[tuple[float, Path]] = []
    for entry in _cache_entries():
        if not _has_archive_marker(entry):
            continue
        try:
            touched = entry.stat().st_mtime
        except FileNotFoundError:
            continue
        candidates.append((touched, entry))
    candidates.sort(key=lambda pair: pair[0])

    current = before
    evicted = 0
    for _, entry in candidates:
        if current <= CACHE_LOW_WATER_BYTES:
            break
        size = _directory_size(entry)
        shutil.rmtree(entry, ignore_errors=True)
        current = max(0, current - size)
        evicted += 1
    return {"beforeBytes": before, "afterBytes": current, "evicted": evicted}


def _index_sync(video_id: str, source: Path, fps: float, max_frames: int, duration_seconds: float) -> dict[str, Any]:
    _assert_archive_configuration()
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
        memory.video_processor.fps = fps
        result = memory.add_video(
            str(source),
            session_id=f"clipit:{video_id}",
            tags=[f"clipit_video:{video_id}"],
            max_frames=max_frames,
        )
        if not result.success or result.mau is None:
            raise RuntimeError(result.error or "Omni-SimpleMem did not create a video memory")

        captions = _caption_stats(memory)
        if captions["attempted"] > 0 and captions["captioned"] == 0:
            # Every kept frame has a picture vector but no words. Calling that
            # a finished memory would let the search report "nothing matches"
            # from a memory that describes nothing. The worker marks the index
            # failed with this reason and the footage search still answers.
            raise IndexingRefused(
                f"no frame received a caption ({captions['attempted']} attempted; "
                f"last error: {captions['lastError']})"
            )
        if captions["failed"] > 0:
            log.warning(
                "SimpleMem captions missing for %d of %d frames of %s (last error: %s)",
                captions["failed"], captions["attempted"], video_id, captions["lastError"],
            )

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
                "embeddingVersion": EMBEDDING_VERSION,
                "captions": captions,
            },
        )

        # close() flushes the upstream vector stores before durable snapshotting.
        memory.close()
        memory = None
        archive = _archive_sync(video_id, final_dir)
        if ARCHIVE_REQUIRED and archive is None:
            raise RuntimeError("durable SimpleMem archive was required but was not written")
        _touch_cache_entry(final_dir)
        shutil.rmtree(backup_dir, ignore_errors=True)
        cache = _enforce_cache_budget()

        return {
            "videoMauId": str(result.mau.id),
            "fps": fps,
            "framesExtracted": extracted,
            "framesProcessed": processed,
            "framesSkipped": skipped,
            "coveredThroughSeconds": covered,
            "audioTranscribed": metadata.get("audio_mau") is not None,
            "captions": captions,
            "durableArchive": archive is not None,
            "cache": cache,
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
    _assert_archive_configuration()
    started = time.perf_counter()
    video_dir, restored = _prepare_cache_for_query(video_id)
    timeline = _read_timeline(video_dir)
    _assert_timeline_compatible(timeline)
    frame_map = timeline["frames"]
    try:
        memory = _open_memory(video_dir)
    except Exception:
        # Timeline/marker presence catches interrupted writes cheaply. If the
        # upstream store itself is corrupt, discard the cache and retry exactly
        # once from the committed durable generation.
        if restored or not _archive_configured():
            raise
        shutil.rmtree(video_dir, ignore_errors=True)
        if not _restore_sync(video_id):
            raise
        restored = True
        timeline = _read_timeline(video_dir)
        _assert_timeline_compatible(timeline)
        frame_map = timeline["frames"]
        memory = _open_memory(video_dir)
    items: list[dict[str, Any]] = []
    total_candidates = 0
    cache: dict[str, int]
    try:
        # Upstream Omni-SimpleMem derives its own strategy and otherwise
        # replaces the caller's top_k with 5/10/20 depending on query type.
        # Clipit owns the candidate budget, so preserve every other strategy
        # choice while making our requested top_k authoritative. This memory
        # instance is request-local and sidecar operations are serialized.
        original_strategy = memory.query_processor.determine_retrieval_strategy

        def clipit_strategy(parsed):
            strategy = dict(original_strategy(parsed))
            strategy["top_k"] = top_k
            return strategy

        memory.query_processor.determine_retrieval_strategy = clipit_strategy
        try:
            result = memory.query(question, top_k=top_k)
        finally:
            memory.query_processor.determine_retrieval_strategy = original_strategy
        total_candidates = int(getattr(result, "total_candidates", len(result.items)) or len(result.items))
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
    finally:
        # The active store must be closed before this video itself is eligible
        # for eviction. This keeps one large/restored video from pinning the
        # cache above its configured high-water mark indefinitely.
        try:
            memory.close()
        finally:
            _touch_cache_entry(video_dir)
            cache = _enforce_cache_budget()

    return {
        "items": items,
        "totalCandidates": total_candidates,
        "restoredFromArchive": restored,
        "cache": cache,
        "elapsedMs": round((time.perf_counter() - started) * 1000),
    }


def _delete_sync(video_id: str) -> None:
    _assert_archive_configuration()
    remote_error: Exception | None = None
    try:
        _delete_archive_sync(video_id)
    except Exception as exc:
        remote_error = exc
    finally:
        # Local derived frames must disappear even if object storage is down.
        # The caller receives the remote failure so retention can retry it.
        video_dir = _video_dir(video_id)
        shutil.rmtree(video_dir, ignore_errors=True)
        shutil.rmtree(video_dir.with_name(f"{video_dir.name}.previous"), ignore_errors=True)
    if remote_error is not None:
        raise remote_error


@app.get("/health")
async def health() -> dict[str, Any]:
    _assert_archive_configuration()
    config = _config()
    return {
        "ok": True,
        "models": _models(config),
        "version": simplemem.__version__,
        "archive": {
            "configured": _archive_configured(),
            "required": ARCHIVE_REQUIRED,
            "prefix": ARCHIVE_PREFIX,
        },
        "cache": {
            "highWaterBytes": CACHE_HIGH_WATER_BYTES,
            "lowWaterBytes": CACHE_LOW_WATER_BYTES,
        },
        "embeddingVersion": EMBEDDING_VERSION,
        "maxUploadBytes": MAX_UPLOAD_BYTES,
        "authConfigured": len(INTERNAL_TOKEN) >= 32,
    }


@app.get("/ready")
async def ready(_: None = Depends(_authorize_internal)) -> dict[str, Any]:
    return await health()


@app.put("/videos/{video_id}")
async def index_video(
    video_id: str,
    file: UploadFile = File(...),
    fps: float = Form(..., gt=0, le=2),
    max_frames: int = Form(..., ge=1, le=200_000),
    duration_seconds: float = Form(..., gt=0),
    _: None = Depends(_authorize_internal),
) -> dict[str, Any]:
    _safe_video_id(video_id)
    suffix = Path(file.filename or "video.mp4").suffix or ".mp4"
    fd, raw_path = tempfile.mkstemp(prefix="clipit-simplemem-", suffix=suffix)
    os.close(fd)
    temp_path = Path(raw_path)
    try:
        async with operation_lock:
            total_bytes = 0
            with temp_path.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="video exceeds SimpleMem upload limit")
                    output.write(chunk)
            return await asyncio.to_thread(
                _index_sync, video_id, temp_path, float(fps), int(max_frames), float(duration_seconds)
            )
    except HTTPException:
        raise
    except IndexingRefused as exc:
        raise HTTPException(status_code=500, detail=f"SimpleMem indexing refused: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"SimpleMem indexing failed: {type(exc).__name__}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/videos/{video_id}/query")
async def query_video(video_id: str, body: QueryBody, _: None = Depends(_authorize_internal)) -> dict[str, Any]:
    _safe_video_id(video_id)
    async with operation_lock:
        try:
            return await asyncio.to_thread(_query_sync, video_id, body.query.strip(), body.top_k)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"SimpleMem query failed: {type(exc).__name__}") from exc


@app.delete("/videos/{video_id}")
async def delete_video(video_id: str, _: None = Depends(_authorize_internal)) -> dict[str, bool]:
    _safe_video_id(video_id)
    async with operation_lock:
        try:
            await asyncio.to_thread(_delete_sync, video_id)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"SimpleMem delete failed: {type(exc).__name__}") from exc
    return {"ok": True}
