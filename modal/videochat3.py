"""VideoChat3 on Modal for Clipit's internet-video and uploaded-video search.

One L4-backed service owns the model weights and exposes three jobs:

* ``watch``: an offline first pass over a fetchable candidate video using the
  official VideoChat3 StreamingSession / VideoFrameExtractor implementation.
* ``watch_stream``: the same official streaming session kept alive while
  timestamped browser frames arrive through Modal queues. Matching moments are
  emitted as soon as the model produces them.
* ``verify_intervals``: a dense second look at exact stored-video intervals and
  a strict relevance judgement.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import queue
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import modal

APP_NAME = "clipit-videochat3"
MODEL_ID = "MCG-NJU/VideoChat3-4B"
MODEL_REVISION = os.environ.get("VIDEOCHAT3_REVISION", "37fa901")
WEIGHTS_DIR = "/weights/hf"
FLASH_ATTN_WHEEL = (
    "https://github.com/Dao-AILab/flash-attention/releases/download/v2.7.4.post1/"
    "flash_attn-2.7.4.post1+cu12torch2.6cxx11abiFALSE-cp312-cp312-linux_x86_64.whl"
)

# Match the official proactive demo: routine rounds use a 224x224-equivalent
# pixel budget and the round after </Standby> gets 2x width/height = 4x pixels.
STREAM_NORMAL_MAX_PIXELS = max(
    28 * 28,
    int(os.environ.get("VIDEOCHAT3_STREAM_NORMAL_MAX_PIXELS", str(224 * 224))),
)
STREAM_STANDBY_MAX_PIXELS = max(
    STREAM_NORMAL_MAX_PIXELS,
    int(os.environ.get("VIDEOCHAT3_STREAM_STANDBY_MAX_PIXELS", str(STREAM_NORMAL_MAX_PIXELS * 4))),
)
# The processor-wide ceiling must be at least as high as a Standby round. Each
# StreamingSession turn still carries its own lower frame_max_pixels budget.
STREAM_ENGINE_MAX_PIXELS = max(100352, STREAM_STANDBY_MAX_PIXELS)
OFFLINE_WATCH_MAX_PIXELS = 100352

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "curl", "libgl1", "libglib2.0-0")
    .uv_pip_install(
        "torch==2.6.0",
        "torchvision==0.21.0",
        "transformers>=4.57.0,<4.58",
        "accelerate",
        "huggingface-hub",
        "qwen-vl-utils",
        "opencv-python-headless",
        "decord",
        "pillow",
        "safetensors",
        FLASH_ATTN_WHEEL,
    )
)

app = modal.App(APP_NAME, image=image)
weights = modal.Volume.from_name("clipit-videochat3-weights", create_if_missing=True)

_RESPONSE_RE = re.compile(r"^\s*</Response>\s*(.*)$", re.DOTALL)
_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)
_SURENESS_RE = re.compile(r"\s*\[\s*(\d{1,3}(?:\.\d+)?)\s*(%?)\s*\]\s*$")
_SURENESS_ASK = (
    " When you describe something, end with how sure you are in square"
    " brackets, like [0.8]."
)


def _stop_watching(
    now: float,
    started: float,
    heard_at: float,
    max_session_sec: float,
    max_silence_sec: float,
) -> str | None:
    """Why a live watch should stop, or None to keep going."""
    if now - started > max_session_sec:
        return "VideoChat3 stopped a live watch that ran too long"
    if now - heard_at > max_silence_sec:
        return "the browser stopped sending frames"
    return None


def _sureness(said: str) -> tuple[str, float | None]:
    """Split what the watcher said from how sure it said it was."""
    found = _SURENESS_RE.search(said)
    if not found:
        return said, None
    value = float(found.group(1))
    if found.group(2) == "%" or value > 1:
        value = value / 100.0
    if value < 0 or value > 1:
        return said[: found.start()].rstrip(), None
    return said[: found.start()].rstrip(), value


def _resize_stream_frame(frame: Any, max_pixels: int) -> Any:
    """Resize like VideoChat3's official proactive demo, aligned to 28 px."""
    width, height = frame.size
    if width <= 0 or height <= 0:
        raise ValueError("stream frame has invalid dimensions")
    if max(width, height) / min(width, height) > 200:
        raise ValueError("stream frame aspect ratio is too extreme")
    factor = 28
    beta = math.sqrt((height * width) / max_pixels)
    h_bar = max(factor, math.floor(height / beta / factor) * factor)
    w_bar = max(factor, math.floor(width / beta / factor) * factor)
    return frame.resize((w_bar, h_bar))


