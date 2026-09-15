"""Authenticated ASGI entrypoint for the vendored Gander runtime.

This file runs inside the Modal container. It keeps Gander's own runtime code
unchanged while making Clipit -> Gander a real authenticated service boundary.
"""

from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Any

import yaml

from gander_runtime.cli import build_app, load_config

BASE_CONFIG_PATH = Path("/workspace/gander/configs/clipit-video-search.yaml")
RUNTIME_CONFIG_PATH = Path("/tmp/clipit-gander-runtime.yaml")


def _runtime_config_path() -> Path:
    document = yaml.safe_load(BASE_CONFIG_PATH.read_text(encoding="utf-8")) or {}
    ornith_base_url = (os.environ.get("ORNITH_BASE_URL") or "").strip()
    if not ornith_base_url:
        raise RuntimeError("ORNITH_BASE_URL is required")

    worker = document.setdefault("worker", {})
    settings = worker.setdefault("settings", {})
    settings["base_url"] = ornith_base_url.rstrip("/")

    RUNTIME_CONFIG_PATH.write_text(
        yaml.safe_dump(document, sort_keys=False),
        encoding="utf-8",
    )
    return RUNTIME_CONFIG_PATH


class BearerAuthASGI:
    """Require Clipit's GANDER_API_KEY for every Gander route except /health."""

    def __init__(self, app: Any, api_key: str) -> None:
        if not api_key:
            raise RuntimeError("GANDER_API_KEY is required")
        self.app = app
        self.expected = f"Bearer {api_key}".encode("utf-8")

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        scope_type = scope.get("type")
        if scope_type == "lifespan":
            await self.app(scope, receive, send)
            return

        if scope_type == "http" and scope.get("path") == "/health":
            await self.app(scope, receive, send)
            return

        if scope_type not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        provided = headers.get(b"authorization", b"")
        if provided and hmac.compare_digest(provided, self.expected):
            await self.app(scope, receive, send)
            return

        if scope_type == "websocket":
            await send({"type": "websocket.close", "code": 4401, "reason": "unauthorized"})
            return

        body = b'{"detail":"unauthorized"}'
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"www-authenticate", b"Bearer"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


_inner_app = build_app(load_config(_runtime_config_path()))
app = BearerAuthASGI(_inner_app, (os.environ.get("GANDER_API_KEY") or "").strip())
