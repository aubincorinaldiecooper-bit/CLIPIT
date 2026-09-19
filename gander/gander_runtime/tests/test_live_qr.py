"""What is allowed inside the QR code.

A QR code is published the moment it is printed. These are the things that
must never end up on a poster.
"""
from __future__ import annotations

import pytest

from gander_runtime.live_qr import UnsafeQRTarget, public_live_url


def test_a_plain_https_live_url_is_fine():
    assert public_live_url("https://genesis.example/live") == "https://genesis.example/live"


def test_localhost_over_http_is_allowed_for_development():
    assert public_live_url("http://localhost:8000/live").startswith("http://localhost")


@pytest.mark.parametrize(
    "url,because",
    [
        ("https://user:hunter2@genesis.example/live", "credentials"),
        ("https://genesis.example/live?token=abc123", "query"),
        ("https://genesis.example/live#session=abc", "fragment"),
        # Browsers refuse getUserMedia on an insecure origin, so this poster
        # would send people to a page that cannot even ask for the camera.
        ("http://genesis.example/live", "insecure"),
        ("ftp://genesis.example/live", "http"),
        ("not a url", "http"),
    ],
)
def test_refused(url, because):
    with pytest.raises(UnsafeQRTarget) as raised:
        public_live_url(url)
    assert because in str(raised.value).lower()
