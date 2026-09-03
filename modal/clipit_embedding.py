"""
Qwen3-VL-Embedding on Modal: source video URL + time ranges -> one vector each.

WHAT THIS REPLACES, AND WHY IT IS SHAPED THIS WAY
-------------------------------------------------
The deployed service already loads the weights and embeds text correctly. What
it does not yet expose is the contract Clipit's Media Index is built on:

    one private video URL + [{id, start, end}, ...]  ->  one embedding per id

Everything below exists to make that contract cheap and honest.

  * The video is fetched ONCE per call, not once per interval. A twelve-minute
    proxy asked for 144 windows would otherwise be downloaded 144 times.

  * It is cached by `video_key`, NEVER by the URL. Clipit signs a fresh URL for
    every request, so a cache keyed on the URL string would never hit once and
    would silently re-download the same file forever.

  * Every interval carries an `id` chosen by the caller and echoed back
    verbatim. Results are matched by that id, never by position in the list.
    Array position has already cost Clipit real bugs, and a reordered or
    partially-failed batch must be impossible to misread.

  * The reply names the model and the dimension it actually produced. A caller
    can then refuse a mismatch instead of quietly comparing vectors from two
    different models, which looks exactly like working retrieval and is not.

  * Frame sampling is deterministic and reported back. Change how frames are
    picked and you change every vector; a stored embedding whose sampling is
    unknown cannot be compared with a new one.

WHAT THIS SERVICE CANNOT DO
---------------------------
It does not hear. Qwen3-VL is vision + language, so an embedding made here
carries what is VISIBLE and nothing that is audible. Speech reaches the index
as text (see `embed_texts`, used on transcript windows); a non-speech sound —
applause, a door, an engine — has no representation in this stack at all.
Do not let a caller assume otherwise.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass

import modal

APP_NAME = "clipit-embedding"
MODEL_ID = "Qwen/Qwen3-VL-Embedding-2B"
MODEL_REVISION = None  # pin once a known-good revision is confirmed

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "curl")
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


@dataclass(frozen=True)
class Sampling:
    """How frames are chosen inside an interval. Part of a vector's identity."""

    fps: float
    max_frames: int
    short_side: int

    def describe(self) -> dict:
        return {"fps": self.fps, "max_frames": self.max_frames, "short_side": self.short_side}


def cache_path(video_key: str) -> str:
    safe = hashlib.sha256(video_key.encode("utf-8")).hexdigest()[:32]
    return os.path.join(tempfile.gettempdir(), f"clipit-source-{safe}.mp4")


def fetch_once(video_url: str, video_key: str) -> tuple[str, bool]:
    """
    Pull the source down once and keep it for the life of the container.

    Returns the path and whether this call paid the download. A warm container
    asked for a second batch of windows from the same video does no network
    work at all, which is the difference between one fetch per video and one
    per window.
    """
    path = cache_path(video_key)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path, False

    partial = f"{path}.partial"
    # curl rather than requests: this is a large binary over a signed URL, and
    # curl streams it to disk without holding it in memory.
    subprocess.run(
        ["curl", "--silent", "--show-error", "--fail", "--location",
         "--max-time", "900", "--output", partial, video_url],
        check=True,
    )
    os.replace(partial, path)
    return path, True


