"""The /live phone surface, and what a lean server needs in order to boot."""
from __future__ import annotations

import pytest
import yaml
from starlette.testclient import TestClient


def test_live_page_is_served(harness):
    h = harness()
    with TestClient(h.app) as client:
        page = client.get("/live")
        assert page.status_code == 200
        assert "text/html" in page.headers["content-type"]
        body = page.text
        # The page must not promise sight before the server has confirmed one.
        assert "Let Genesis see what you see." in body
        assert "Genesis can see" not in body


@pytest.mark.parametrize(
    "path,kind",
    [
        ("/assets/live.js", "javascript"),
        ("/assets/live.css", "css"),
        # Reused as-is rather than reimplemented for the phone.
        ("/assets/mic-worklet.js", "javascript"),
    ],
)
def test_live_assets_are_served(harness, path, kind):
    h = harness()
    with TestClient(h.app) as client:
        asset = client.get(path)
        assert asset.status_code == 200
        assert kind in asset.headers["content-type"]


def test_the_phone_client_asks_for_the_rear_camera(harness):
    """Someone pointing a phone at a thing wants the lens on the far side."""

    h = harness()
    with TestClient(h.app) as client:
        source = client.get("/assets/live.js").text
    assert "facingMode: { ideal: 'environment' }" in source
    # `ideal`, not `exact`: a laptop with only a front camera must still work,
    # and `exact` makes the browser throw rather than fall back.
    assert "exact:" not in source


def _config(tmp_path, mode: str) -> str:
    """A release config whose worker cannot possibly be satisfied."""

    model_dir = tmp_path / "model"
    model_dir.mkdir()
    checkpoint = tmp_path / "duplex.pt"
    checkpoint.write_bytes(b"")
    document = {
        "model": {"model_name_or_path": str(model_dir)},
        "duplex": {"checkpoint": str(checkpoint)},
        "server": {"mode": mode},
        "worker": {
            "provider": "codex",
            "cwd": str(tmp_path / "nowhere"),
            "settings": {"codex_bin": str(tmp_path / "no-such-codex")},
        },
    }
    path = tmp_path / f"{mode}.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return str(path)


def test_a_lean_server_boots_without_codex(tmp_path):
    """The direct camera experience must not need an action layer to start.

    A stock config names Codex as the worker provider. Lean mode has no
    coordinator and so never dispatches to it, but preflight used to demand the
    binary anyway — a server refusing to answer "what am I looking at?" over a
    tool it will never call.
    """

    from gander_runtime.cli import load_config, preflight_config

    preflight_config(load_config(_config(tmp_path, "lean")))


def test_a_coordinator_server_still_demands_its_worker(tmp_path):
    """The check is relaxed where it was pointless, not removed."""

    from gander_runtime.cli import load_config, preflight_config

    with pytest.raises(Exception) as raised:
        preflight_config(load_config(_config(tmp_path, "coordinator")))
    assert "worker" in str(raised.value).lower()
