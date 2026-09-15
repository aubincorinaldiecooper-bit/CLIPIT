"""Versioned Modal definition for Clipit's existing Gander Thinker service.

The Gander runtime is vendored under ``gander/``. This deployment keeps the
existing Modal app/function identity while moving the source of truth into
CLIPIT. Model weights and secrets remain external runtime prerequisites.
"""

from __future__ import annotations

import os
import subprocess

import modal

APP_NAME = "clipit-gander-thinker"
PORT = 7975
CONFIG_PATH = "/workspace/gander/configs/clipit-video-search.yaml"

# These names were never versioned in CLIPIT. Require them explicitly rather
# than guessing and accidentally creating a second production resource.
MODELS_VOLUME_NAME = os.environ.get("GANDER_MODELS_VOLUME")
SECRET_NAME = os.environ.get("GANDER_SECRET_NAME")
if not MODELS_VOLUME_NAME:
    raise RuntimeError("Set GANDER_MODELS_VOLUME to the existing Gander model Volume name")
if not SECRET_NAME:
    raise RuntimeError("Set GANDER_SECRET_NAME to the existing Modal Secret containing ORNITH_API_KEY")

models = modal.Volume.from_name(MODELS_VOLUME_NAME, create_if_missing=False)
ornith_secret = modal.Secret.from_name(SECRET_NAME)

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
    .run_commands(
        "python -m pip install --no-deps /workspace/gander/minicpm_ft",
        "python -m pip install --no-deps /workspace/gander/gander_runtime",
        "mkdir -p /workspace /var/gander /var/gander/ledger",
    )
)

app = modal.App(APP_NAME, image=image, include_source=False)


@app.function(volumes={"/models": models}, timeout=600)
def cache_gander_models() -> dict[str, str]:
    """Validate that the externally supplied model volume is populated."""
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
    secrets=[ornith_secret],
    timeout=24 * 60 * 60,
    scaledown_window=60,
)
@modal.web_server(PORT, startup_timeout=1800)
def gander_server() -> None:
    """Serve Gander from the vendored CLIPIT runtime."""
    env = os.environ.copy()
    env.setdefault("CUDA_VISIBLE_DEVICES", "0")
    subprocess.Popen(
        ["gander-serve", "--config", CONFIG_PATH],
        cwd="/workspace",
        env=env,
    )