def decode_interval(path: str, start: float, end: float, sampling: Sampling):
    """
    The frames of ONE interval, as PIL images.

    Seeks before the input so ffmpeg jumps rather than decoding from zero —
    on a proxy with frequent keyframes that makes an arbitrary window as cheap
    to reach as the first one. Frames come out as raw RGB on stdout: no
    intermediate files, nothing to clean up, nothing to leak between calls.
    """
    from PIL import Image
    import numpy as np

    duration = max(0.05, end - start)

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path],
        capture_output=True, text=True, check=True,
    )
    source_w, source_h = (int(value) for value in probe.stdout.strip().split("x")[:2])
    scale = min(1.0, sampling.short_side / max(1, min(source_w, source_h)))
    width = max(2, int(source_w * scale) // 2 * 2)
    height = max(2, int(source_h * scale) // 2 * 2)

    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.3f}", "-i", path, "-t", f"{duration:.3f}",
         "-vf", f"fps={sampling.fps},scale={width}:{height}",
         "-frames:v", str(sampling.max_frames),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    )

    frame_bytes = width * height * 3
    count = len(result.stdout) // frame_bytes
    if count == 0:
        return []
    buffer = np.frombuffer(result.stdout[: count * frame_bytes], dtype=np.uint8)
    return [
        Image.fromarray(buffer[i * frame_bytes : (i + 1) * frame_bytes].reshape(height, width, 3))
        for i in range(count)
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
        kwargs = {"revision": MODEL_REVISION} if MODEL_REVISION else {}
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, **kwargs)
        self.model = AutoModel.from_pretrained(
            MODEL_ID, torch_dtype=torch.float16, device_map="cuda",
            trust_remote_code=True, **kwargs,
        ).eval()
        self.torch = torch

    # ---- the one model-specific seam -------------------------------------
    #
    # Everything else in this file is transport and bookkeeping. This is the
    # only part that depends on how Qwen3-VL-Embedding wants to be called, and
    # it is deliberately alone so it can be reconciled with the implementation
    # already proven in the deployed service without touching the contract
    # around it. Whatever it does, it must return L2-NORMALIZED vectors and it
    # must treat a query and a document consistently — an instruction prefix
    # applied to one and not the other silently wrecks retrieval while still
    # returning confident, plausible rankings.

    def _encode(self, *, frames=None, texts=None, is_query: bool):
        torch = self.torch
        with torch.inference_mode():
            if texts is not None:
                batch = self.processor(text=texts, return_tensors="pt", padding=True).to("cuda")
            else:
                batch = self.processor(videos=frames, return_tensors="pt", padding=True).to("cuda")
            output = self.model(**batch)
            hidden = getattr(output, "last_hidden_state", output)
            # Last-token pooling, the Qwen embedding family's convention.
            mask = batch.get("attention_mask")
            if mask is not None and hidden.ndim == 3:
                lengths = mask.sum(dim=1) - 1
                pooled = hidden[torch.arange(hidden.size(0), device=hidden.device), lengths]
            elif hidden.ndim == 3:
                pooled = hidden[:, -1]
            else:
                pooled = hidden
            return torch.nn.functional.normalize(pooled.float(), p=2, dim=-1).cpu().tolist()

    # ---- the contract ----------------------------------------------------

    @modal.method()
    def embed_video_intervals(
        self,
        video_url: str,
        video_key: str,
        intervals: list[dict],
        fps: float = 2.0,
        max_frames: int = 16,
        short_side: int = 256,
    ) -> dict:
        """
        One vector per interval, from one fetch of one video.

        `intervals` is [{"id": str, "start": float, "end": float}, ...] where
        the seconds are offsets INTO THE FILE AT video_url. The caller owns the
        translation to source time — this service knows nothing about Clipit's
        timeline and must never be trusted to guess it.

        An interval that cannot be decoded comes back in `failed` with its id
        and a reason. It is never silently dropped and never returned as a zero
        vector: a caller must be able to tell "nothing there" from "never
        looked", and a zero vector is indistinguishable from a real answer.
        """
        started = time.time()
        sampling = Sampling(fps=fps, max_frames=max_frames, short_side=short_side)
        path, downloaded = fetch_once(video_url, video_key)
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
                vector = self._encode(frames=[frames], is_query=False)[0]
                infer_ms += int((time.time() - at) * 1000)
                results.append({
                    "id": interval_id,
                    "start": interval["start"],
                    "end": interval["end"],
                    "embedding": vector,
                    "frames": len(frames),
                })
            except Exception as error:  # noqa: BLE001 - reported, never swallowed
                failed.append({"id": interval_id, "reason": f"{type(error).__name__}: {error}"})

        return {
            "model": MODEL_ID,
            "modality": "visual",
            "dim": len(results[0]["embedding"]) if results else None,
            "sampling": sampling.describe(),
            "results": results,
            "failed": failed,
            "metrics": {
                "requested": len(intervals),
                "downloaded": downloaded,
                "fetch_ms": fetch_ms,
                "decode_ms": decode_ms,
                "inference_ms": infer_ms,
                "total_ms": int((time.time() - started) * 1000),
            },
        }

    @modal.method()
    def embed_texts(self, texts: list[dict], is_query: bool = False) -> dict:
        """
        Text into the SAME space as the video vectors.

        Two callers: the question someone typed, and transcript windows. Both
        go through one model so a spoken-word query can be compared with what
        was said and with what was on screen without leaving the space.

        `is_query` exists because these models are usually asymmetric. Getting
        it wrong does not raise — it returns confident, well-ordered, wrong
        results — so it is explicit at the call site rather than inferred.
        """
        started = time.time()
        vectors = self._encode(texts=[item["text"] for item in texts], is_query=is_query)
        return {
            "model": MODEL_ID,
            "modality": "text",
            "dim": len(vectors[0]) if vectors else None,
            "is_query": is_query,
            "results": [
                {"id": item["id"], "embedding": vector} for item, vector in zip(texts, vectors)
            ],
            "failed": [],
            "metrics": {"requested": len(texts), "total_ms": int((time.time() - started) * 1000)},
        }
