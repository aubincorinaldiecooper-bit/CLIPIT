"""What the live camera path is allowed to leave on disk.

A public QR code puts a stranger's camera in front of this server. What it
writes down is therefore a product decision, not an implementation detail, and
these tests are the record of it.
"""
from __future__ import annotations

import json

from starlette.testclient import TestClient

from test_duplex_lifecycle import (
    _drain_until,
    _jpeg,
    _open_screen,
    _screen_header,
    connect,
)


def _camera_header(frame_id: str) -> dict:
    return _screen_header(frame_id) | {"video_source": "camera"}


def _written(media_dir) -> list:
    """Every file the server left behind."""

    if media_dir is None or not media_dir.exists():
        return []
    return [path for path in media_dir.rglob("*") if path.is_file()]


def _send(client, h, header: dict) -> dict:
    with connect(client, "/ws/duplex?session_id=s1") as ws:
        with _open_screen(client, ws) as screen:
            _drain_until(screen, "screen.ready")
            screen.send_text(json.dumps(header))
            screen.send_bytes(_jpeg())
            return _drain_until(screen, "screen.frame.accepted")


def test_a_lean_server_writes_no_camera_frame(harness):
    """The public-QR case: seen, answered, nothing kept."""

    h = harness(media_mode="omni", provider_name=None)
    with TestClient(h.app) as client:
        accepted = _send(client, h, _camera_header("f1"))

    assert accepted["frame_id"] == "f1"
    # It was seen.
    assert h.coordinators, "the session really did build a coordinator"
    # And nothing was kept.
    assert _written(h.media_dir) == []


def test_a_lean_server_writes_no_screen_frame_either(harness):
    """With no back brain there is no reader, so the write is simply waste.

    This is the test that pins *which* signal the gate reads, and it was
    written after getting it wrong. The plausible-looking check — "is there a
    coordinator?" — is wrong: `active.coordinator` is the per-session realtime
    task coordinator, which is built for every session including a lean one, so
    it is essentially never None. Gate on that and this test fails while the
    camera tests sail through, because the camera opt-in masks it. Verified by
    reintroducing that exact mistake.
    """

    h = harness(media_mode="omni", provider_name=None)
    with TestClient(h.app) as client:
        _send(client, h, _screen_header("f1"))
    assert _written(h.media_dir) == []


def test_a_camera_frame_is_not_written_by_default(harness):
    """Even with a back brain, the camera is opt-in."""

    h = harness(media_mode="omni")
    with TestClient(h.app) as client:
        _send(client, h, _camera_header("f1"))
    assert _written(h.media_dir) == []


def test_a_camera_frame_is_written_when_asked_for(harness):
    """Opting in still works, so the capability is off rather than gone."""

    h = harness(media_mode="omni", persist_camera_frames=True)
    with TestClient(h.app) as client:
        _send(client, h, _camera_header("f1"))
    assert _written(h.media_dir), "explicit opt-in should still persist"


def test_screen_sharing_to_a_back_brain_is_unchanged(harness):
    """The case that was always a deliberate bargain keeps working.

    Someone sharing a window with a worker that has to read it is not the same
    as a stranger's phone camera, and this change was not meant to touch it.
    """

    h = harness(media_mode="omni")
    with TestClient(h.app) as client:
        _send(client, h, _screen_header("f1"))
    assert _written(h.media_dir), "screen frames still reach the back brain"
