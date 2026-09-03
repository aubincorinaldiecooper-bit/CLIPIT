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

    `video_key` is a CONTENT identity, not a path. Clipit's derived keys are
    deterministic — an analysis proxy always lives at
    `proxies/{videoId}/proxy.mp4` — so re-processing a video overwrites the
    object while the key stays put. A warm container caching on the path alone
    would go on embedding the previous footage, producing vectors that are
    well formed, correctly normalized, attached to real timestamps, and about
    a video that no longer exists. Clipit sends `key#etag` (see
    services/mediaIndex/sourceIdentity.ts); this side only has to treat the
    whole string as opaque and never shorten it.

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
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass

import modal

from sampling import DECODE_OVERSAMPLE, Sampling, decode_rate_for, pick_evenly
from sourcecache import cache_path, evict_cache, fetch_once, scrub

APP_NAME = "clipit-embedding"
MODEL_ID = "Qwen/Qwen3-VL-Embedding-2B"
MODEL_REVISION = None  # pin once a known-good revision is confirmed

# What a question is asking the model to do. Part of a query vector's
# identity: change this wording and every stored vector stays valid while
# every future query lands somewhere slightly different.
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
    """
    The frames of ONE interval, as PIL images, spread across all of it.

    Seeks before the input so ffmpeg jumps rather than decoding from zero —
    on a proxy with frequent keyframes that makes an arbitrary window as cheap
    to reach as the first one. Frames come out as raw RGB on stdout: no
    intermediate files, nothing to clean up, nothing to leak between calls.
    """
    from PIL import Image
    import numpy as np

    duration = max(0.05, end - start)
    fps = decode_rate_for(duration, sampling)

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
         "-vf", f"fps={fps:.6f},scale={width}:{height}",
         # Deliberately NOT capped at max_frames here. Truncating the stream is
         # what sampled only the start of a window; the cap is applied by
         # choosing between the decoded frames below, not by stopping early.
         # decode_rate_for bounds how many can arrive.
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
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
    # around it. Whatever it does, it must return L2-NORMALIZED vectors.
    #
    # ASYMMETRY IS THE WHOLE DIFFICULTY. These models want a question and a
    # document phrased differently, and applying the instruction to one side
    # and not the other does not raise anything — it returns confident,
    # well-ordered, wrong rankings. `prepare_text` below is what makes the
    # difference visible, and `describe_formatting` exists so a caller can
    # prove the flag is actually doing something rather than trusting that it
    # is. (The first version of this file took `is_query` and ignored it,
    # which is exactly the failure the paragraph above warns about.)

    def prepare_text(self, text: str, is_query: bool) -> str:
        """
        A question and a document, phrased the way the model expects.

        The Qwen embedding family's convention: a query carries an
        instruction, a document is passed as it is. CONFIRM THIS AGAINST THE
        DEPLOYED IMPLEMENTATION — if the live service already formats queries
        some other way, that formatting wins and this should match it, because
        vectors made under two different conventions cannot be compared and
        nothing about the resulting rankings would look wrong.
        """
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
                # A video is always a document. There is no such thing as
                # asking a question with footage here, so the flag does not
                # reach this branch.
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

    @modal.method()
    def describe_formatting(self, text: str) -> dict:
        """
        What this service actually does to a question versus a document.

        Cheap, no GPU inference, and it exists so the asymmetry can be PROVEN
        rather than assumed. If `query` and `document` come back identical,
        the flag is doing nothing and retrieval is quietly running on
        symmetric embeddings.
        """
        return {
            "model": MODEL_ID,
            "instruction": QUERY_INSTRUCTION,
            "query": self.prepare_text(text, True),
            "document": self.prepare_text(text, False),
        }

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
                vector = self._encode(frames=[frames])[0]
                infer_ms += int((time.time() - at) * 1000)
                results.append({
                    "id": interval_id,
                    "start": interval["start"],
                    "end": interval["end"],
                    "embedding": vector,
                    "frames": len(frames),
                    # The grid this interval was decoded on before frames were
                    # chosen from it. Part of the vector's identity — change it
                    # and the vector changes — so it travels with the result
                    # rather than being inferred from the request.
                    "decode_fps": round(
                        decode_rate_for(float(interval["end"]) - float(interval["start"]), sampling), 4
                    ),
                })
            except Exception as error:  # noqa: BLE001 - reported, never swallowed
                failed.append({"id": interval_id, "reason": scrub(f"{type(error).__name__}: {error}")})

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