def _stream_state(answer: str) -> str:
    if "</Response>" in answer:
        return "response"
    if "</Standby>" in answer:
        return "standby"
    if "</Silence>" in answer:
        return "silence"
    return "unknown"


def _download(url: str, destination: Path, expected_bytes: int | None = None) -> int:
    request = urllib.request.Request(url, headers={"User-Agent": "clipit-videochat3/1"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as out:
        shutil.copyfileobj(response, out)
    size = destination.stat().st_size
    if expected_bytes is not None and expected_bytes > 0 and size != expected_bytes:
        raise ValueError(f"downloaded {size} bytes but expected {expected_bytes}")
    return size


def _probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return max(0.0, float(result.stdout.strip()))


def _cut_interval(source: Path, target: Path, start: float, end: float) -> None:
    duration = max(0.05, end - start)
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start:.3f}", "-i", str(source), "-t", f"{duration:.3f}",
            "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264",
            "-preset", "veryfast", "-crf", "28", "-c:a", "aac",
            "-movflags", "+faststart", str(target),
        ],
        check=True,
    )


def _parse_verdict(text: str) -> dict[str, Any]:
    match = _JSON_RE.search(text)
    if not match:
        return {"match": False, "confidence": 0.0, "description": "", "reason": "model reply was not JSON"}
    try:
        raw = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {"match": False, "confidence": 0.0, "description": "", "reason": "model reply contained invalid JSON"}
    is_match = raw.get("match") is True
    confidence = raw.get("confidence", 0.0)
    if not isinstance(confidence, (int, float)) or not (0 <= float(confidence) <= 1):
        confidence = 0.0
        is_match = False
    description = raw.get("description") if isinstance(raw.get("description"), str) else ""
    return {
        "match": is_match,
        "confidence": float(confidence),
        "description": description.strip()[:500],
        "reason": None,
    }


