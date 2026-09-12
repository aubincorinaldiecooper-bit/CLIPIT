"""Qwen3-VL embedding service used as Clipit's post-retrieval precision layer.

This is intentionally independent of SimpleMem's own CLIP memory space. It
accepts text queries or exact video intervals and returns normalized Qwen
embeddings. Restoring this deployment does not restore the retired Media Index.
"""

from __future__ import annotations

import os
import subprocess
import time
import uuid

import modal

from sampling import Sampling, decode_rate_for, pick_evenly
from sourcecache import fetch_once, scrub

APP_NAME = "clipit-embedding"
MODEL_ID = "Qwen/Qwen3-VL-Embedding-2B"
MODEL_REVISION = os.environ.get("QWEN_EMBED_REVISION") or None
QUERY_INSTRUCTION = "Given a search query, retrieve the moment of video that matches it"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "curl")
    .add_local_python_source("sampling", "sourcecache")
    .pip_install(
        "torch",
        "transformers",
        "accelerate",
        "pillow",
        "numpy",
        "requests",
    )
)

app = modal.App(APP_NAME, image=image)
weights = modal.Volume.from_name("clipit-qwen-weights", create_if_missing=True)


def decode_interval(path: str, start: float, end: float, sampling: Sampling):
    """Decode representative frames across one source interval."""
    from PIL import Image
    import numpy as np

    duration = max(0.05, end - start)
    fps = decode_rate_for(duration, sampling)
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    source_w, source_h = (int(value) for value in probe.stdout.strip().split("x")[:2])
    scale = min(1.0, sampling.short_side / max(1, min(source_w, source_h)))
    width = max(2, int(source_w * scale) // 2 * 2)
    height = max(2, int(source_h * scale) // 2 * 2)

    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start:.3f}", "-i", path, "-t", f"{duration:.3f}",
            "-vf", f"fps={fps:.6f},scale={width}:{height}",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        capture_output=True,
        check=True,
    )

    frame_bytes = width * height * 3
    count = len(result.stdout) // frame_bytes
    if count == 0:
        return []
    buffer = np.frombuffer(result.stdout[: count * frame_bytes], dtype=np.uint8)
    keep = pick_evenly(count, sampling.max_frames)
    return [
        Image.fromarray(buffer[i * frame_bytes : (i + 1) * frame_bytes].reshape(height, width, 3))
        for i in keep
    ]


@app.cls(
    gpu="L4",
    volumes={"/weights": weights},
    scaledown_window=300,
    timeout=1800,
)
class QwenEmbeddingService:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoModel, AutoProcessor

        os.environ.setdefault("HF_HOME", "/weights/hf")
        started = time.time()
        kwargs = {"revision": MODEL_REVISION} if MODEL_REVISION else {}
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, **kwargs)
        self.model = AutoModel.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.float16,
            device_map="cuda",
            trust_remote_code=True,
            **kwargs,
        ).eval()
        self.torch = torch
        self.startup_ms = int((time.time() - started) * 1000)
        self.container = uuid.uuid4().hex[:12]
        self.revision = MODEL_REVISION or getattr(
            getattr(self.model, "config", None), "_commit_hash", None
        ) or "unpinned"

    def prepare_text(self, text: str, is_query: bool) -> str:
        if not is_query:
            return text
        return f"Instruct: {QUERY_INSTRUCTION}\nQuery: {text}"

    def _encode(self, *, frames=None, texts=None, is_query: bool = False):
        torch = self.torch
        with torch.inference_mode():
            if texts is not None:
                prepared = [self.prepare_text(text, is_query) for text in texts]
                batch = self.processor(text=prepared, return_tensors="pt", padding=True).to("cuda")
            else:
                batch = self.processor(videos=frames, return_tensors="pt", padding=True).to("cuda")
            output = self.model(**batch)
            hidden = getattr(output, "last_hidden_state", output)
            mask = batch.get("attention_mask")
            if mask is not None and hidden.ndim == 3:
                lengths = mask.sum(dim=1) - 1
                pooled = hidden[torch.arange(hidden.size(0), device=hidden.device), lengths]
            elif hidden.ndim == 3:
                pooled = hidden[:, -1]
            else:
                pooled = hidden
            return torch.nn.functional.normalize(pooled.float(), p=2, dim=-1).cpu().tolist()

    @modal.method()
    def describe_formatting(self, text: str) -> dict:
        return {
            "model": MODEL_ID,
            "revision": self.revision,
            "instruction": QUERY_INSTRUCTION,
            "query": self.prepare_text(text, True),
            "document": self.prepare_text(text, False),
        }

    @modal.method()
    def embed_video_intervals(
        self,
        video_url: str,
        video_key: str,
        intervals: list[dict],
        expect_bytes: int | None = None,
        fps: float = 2.0,
        max_frames: int = 16,
        short_side: int = 256,
    ) -> dict:
        started = time.time()
        sampling = Sampling(fps=fps, max_frames=max_frames, short_side=short_side)
        path, downloaded = fetch_once(video_url, video_key, expect_bytes)
        fetch_ms = int((time.time() - started) * 1000)
        results, failed = [], []
        decode_ms = infer_ms = 0

        for interval in intervals:
            interval_id = interval["id"]
            try:
                at = time.time()
                frames = decode_interval(path, float(interval["start"]), float(interval["end"]), sampling)
                decode_ms += int((time.time() - at) * 1000)
                if not frames:
                    failed.append({"id": interval_id, "reason": "no frames decoded for this range"})
                    continue
                at = time.time()
                vector = self._encode(frames=[frames])[0]
                infer_ms += int((time.time() - at) * 1000)
                results.append({
                    "id": interval_id,
                    "start": interval["start"],
                    "end": interval["end"],
                    "embedding": vector,
                    "frames": len(frames),
                    "decode_fps": round(
                        decode_rate_for(float(interval["end"]) - float(interval["start"]), sampling), 4
                    ),
                })
            except Exception as error:  # noqa: BLE001
                failed.append({"id": interval_id, "reason": scrub(f"{type(error).__name__}: {error}")})

        return {
            "model": MODEL_ID,
            "revision": self.revision,
            "modality": "visual",
            "dim": len(results[0]["embedding"]) if results else None,
            "sampling": sampling.describe(),
            "results": results,
            "failed": failed,
            "metrics": {
                "requested": len(intervals),
                "downloaded": downloaded,
                "container": self.container,
                "startup_ms": self.startup_ms,
                "fetch_ms": fetch_ms,
                "decode_ms": decode_ms,
                "inference_ms": infer_ms,
                "total_ms": int((time.time() - started) * 1000),
            },
        }

    @modal.method()
    def embed_texts(self, texts: list[dict], is_query: bool = False) -> dict:
        started = time.time()
        vectors = self._encode(texts=[item["text"] for item in texts], is_query=is_query)
        return {
            "model": MODEL_ID,
            "revision": self.revision,
            "modality": "text",
            "dim": len(vectors[0]) if vectors else None,
            "is_query": is_query,
            "results": [
                {"id": item["id"], "embedding": vector}
                for item, vector in zip(texts, vectors)
            ],
            "failed": [],
            "metrics": {
                "requested": len(texts),
                "container": self.container,
                "startup_ms": self.startup_ms,
                "total_ms": int((time.time() - started) * 1000),
            },
        }
