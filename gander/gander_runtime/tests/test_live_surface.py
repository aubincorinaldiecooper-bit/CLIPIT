"""The /live phone surface, and what a server needs in order to boot.

A note on what half of these prove. The config tests run the real
`preflight_config` and `load_config`, so they hold actual behaviour. The client
tests read `live.js` as text and assert on what is in it, because this suite
has no browser: they will catch the protocol mistakes coming back, which is
what they are for, but they cannot tell you the page works. Only driving it in
a browser does that, and a real device does it properly.
"""
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


def _config(tmp_path, provider: str, name: str, **duplex) -> str:
    """A release config whose worker, if it has one, cannot be satisfied."""

    model_dir = tmp_path / "model"
    model_dir.mkdir(exist_ok=True)
    checkpoint = tmp_path / "duplex.pt"
    checkpoint.write_bytes(b"")
    document = {
        "model": {"model_name_or_path": str(model_dir)},
        "duplex": {"checkpoint": str(checkpoint), **duplex},
        "server": {"mode": "lean"},
        "worker": {
            "provider": provider,
            "cwd": str(tmp_path / "nowhere"),
            "settings": {"codex_bin": str(tmp_path / "no-such-codex")},
        },
    }
    path = tmp_path / f"{name}.yaml"
    path.write_text(yaml.safe_dump(document), encoding="utf-8")
    return str(path)


def test_a_server_with_no_action_layer_boots_without_codex(tmp_path):
    """`worker.provider: none` is how a deployment says it has no action layer.

    The direct camera experience does not dispatch work, and a stock config
    names Codex, so it refused to boot over a binary it would never call.
    """

    from gander_runtime.cli import load_config, preflight_config

    preflight_config(load_config(_config(tmp_path, "none", "none")))


def test_a_configured_worker_is_still_demanded(tmp_path):
    """Naming a provider still means it has to be there.

    This is the correction to the first attempt, which keyed off `server.mode`
    on the theory that lean mode never dispatches. It does: `task_start`,
    `task_send` and `task_resolve` are native tools the model can call, and
    `gateway.task_start` resolves a provider itself. An empty registry would
    have refused every one of them with `no_eligible_worker`. Caught by Codex.
    """

    from gander_runtime.cli import load_config, preflight_config

    with pytest.raises(Exception) as raised:
        preflight_config(load_config(_config(tmp_path, "codex", "codex")))
    assert "worker" in str(raised.value).lower()


def test_the_camera_opt_in_can_actually_be_set(tmp_path):
    """An opt-in no deployment can reach is not an opt-in.

    `persist_camera_frames` lived only on the Python settings object; unknown
    YAML keys are rejected and nothing forwarded a value, so every real
    `gander-serve` was stuck at false whatever its operator wanted. Caught by
    Codex.
    """

    from gander_runtime.cli import load_config

    config = load_config(
        _config(tmp_path, "none", "optin", persist_camera_frames=True)
    )
    assert config.duplex.persist_camera_frames is True
    # And off unless asked, which is the half that matters for a public QR.
    assert load_config(
        _config(tmp_path, "none", "default")
    ).duplex.persist_camera_frames is False


def test_the_client_negotiates_camera_mode_before_opening_the_screen(harness):
    """A session starts in voice mode and refuses every frame while it is.

    Opening /ws/screen first looks like it works and then waits for a frame
    that will never be accepted. Caught by Codex.
    """

    h = harness()
    with TestClient(h.app) as client:
        source = client.get("/assets/live.js").text
    assert "'media.mode'" in source
    assert "media.mode.done" in source
    # The screen socket is attached from the mode acknowledgement, not from
    # `ready`. If `attachScreen` moves back under `ready`, this fails.
    after_ready = source.split("case 'ready':")[1].split("case 'media.mode.done'")[0]
    assert "attachScreen" not in after_ready


def test_the_client_renders_model_chunks(harness):
    """`turn.final.accepted` carries no text; `chunk` does.

    Reading the wrong one left the page silent whenever speech was off.
    """

    h = harness()
    with TestClient(h.app) as client:
        source = client.get("/assets/live.js").text
    assert "case 'chunk':" in source
    assert "case 'turn.final.accepted':" not in source


def test_end_says_stop_rather_than_dropping_the_socket(harness):
    """An explicit stop is never parked; a dropped socket is.

    Closing outright holds the single model slot for the whole reconnect
    grace, so ending a session and scanning again told the next person Genesis
    was busy — because of the session they had just ended. Caught by Codex.
    """

    h = harness()
    with TestClient(h.app) as client:
        source = client.get("/assets/live.js").text
    assert "type: 'stop'" in source
    assert "session.done" in source
    # Bounded: a server that never answers must not strand a live camera.
    stop_block = source.split("type: 'stop'")[0]
    assert "setTimeout(resolve" in stop_block