@app.cls(
    gpu="L4",
    volumes={"/weights": weights},
    scaledown_window=300,
    timeout=1800,
)
class VideoChat3Service:
    @modal.enter()
    def load(self) -> None:
        import flash_attn
        from huggingface_hub import hf_hub_download, snapshot_download

        os.environ.setdefault("HF_HOME", WEIGHTS_DIR)
        started = time.time()

        self.model_path = snapshot_download(
            MODEL_ID,
            revision=MODEL_REVISION,
            cache_dir=WEIGHTS_DIR,
        )
        stream_path = hf_hub_download(
            MODEL_ID,
            "inference_fast_vc3.py",
            revision=MODEL_REVISION,
            cache_dir=WEIGHTS_DIR,
        )

        import importlib.util

        spec = importlib.util.spec_from_file_location("clipit_videochat3_stream", stream_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load official VideoChat3 streaming implementation")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.StreamingSession = module.StreamingSession
        self.VideoFrameExtractor = module.VideoFrameExtractor

        self.engine = module.VideoChat3StreamEngine(
            self.model_path,
            device="auto",
            attn_implementation="flash_attention_2",
            max_pixels=STREAM_ENGINE_MAX_PIXELS,
        )
        self.attention = "flash_attention_2"
        self.flash_attention_version = getattr(flash_attn, "__version__", "unknown")

        self.revision = MODEL_REVISION
        self.container = uuid.uuid4().hex[:12]
        self.startup_ms = int((time.time() - started) * 1000)

    @modal.method()
    def health(self) -> dict[str, Any]:
        return {
            "ok": True,
            "model": MODEL_ID,
            "revision": self.revision,
            "attention": self.attention,
            "flash_attention_version": self.flash_attention_version,
            "stream_normal_max_pixels": STREAM_NORMAL_MAX_PIXELS,
            "stream_standby_max_pixels": STREAM_STANDBY_MAX_PIXELS,
            "container": self.container,
            "startup_ms": self.startup_ms,
        }

    @modal.method()
    def watch(
        self,
        video_url: str,
        query: str,
        expected_bytes: int | None = None,
        target_fps: float = 1.0,
        max_rounds: int = 32,
        max_events: int = 64,
    ) -> dict[str, Any]:
        started = time.time()
        with tempfile.TemporaryDirectory(prefix="clipit-vc3-watch-") as raw_dir:
            source = Path(raw_dir) / "source.mp4"
            size = _download(video_url, source, expected_bytes)
            extractor = self.VideoFrameExtractor(str(source), target_fps=target_fps, prefetch=True)
            session = self.StreamingSession(
                self.engine,
                question=query,
                question_time=0,
                max_rounds=max_rounds,
                global_question=True,
                max_tokens=128,
                temperature=0.0,
            )
            events: list[dict[str, Any]] = []
            total_rounds = extractor.get_total_rounds()
            try:
                interval = 1.0 / extractor.actual_fps if extractor.actual_fps > 0 else 1.0
                for round_idx in range(total_rounds):
                    frame = extractor.get_frame_at_round(round_idx)
                    start_seconds = round_idx * interval
                    end_seconds = min(extractor.duration, start_seconds + interval)
                    answer = session.step(
                        frame,
                        round_idx=round_idx,
                        frame_max_pixels=OFFLINE_WATCH_MAX_PIXELS,
                        time_start=start_seconds,
                        time_end=end_seconds,
                    )
                    response = _RESPONSE_RE.match(answer or "")
                    if response:
                        events.append({
                            "start": round(start_seconds, 3),
                            "end": round(end_seconds, 3),
                            "description": response.group(1).strip()[:1000],
                        })
                        if len(events) >= max_events:
                            break
            finally:
                extractor.close()

            return {
                "model": MODEL_ID,
                "revision": self.revision,
                "mode": "watch",
                "duration_seconds": _probe_duration(source),
                "events": events,
                "metrics": {
                    "container": self.container,
                    "startup_ms": self.startup_ms,
                    "source_bytes": size,
                    "target_fps": target_fps,
                    "rounds": total_rounds,
                    "total_ms": int((time.time() - started) * 1000),
                },
            }

    @modal.method()
    def watch_stream(
        self,
        input_queue_id: str,
        output_queue_id: str,
        query: str,
        max_rounds: int = 16,
        max_frames: int = 4096,
        max_events: int = 64,
        round_window_ms: int = 1000,
        adaptive_resolution: bool = True,
        normal_max_pixels: int = STREAM_NORMAL_MAX_PIXELS,
        standby_max_pixels: int = STREAM_STANDBY_MAX_PIXELS,
        max_silence_sec: float = 120.0,
        max_session_sec: float = 600.0,
    ) -> dict[str, Any]:
        """Watch a live browser stream as temporal VideoChat3 rounds.

        ``max_rounds`` is only the model's sliding-history window. It is not a
        lifetime frame ceiling. ``max_frames`` separately bounds a whole watch,
        avoiding the old 256-frame coupling that would truncate a 6-fps stream
        after roughly 43 seconds.

        When ``round_window_ms`` is positive, frames from the same source-time
        window are passed to one official ``StreamingSession.step`` call as a
        list. This preserves the temporal evidence while keeping model decisions
        around one per second instead of one per captured frame.

        The official proactive behavior is preserved too: a ``</Standby>``
        response makes the next temporal round use the larger visual pixel
        budget. The browser/worker may also drop frames to stay realtime; any
        such dropped evidence makes this a partial, not exhausted, watch.
        """
        from PIL import Image

        input_queue = modal.Queue.from_id(input_queue_id)
        output_queue = modal.Queue.from_id(output_queue_id)
        started = time.time()
        history_rounds = max(1, int(max_rounds))
        frame_ceiling = max(1, int(max_frames))
        window_ms = max(0, int(round_window_ms))
        normal_pixels = max(28 * 28, min(int(normal_max_pixels), STREAM_ENGINE_MAX_PIXELS))
        standby_pixels = max(normal_pixels, min(int(standby_max_pixels), STREAM_ENGINE_MAX_PIXELS))

        session = self.StreamingSession(
            self.engine,
            question=query + _SURENESS_ASK,
            question_time=0,
            max_rounds=history_rounds,
            global_question=True,
            max_tokens=128,
            temperature=0.0,
        )

        events: list[dict[str, Any]] = []
        pending: list[tuple[Any, float, float]] = []
        pending_bucket: int | None = None
        frames_received = 0
        frames_processed = 0
        rounds_processed = 0
        high_res_rounds = 0
        standby_remaining = 0
        processed_through = 0.0
        source_through = 0.0
        source_dropped_frames = 0
        source_exhausted = False
        terminal_received = False
        end_reason = "the frame stream ended without a terminal event"
        heard_at = started

        def process_round(batch: list[tuple[Any, float, float]]) -> None:
            nonlocal frames_processed, rounds_processed, high_res_rounds
            nonlocal standby_remaining, processed_through
            if not batch or len(events) >= max_events:
                return

            high_res = adaptive_resolution and standby_remaining > 0
            if standby_remaining > 0:
                standby_remaining -= 1
            max_pixels = standby_pixels if high_res else normal_pixels
            if high_res:
                high_res_rounds += 1

            frames = [_resize_stream_frame(row[0], max_pixels) for row in batch]
            start_seconds = min(row[1] for row in batch)
            end_seconds = max(row[2] for row in batch)
            payload: Any = frames if len(frames) > 1 else frames[0]
            answer = session.step(
                payload,
                round_idx=rounds_processed,
                frame_max_pixels=max_pixels,
                time_start=start_seconds,
                time_end=end_seconds,
            ) or ""
            frames_processed += len(batch)
            rounds_processed += 1
            processed_through = max(processed_through, end_seconds)
            state = _stream_state(answer)

            # Exactly like the official proactive demo: Standby increases the
            # visual budget for the *next* temporal round, not retroactively.
            if adaptive_resolution and state == "standby":
                standby_remaining = 1

            output_queue.put({
                "type": "progress",
                "processed_through_ms": round(processed_through * 1000),
                "frames_processed": frames_processed,
                "rounds_processed": rounds_processed,
                "state": state,
                "high_res": high_res,
                "max_pixels": max_pixels,
            })

            response = _RESPONSE_RE.match(answer)
            if response:
                described, sureness = _sureness(response.group(1).strip())
                event = {
                    "type": "moment",
                    "start": round(start_seconds, 3),
                    "end": round(end_seconds, 3),
                    "description": described[:1000],
                }
                if sureness is not None:
                    event["confidence"] = round(sureness, 3)
                events.append(event)
                output_queue.put(event)

        try:
            while frames_received < frame_ceiling and len(events) < max_events:
                giving_up = _stop_watching(time.time(), started, heard_at, max_session_sec, max_silence_sec)
                if giving_up:
                    end_reason = giving_up
                    break
                try:
                    item = input_queue.get(timeout=30)
                except queue.Empty:
                    continue

                heard_at = time.time()
                if not isinstance(item, dict):
                    raise ValueError("stream queue item must be an object")
                kind = item.get("type")

                if kind == "end":
                    terminal_received = True
                    source_exhausted = bool(item.get("exhausted"))
                    end_reason = str(item.get("reason") or "stream ended")[:500]
                    watched = item.get("watched_through_seconds")
                    if isinstance(watched, (int, float)) and watched >= 0:
                        source_through = max(source_through, float(watched))
                    dropped = item.get("dropped_frames")
                    if isinstance(dropped, (int, float)) and dropped >= 0:
                        source_dropped_frames = int(dropped)
                    break

                if kind != "frame":
                    raise ValueError(f"unsupported stream item type: {kind!r}")

                timestamp_ms = float(item["timestamp_ms"])
                duration_ms = max(1.0, float(item.get("duration_ms") or 1000.0))
                if timestamp_ms < 0:
                    raise ValueError("frame timestamp must be non-negative")
                encoded = item.get("image_base64")
                if not isinstance(encoded, str) or not encoded:
                    raise ValueError("frame image is missing")

                raw = base64.b64decode(encoded, validate=True)
                with Image.open(io.BytesIO(raw)) as picture:
                    frame = picture.convert("RGB").copy()
                start_seconds = timestamp_ms / 1000.0
                end_seconds = (timestamp_ms + duration_ms) / 1000.0
                source_through = max(source_through, end_seconds)
                frames_received += 1

                if window_ms <= 0:
                    process_round([(frame, start_seconds, end_seconds)])
                    continue

                bucket = int(timestamp_ms // window_ms)
                if pending and pending_bucket is not None and bucket != pending_bucket:
                    process_round(pending)
                    pending = []
                    pending_bucket = None
                    if len(events) >= max_events:
                        break
                if not pending:
                    pending_bucket = bucket
                pending.append((frame, start_seconds, end_seconds))

            # A source can end or hit a ceiling in the middle of a one-second
            # bucket. Those frames are still evidence and must not be discarded.
            if pending and len(events) < max_events:
                process_round(pending)
                pending = []

            hit_frame_ceiling = frames_received >= frame_ceiling and not terminal_received
            hit_event_ceiling = len(events) >= max_events and not terminal_received
            if hit_frame_ceiling:
                end_reason = "VideoChat3 reached its live frame ceiling"
            elif hit_event_ceiling:
                end_reason = "VideoChat3 reached its live moment ceiling"

            exhausted = (
                terminal_received
                and source_exhausted
                and source_dropped_frames == 0
                and not hit_frame_ceiling
                and not hit_event_ceiling
            )
            duration_seconds = max(source_through, processed_through)
            result = {
                "model": MODEL_ID,
                "revision": self.revision,
                "mode": "watch_stream",
                "duration_seconds": duration_seconds,
                "watched_through_seconds": processed_through,
                "exhausted": exhausted,
                "reason": end_reason,
                "events": events,
                "metrics": {
                    "container": self.container,
                    "startup_ms": self.startup_ms,
                    "frames_received": frames_received,
                    "frames_processed": frames_processed,
                    "rounds_processed": rounds_processed,
                    "history_rounds": history_rounds,
                    "round_window_ms": window_ms,
                    "high_res_rounds": high_res_rounds,
                    "normal_max_pixels": normal_pixels,
                    "standby_max_pixels": standby_pixels,
                    "source_dropped_frames": source_dropped_frames,
                    "source_through_seconds": source_through,
                    "processed_through_seconds": processed_through,
                    "total_ms": int((time.time() - started) * 1000),
                },
            }
            output_queue.put({"type": "done", **result})
            return result
        except Exception as error:
            output_queue.put({
                "type": "error",
                "reason": f"{type(error).__name__}: {error}"[:500],
            })
            raise

    def _verify_clip(self, clip_path: Path, query: str, transcript: str | None = None) -> dict[str, Any]:
        from qwen_vl_utils import process_vision_info

        transcript_text = (transcript or "").strip()[:12000]
        evidence_rule = (
            "Judge the visible clip and the timestamp-aligned transcript together. "
            "If the search requires both a visible action and spoken content, both must be present in this interval. "
            "Do not invent speech or visuals that are absent."
            if transcript_text
            else "Judge only what is visible in this clip. Do not infer missing events."
        )
        transcript_block = f"\n\nTranscript during this exact interval:\n{transcript_text}" if transcript_text else ""
        prompt = (
            "You are verifying actual source evidence for a video search result. "
            f"{evidence_rule}\n\n"
            f"Search: {query}{transcript_block}\n\n"
            "Return JSON only with exactly these keys: "
            '{"match": true|false, "confidence": 0.0-1.0, "description": "brief evidence"}.'
        )
        messages = [{
            "role": "user",
            "content": [
                {"type": "video", "video": str(clip_path)},
                {"type": "text", "text": prompt},
            ],
        }]
        processor = self.engine.processor
        model = self.engine.model
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        images, videos, video_kwargs = process_vision_info(
            messages,
            image_patch_size=14,
            return_video_kwargs=True,
            return_video_metadata=True,
        )
        video_metadata = None
        if videos is not None:
            videos, video_metadata = zip(*videos)
            videos, video_metadata = list(videos), list(video_metadata)
        inputs = processor(
            text=text,
            images=images,
            videos=videos,
            video_metadata=video_metadata,
            do_resize=False,
            return_tensors="pt",
            **(video_kwargs or {}),
        ).to(model.device)
        if hasattr(model, "dtype"):
            inputs = inputs.to(model.dtype)
        with self.engine.torch.inference_mode():
            generated = model.generate(**inputs, max_new_tokens=160, do_sample=False)
        trimmed = [out[len(inp):] for inp, out in zip(inputs.input_ids, generated)]
        answer = processor.tokenizer.batch_decode(
            trimmed,
            skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )[0]
        verdict = _parse_verdict(answer)
        verdict["raw"] = answer[:1000]
        return verdict

    @modal.method()
    def verify_intervals(
        self,
        video_url: str,
        query: str,
        candidates: list[dict[str, Any]],
        expected_bytes: int | None = None,
    ) -> dict[str, Any]:
        started = time.time()
        with tempfile.TemporaryDirectory(prefix="clipit-vc3-verify-") as raw_dir:
            work = Path(raw_dir)
            source = work / "source.mp4"
            size = _download(video_url, source, expected_bytes)
            duration = _probe_duration(source)
            results: list[dict[str, Any]] = []
            failed: list[dict[str, Any]] = []
            for index, candidate in enumerate(candidates):
                candidate_id = str(candidate.get("id", ""))
                try:
                    start_seconds = max(0.0, float(candidate["start"]))
                    end_seconds = min(duration, float(candidate["end"]))
                    if not candidate_id or end_seconds <= start_seconds:
                        raise ValueError("candidate has an invalid id or interval")
                    transcript = candidate.get("transcript")
                    if transcript is not None and not isinstance(transcript, str):
                        raise ValueError("candidate transcript must be a string")
                    clip = work / f"candidate-{index}.mp4"
                    _cut_interval(source, clip, start_seconds, end_seconds)
                    verdict = self._verify_clip(clip, query, transcript)
                    results.append({
                        "id": candidate_id,
                        "start": start_seconds,
                        "end": end_seconds,
                        **verdict,
                    })
                except Exception as error:
                    failed.append({"id": candidate_id, "reason": f"{type(error).__name__}: {error}"[:500]})

            return {
                "model": MODEL_ID,
                "revision": self.revision,
                "mode": "verify",
                "results": results,
                "failed": failed,
                "metrics": {
                    "container": self.container,
                    "startup_ms": self.startup_ms,
                    "source_bytes": size,
                    "requested": len(candidates),
                    "total_ms": int((time.time() - started) * 1000),
                },
            }
