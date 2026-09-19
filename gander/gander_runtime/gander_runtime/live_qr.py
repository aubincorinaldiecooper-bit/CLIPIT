"""Write a QR code for the Genesis live page.

A build/deploy-time tool, not a service. The URL is stable, so the code only
has to be made when it changes, and nothing needs to carry a QR dependency
into the serving image: `pip install gander-runtime[qr]` where you generate it.

The one piece of judgement here is `public_live_url`. A QR code is a thing
people print, photograph and pass around, and whatever is inside it is
effectively published. So this refuses to encode anything but a plain public
address: no credentials, no query string, no fragment. If a token ever needs
to reach a phone it must travel some other way.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.parse import urlsplit


class UnsafeQRTarget(ValueError):
    """The URL carries something that must not be printed on a poster."""


def public_live_url(raw: str) -> str:
    """Return ``raw`` if it is safe to encode, else explain why it is not."""

    parts = urlsplit(raw.strip())
    if parts.scheme not in {"http", "https"}:
        raise UnsafeQRTarget("the live URL must be http or https")
    if not parts.hostname:
        raise UnsafeQRTarget("the live URL needs a host")
    if parts.username or parts.password:
        raise UnsafeQRTarget("a QR code must not carry credentials")
    if parts.query:
        raise UnsafeQRTarget(
            "a QR code must not carry a query string: anything in it is "
            "published the moment the code is"
        )
    if parts.fragment:
        raise UnsafeQRTarget("a QR code must not carry a fragment")
    if parts.scheme == "http" and parts.hostname not in {"localhost", "127.0.0.1"}:
        # getUserMedia is refused on insecure origins, so a plain-http poster
        # would send people to a page that cannot ask for the camera at all.
        raise UnsafeQRTarget(
            "browsers refuse camera access on insecure origins; use https"
        )
    return parts.geturl()


def render(url: str, out: Path, *, scale: int = 8) -> Path:
    try:
        import segno
    except ModuleNotFoundError as missing:  # pragma: no cover - depends on env
        raise SystemExit(
            "QR generation needs segno: pip install 'gander-runtime[qr]'"
        ) from missing

    out.parent.mkdir(parents=True, exist_ok=True)
    segno.make(url, error="m").save(str(out), scale=scale, border=2)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QR code for the Genesis live page")
    parser.add_argument("--url", required=True, help="e.g. https://host/live")
    parser.add_argument("--out", default="live-qr.svg", help="output path")
    parser.add_argument("--scale", type=int, default=8)
    args = parser.parse_args(argv)
    try:
        url = public_live_url(args.url)
    except UnsafeQRTarget as unsafe:
        print(f"refusing to encode this URL: {unsafe}", file=sys.stderr)
        return 2
    print(render(url, Path(args.out), scale=args.scale))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
