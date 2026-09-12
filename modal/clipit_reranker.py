"""Qwen3-VL reranker used after candidate retrieval and before final verification.

It scores exact candidate video intervals against the query. This restores the
reranker service only; it does not restore the retired Media Index.
"""

from __future__ import annotations

import os
import time
import uuid

import modal

from clipit_embedding import decode_interval
from sampling import Sampling
from sourcecache import fetch_once, scrub

APP_NAME = "clipit-reranker"
MODEL_ID = "Qwen/Qwen3-VL-Reranker-2B"
MODEL_REVISION = os.environ.get("QWEN_RERANK_REVISION") or None
RELEVANCE_PROMPT = (
    "This is a segment of a video. Does it show what the following search is "
    'looking for?\n\nSearch: "{query}"\n\n'
    "Answer with a single word, yes or no."
)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "curl")
    .pip_install("torch", "transformers", "accelerate", "pillow", "numpy")
    .add_local_python_source("clipit_embedding", "sampling", "sourcecache")
)

app = modal.App(APP_NAME, image=image)
weights = modal.Volume.from_name("clipit-qwen-weights", create_if_missing=True)


@app.cls(gpu="L4", volumes={"/weights": weights}, scaledown_window=300, timeout=1800)
class QwenRerankerService:
    @modal.enter()
    def load(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        os.environ.setdefault("HF_HOME", "/weights/hf")
        started = time.time()
        kwargs = {"revision": MODEL_REVISION} if MODEL_REVISION else {}
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True, **kwargs)
        self.model = AutoModelForCausalLM.from_pretrained(
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

    def _score(self, query: str, frames_per_candidate: list) -> list[float]:
        torch = self.torch
        scores: list[float] = []
        yes_id = self.processor.tokenizer.convert_tokens_to_ids("yes")
        no_id = self.processor.tokenizer.convert_tokens_to_ids("no")

        with torch.inference_mode():
            for frames in frames_per_candidate:
                messages = [{
                    "role": "user",
                    "content": [
                        {"type": "video"},
                        {"type": "text", "text": RELEVANCE_PROMPT.format(query=query)},
                    ],
                }]
                prompt = self.processor.apply_chat_template(
                    messages,
                    tokenize=False,
                    add_generation_prompt=True,
                )
                batch = self.processor(
                    text=[prompt],
                    videos=[frames],
                    return_tensors="pt",
                    padding=True,
                ).to("cuda")
                logits = self.model(**batch).logits[:, -1, :]
                pair = torch.stack([logits[0, no_id], logits[0, yes_id]]).float()
                scores.append(torch.softmax(pair, dim=0)[1].item())
        return scores

    @modal.method()
    def rerank_video_intervals(
        self,
        query: str,
        video_url: str,
        video_key: str,
        candidates: list[dict],
        expect_bytes: int | None = None,
        fps: float = 2.0,
        max_frames: int = 16,
        short_side: int = 256,
    ) -> dict:
        started = time.time()
        sampling = Sampling(fps=fps, max_frames=max_frames, short_side=short_side)
        path, downloaded = fetch_once(video_url, video_key, expect_bytes)
        readable, failed = [], []

        for candidate in candidates:
            try:
                frames = decode_interval(
                    path,
                    float(candidate["start"]),
                    float(candidate["end"]),
                    sampling,
                )
                if frames:
                    readable.append((candidate, frames))
                else:
                    failed.append({"id": candidate["id"], "reason": "no frames decoded for this range"})
            except Exception as error:  # noqa: BLE001
                failed.append({
                    "id": candidate["id"],
                    "reason": scrub(f"{type(error).__name__}: {error}"),
                })

        scores = self._score(query, [frames for _, frames in readable]) if readable else []
        ranked = [
            {
                "id": candidate["id"],
                "start": candidate["start"],
                "end": candidate["end"],
                "score": score,
            }
            for (candidate, _), score in zip(readable, scores)
        ]
        ranked.sort(key=lambda row: row["score"], reverse=True)

        return {
            "model": MODEL_ID,
            "revision": self.revision,
            "sampling": sampling.describe(),
            "results": ranked,
            "failed": failed,
            "metrics": {
                "requested": len(candidates),
                "downloaded": downloaded,
                "container": self.container,
                "startup_ms": self.startup_ms,
                "total_ms": int((time.time() - started) * 1000),
            },
        }
