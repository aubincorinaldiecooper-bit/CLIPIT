"""
Qwen3-VL-Reranker on Modal: a question and real footage, not descriptions of it.

The deployed service already scores TEXT documents and — importantly — already
proved that candidate ids survive the round trip. This adds the case Clipit
actually needs: score candidate INTERVALS of a video by looking at the video.

The shape mirrors the embedding service on purpose. One private URL, a list of
{id, start, end}, ids echoed back, the model named in the reply, failures
reported rather than dropped. One contract, two services, one client in Clipit.

Why a reranker exists at all, given the embeddings: retrieval has to be cheap
enough to run over a whole video, so it compares one vector per window and
cannot weigh a question's details. Reranking is expensive enough to look
properly, so it only ever sees the handful of intervals retrieval shortlisted.
Different jobs, and the reranker's job is only meaningful if it is shown the
footage — scoring a prose summary would rank the summary, not the video.
"""

from __future__ import annotations

import time

import modal

from clipit_embedding import decode_interval  # same frame extraction, one copy
from sourcecache import fetch_once, scrub
from sampling import Sampling

APP_NAME = "clipit-reranker"

# The question the model is actually asked about each candidate. Part of a
# score's identity: reword it and every score shifts, so two runs under two
# wordings cannot be compared.
RELEVANCE_PROMPT = (
    "This is a segment of a video. Does it show what the following search is "
    'looking for?\n\nSearch: "{query}"\n\n'
    "Answer with a single word, yes or no."
)
MODEL_ID = "Qwen/Qwen3-VL-Reranker-2B"

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
        import os
        import torch
        from transformers import AutoModelForCausalLM, AutoProcessor

        os.environ.setdefault("HF_HOME", "/weights/hf")
        self.processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            MODEL_ID, torch_dtype=torch.float16, device_map="cuda", trust_remote_code=True,
        ).eval()
        self.torch = torch

    def _score(self, query: str, frames_per_candidate: list) -> list[float]:
        """
        The one model-specific seam, kept alone for the same reason as in the
        embedding service: it is the only part that has to agree with the
        implementation already proven in the deployed wrapper.

        WHAT THE FIRST VERSION DID WRONG, because it is instructive. It handed
        the model the bare query and the frames, took the next-token logits,
        and read off the odds of the tokens "yes" and "no". Nothing anywhere
        asked a question. The model was simply continuing a prompt, and the
        relative likelihood of two arbitrary words in that continuation is not
        a relevance judgement — it is a number that sorts. Every candidate
        would have received a confident score and the ranking would have meant
        nothing, which is the worst failure available here: the reranker exists
        to prove the shortlist can be ordered, and a silent nonsense ordering
        would have looked exactly like success.

        So the judgement is actually asked for. The pair is posed as a yes/no
        relevance question in the model's own chat format, and the answer read
        from the first token of the reply. CONFIRM THE PROMPT AND THE FORMAT
        AGAINST THE DEPLOYED IMPLEMENTATION — if the live service words this
        differently, its wording wins, because scores produced under two
        different prompts are not comparable and nothing in the output would
        show it.

        The contract this file guarantees stays narrow: a HIGHER number means
        MORE relevant, and scores within one call are comparable with each
        other. Nothing promises they are comparable ACROSS calls, so a caller
        ranks and takes the top few rather than applying a threshold.
        """
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
                    messages, tokenize=False, add_generation_prompt=True
                )
                batch = self.processor(
                    text=[prompt], videos=[frames], return_tensors="pt", padding=True
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
        fps: float = 2.0,
        max_frames: int = 16,
        short_side: int = 256,
    ) -> dict:
        """
        Score each candidate interval against the question, by watching it.

        Returns every candidate that could be read, ordered best first, with
        its id. A candidate that could not be decoded is reported in `failed`
        rather than scored zero — a zero would sort last and look exactly like
        a considered judgement that it was irrelevant.
        """
        started = time.time()
        sampling = Sampling(fps=fps, max_frames=max_frames, short_side=short_side)
        path, downloaded = fetch_once(video_url, video_key)

        readable, failed = [], []
        for candidate in candidates:
            try:
                frames = decode_interval(
                    path, float(candidate["start"]), float(candidate["end"]), sampling
                )
                if frames:
                    readable.append((candidate, frames))
                else:
                    failed.append({"id": candidate["id"], "reason": "no frames decoded for this range"})
            except Exception as error:  # noqa: BLE001
                failed.append({"id": candidate["id"], "reason": scrub(f"{type(error).__name__}: {error}")})

        scores = self._score(query, [frames for _, frames in readable]) if readable else []
        ranked = [
            {"id": candidate["id"], "start": candidate["start"], "end": candidate["end"], "score": score}
            for (candidate, _), score in zip(readable, scores)
        ]
        ranked.sort(key=lambda row: row["score"], reverse=True)

        return {
            "model": MODEL_ID,
            "sampling": sampling.describe(),
            "results": ranked,
            "failed": failed,
            "metrics": {
                "requested": len(candidates),
                "downloaded": downloaded,
                "total_ms": int((time.time() - started) * 1000),
            },
        }
