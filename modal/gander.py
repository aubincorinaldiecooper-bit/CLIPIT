"""Versioned Modal definition for Clipit's Gander Thinker service."""

from __future__ import annotations

import os

import modal

APP_NAME = os.environ.get("GANDER_APP_NAME", "clipit-gander-thinker-test")
MODELS_VOLUME_NAME = os.environ.get("GANDER_MODELS_VOLUME", "clipit-gander-weights")
SECRET_NAME = os.environ.get("GANDER_SECRET_NAME", "clipit-gander-ornith")

models = modal.Volume.from_name(MODELS_VOLUME_NAME, create_if_missing=False)
gander_secret = modal.Secret.from_name(SECRET_NAME)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(
        "build-essential",
        "ffmpeg",
        "git",
        "libgl1",
        "libglib2.0-0",
        "libsndfile1",
    )
    .uv_pip_install(
        "torch==2.6.0",
        "transformers==4.51.0",
        "accelerate>=1.10,<2",
        "av>=14,<18",
        "deepspeed>=0.19,<0.20",
        "librosa>=0.9,<0.11",
        "numpy>=1.26,<2",
        "pillow>=10",
        "pyarrow>=15",
        "pyyaml>=6",
        "safetensors>=0.4",
        "scipy>=1.11",
        "soundfile>=0.12",
        "tqdm>=4.66",
        "fastapi>=0.110",
        "uvicorn[standard]>=0.29",
        "websockets>=12",
    )
    .add_local_dir("gander", remote_path="/workspace/gander", copy=True)
    .add_local_file("modal/gander_entrypoint.py", remote_path="/workspace/gander_entrypoint.py", copy=True)
    .run_commands(
        "python -m pip install --no-deps /workspace/gander/minicpm_ft",
        "python -m pip install --no-deps /workspace/gander/gander_runtime",
        "mkdir -p /workspace /var/gander /var/gander/ledger",
    )
)

app = modal.App(APP_NAME, image=image, include_source=False)


@app.function(volumes={"/models": models}, timeout=600)
def cache_gander_models() -> dict[str, str]:
    from pathlib import Path

    model_dir = Path("/models/MiniCPM-o-4_5")
    thinker_checkpoint = Path("/models/Gander/thinker")
    if not model_dir.is_dir():
        raise FileNotFoundError(f"MiniCPM model directory not found: {model_dir}")
    if not thinker_checkpoint.exists():
        raise FileNotFoundError(f"Gander Thinker checkpoint not found: {thinker_checkpoint}")
    return {"model": str(model_dir), "thinker": str(thinker_checkpoint)}


@app.function(
    gpu="L40S",
    volumes={"/models": models},
    secrets=[gander_secret],
    timeout=24 * 60 * 60,
    scaledown_window=60,
)
@modal.asgi_app()
def gander_server():
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "0")
    from gander_entrypoint import app as asgi_app

    return asgi_app
