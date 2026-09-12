"""VideoChat3 on Modal for Clipit's internet-video search.

One L4-backed service owns the model weights and exposes two jobs:

* ``watch``: a progressive first pass over a candidate video using the
  official VideoChat3 StreamingSession / VideoFrameExtractor implementation.
  It returns timestamped response events. These are retrieval leads, not
  user-facing evidence.
* ``verify_intervals``: a dense second look at exact source intervals and a
  strict relevance judgement. Only this path is eligible to become evidence
  after Clipit's retrieval/reranking stages have narrowed the search.

The service is separate from MiniCPM so the two models can scale independently
for concurrent searches. Both use L4 GPUs.
"""

from __future__ import annotations

import json
import os
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

    def _verify_clip(self, clip_path: Path, query: str) -> dict[str, Any]:
        from qwen_vl_utils import process_vision_info

        prompt = (
            "You are verifying actual video evidence for a search result. "
            "Judge only what is visible in this clip. Do not infer missing events.\n\n"
            f"Search: {query}\n\n"
            "Return JSON only with exactly these keys: "
            '{"match": true|false, "confidence": 0.0-1.0, "description": "brief visible evidence"}.'
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
                    clip = work / f"candidate-{index}.mp4"
                    _cut_interval(source, clip, start_seconds, end_seconds)
                    verdict = self._verify_clip(clip, query)
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
