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


def test_both_doors_are_in_the_page(harness):
    """A QR is useless on the device you would scan it with.

    Which one is shown is a CSS decision about pointer type, so both have to be
    present in the markup; the test that they are is the only part a server
    test can hold.
    """

    h = harness()
    with TestClient(h.app) as client:
        body = client.get("/live").text
    assert "Scan with your phone" in body
    assert 'id="start"' in body
    # And neither door is locked: a desktop with a webcam can still opt in.
    assert 'id="useThis"' in body


def test_permission_is_asked_in_our_own_words_first(harness):
    """The sheet exists so the native prompt is never the first thing seen."""

    h = harness()
    with TestClient(h.app) as client:
        body = client.get("/live").text
        source = client.get("/assets/live.js").text
    assert 'id="permission"' in body
    assert "Allow camera and microphone" in body
    # Refusing must stay cheap, which means a way out that is not the browser's.
    assert 'id="cancel"' in body
    # Start must not reach for the camera itself: the native prompt belongs to
    # Allow, or the sheet is decoration over a prompt that already fired.
    start_handler = source.split("ui.start.addEventListener")[1].split("\n")[0]
    assert "ask" in start_handler
    assert "getUserMedia" not in start_handler


def test_the_qr_encodes_this_server_not_a_caller_supplied_url(harness):
    """A QR generator that draws any URL you hand it is a phishing tool.

    Served from your domain, pointing wherever the requester liked. The address
    is derived from the request instead, so the query string cannot steer it.
    """

    h = harness()
    with TestClient(h.app) as client:
        hijack = client.get(
            "/live/qr.svg?url=https://evil.example/steal",
            headers={"host": "genesis.example", "x-forwarded-proto": "https"},
        )
    assert hijack.status_code in {200, 501}
    if hijack.status_code == 200:
        assert b"evil.example" not in hijack.content


def test_the_qr_refuses_an_origin_where_the_camera_cannot_work(harness):
    """Plain http off localhost: browsers refuse getUserMedia there.

    A poster pointing at such an address sends people to a page that cannot
    even ask for the camera, so it is better to render nothing than that.
    """

    h = harness()
    with TestClient(h.app) as client:
        answer = client.get(
            "/live/qr.svg",
            headers={"host": "genesis.example", "x-forwarded-proto": "http"},
        )
    assert answer.status_code == 409
    assert "insecure" in answer.text.lower()


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
