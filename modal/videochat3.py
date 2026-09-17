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

# How sure the watcher says it is, if it says at all: a number in brackets at
# the very end of what it said. Tolerant of a fraction or a percentage,
# because a model asked for one will sometimes give the other.
_SURENESS_RE = re.compile(r"\s*\[\s*(\d{1,3}(?:\.\d+)?)\s*(%?)\s*\]\s*$")

# Appended to the question the watcher is answering. Kept to one sentence and
# added at the end, because the question is what the model is being asked
# ABOUT THE VIDEO and rewriting it would change what gets found.
_SURENESS_ASK = (
    " When you describe something, end with how sure you are in square"
    " brackets, like [0.8]."
)


def _sureness(said: str) -> tuple[str, float | None]:
    """Split what the watcher said from how sure it said it was.

    Returns the description with the bracket removed, and the sureness as a
    fraction — or None when it did not say, which is an ordinary outcome. A
    model given an instruction does not have to take it, and a number invented
    here to fill the gap would be worth less than nothing: it would look like
    the model's judgement while being ours.
    """
    found = _SURENESS_RE.search(said)
    if not found:
        return said, None
    value = float(found.group(1))
    # A percentage either because it was marked as one, or because a fraction
    # cannot be greater than 1 and 80 plainly means 80%.
    if found.group(2) == "%" or value > 1:
        value = value / 100.0
    if value < 0 or value > 1:
        return said[: found.start()].rstrip(), None
    return said[: found.start()].rstrip(), value


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
        max_rounds: int = 256,
        max_events: int = 64,
    ) -> dict[str, Any]:
        """Watch timestamped browser frames through one stateful session."""
        from PIL import Image

        input_queue = modal.Queue.from_id(input_queue_id)
        output_queue = modal.Queue.from_id(output_queue_id)
        started = time.time()
        session = self.StreamingSession(
            self.engine,
            question=query + _SURENESS_ASK,
            question_time=0,
            max_rounds=max_rounds,
            global_question=True,
            max_tokens=128,
            temperature=0.0,
        )
        events: list[dict[str, Any]] = []
        frames_seen = 0
        last_end = 0.0
        exhausted = False
        end_reason = "the frame stream ended without a terminal event"

        try:
            while frames_seen < max_rounds and len(events) < max_events:
                try:
                    item = input_queue.get(timeout=30)
                except queue.Empty:
                    # Browser navigation/cold starts can leave the queue empty
                    # briefly. An empty poll is not the end of the video.
                    continue
                if not isinstance(item, dict):
                    raise ValueError("stream queue item must be an object")
                kind = item.get("type")
                if kind == "end":
                    exhausted = bool(item.get("exhausted"))
                    end_reason = str(item.get("reason") or "stream ended")[:500]
                    watched = item.get("watched_through_seconds")
                    if isinstance(watched, (int, float)) and watched >= 0:
                        last_end = max(last_end, float(watched))
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
                    # The upstream StreamingSession contract takes PIL images.
                    # copy() detaches the frame before the BytesIO/image closes.
                    frame = picture.convert("RGB").copy()
                start_seconds = timestamp_ms / 1000.0
                end_seconds = (timestamp_ms + duration_ms) / 1000.0
                last_end = max(last_end, end_seconds)
                answer = session.step(
                    frame,
                    round_idx=frames_seen,
                    time_start=start_seconds,
                    time_end=end_seconds,
                )
                frames_seen += 1
                response = _RESPONSE_RE.match(answer or "")
                if response:
                    described, sureness = _sureness(response.group(1).strip())
                    event = {
                        "type": "moment",
                        "start": round(start_seconds, 3),
                        "end": round(end_seconds, 3),
                        "description": described[:1000],
                    }
                    # Absent rather than zero when the watcher did not say: a
                    # zero would read as "sure it is wrong", which is not what
                    # saying nothing means.
                    if sureness is not None:
                        event["confidence"] = round(sureness, 3)
                    events.append(event)
                    output_queue.put(event)

            if frames_seen >= max_rounds and not exhausted:
                end_reason = "VideoChat3 reached its live frame ceiling"
            if len(events) >= max_events and not exhausted:
                end_reason = "VideoChat3 reached its live moment ceiling"

            result = {
                "model": MODEL_ID,
                "revision": self.revision,
                "mode": "watch_stream",
                "duration_seconds": last_end,
                "watched_through_seconds": last_end,
                "exhausted": exhausted,
                "reason": end_reason,
                "events": events,
                "metrics": {
                    "container": self.container,
                    "startup_ms": self.startup_ms,
                    "frames_seen": frames_seen,
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
