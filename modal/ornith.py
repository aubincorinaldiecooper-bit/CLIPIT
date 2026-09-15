"""Versioned Modal deployment for Clipit's Ornith Brain service.

This mirrors the runtime characteristics observed in the notebook deployment:
Ornith-1.5-9B served through vLLM's OpenAI-compatible API on a single L40S.
"""

from __future__ import annotations

import os
import subprocess

import modal

APP_NAME = os.environ.get("ORNITH_APP_NAME", "clipit-ornith-brain-v2-test")
PORT = 8000
MODEL = "ornith-ai/Ornith-1.5-9B"
SERVED_MODEL_NAME = "ornith"
CACHE_VOLUME_NAME = os.environ.get("ORNITH_CACHE_VOLUME", "clipit-ornith-cache")
SECRET_NAME = os.environ.get("ORNITH_SECRET_NAME", "clipit-gander-ornith")

cache = modal.Volume.from_name(CACHE_VOLUME_NAME, create_if_missing=False)
ornith_secret = modal.Secret.from_name(SECRET_NAME)

image = (
    modal.Image.from_registry("vllm/vllm-openai:v0.29.0")
    .entrypoint([])
)

app = modal.App(APP_NAME, image=image, include_source=False)


@app.function(
    gpu="L40S",
    volumes={"/root/.cache/huggingface": cache},
    secrets=[ornith_secret],
    timeout=24 * 60 * 60,
    scaledown_window=60,
)
@modal.web_server(PORT, startup_timeout=1800)
def ornith_server_v2() -> None:
    api_key = (os.environ.get("ORNITH_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("ORNITH_API_KEY is required")

    subprocess.Popen(
        [
            "vllm",
            "serve",
            MODEL,
            "--host",
            "0.0.0.0",
            "--port",
            str(PORT),
            "--served-model-name",
            SERVED_MODEL_NAME,
            "--dtype",
            "bfloat16",
            "--max-model-len",
            "32768",
            "--trust-remote-code",
            "--enable-prefix-caching",
            "--enable-chunked-prefill",
            "--reasoning-parser",
            "qwen3",
            "--api-key",
            api_key,
        ],
        env=os.environ.copy(),
    )
