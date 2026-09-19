"""Write a QR code for the Genesis live page.

A build/deploy-time tool, not a service. The URL is stable, so the code only
has to be made when it changes, and nothing needs to carry a QR dependency
into the serving image: `pip install gander-runtime[qr]` where you generate it.

The one piece of judgement here is `public_live_url`. A QR code is a thing
people print, photograph and pass around, and whatever is inside it is
effectively published. So this refuses to encode anything but a plain public
address: no credentials, no query string, no fragment. If a token ever needs
to reach a phone it must travel some other way.

The drawing is Spell UI's QR treatment, reproduced by hand in `styled_svg`:
that component is React, and this page has no React, so the look is ported
and the package is not.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable, Sequence
from urllib.parse import urlsplit
from xml.sax.saxutils import escape


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


# Spell UI draws these three squares for every finder pattern, in canvas units
# on a 268-unit canvas, so the corners are the same at any module count.
_FINDER_RX = (12, 8, 3)
_CANVAS = 268


def _in_finder(row: int, col: int, count: int) -> bool:
    """Upstream's `isInFinderPattern`: the three 7x7 corners."""

    return (
        (row < 7 and col < 7)
        or (row < 7 and col >= count - 7)
        or (row >= count - 7 and col < 7)
    )


def _num(value: float) -> str:
    """Compact SVG numbers: `8.12` rather than `8.120000000000001`."""

    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text if text else "0"


def styled_svg(
    matrix: Sequence[Iterable[int]],
    *,
    size: int = _CANVAS,
    px: int | None = None,
    quiet: int = 0,
    fg: str = "#FFFFFF",
    bg: str = "#111827",
    label: str | None = None,
) -> str:
    """Spell UI's QR code, drawn from a module matrix.

    The geometry is the upstream component's (registry/spell-ui/qr-code.tsx,
    defaults `size=268`, error level M): a square canvas divided evenly by the
    module count; every dark module outside the three finder patterns a circle
    of radius one third of a module at the module's centre; each finder three
    nested rounded squares — seven modules of foreground (rx 12), five of
    background inset one module (rx 8), three of foreground inset two (rx 3) —
    on a background rounded to 12, white on Night by default because that is
    the brand's QR surface. The radii are canvas units, as upstream,
    so the corners look the same whatever the module count.

    Upstream draws no quiet zone and leaves the margin to whatever surrounds
    it, which is what the page's white card is for. A poster has nothing
    around it, so the deploy-time script asks for `quiet=4`, the modules of
    margin the QR specification wants.

    `px` is the rendered width and height; the viewBox stays `size` so scaling
    the picture never changes its corners.
    """

    rows = [list(row) for row in matrix]
    count = len(rows)
    if count == 0 or any(len(row) != count for row in rows):
        raise ValueError("a QR matrix is square")
    if quiet < 0:
        raise ValueError("quiet zone cannot be negative")

    total = count + 2 * quiet
    module = size / total
    offset = quiet * module
    radius = module / 3

    px = size if px is None else px
    parts: list[str] = []
    attrs = (
        f'width="{px}" height="{px}" viewBox="0 0 {size} {size}" '
        f'xmlns="http://www.w3.org/2000/svg" role="img"'
    )
    if label:
        attrs += f' aria-label="{escape(label, {chr(34): "&quot;"})}"'
    parts.append(f"<svg {attrs}>")
    parts.append(f'<rect width="{size}" height="{size}" fill="{bg}" rx="12" ry="12"/>')

    for row, col in ((0, 0), (0, count - 7), (count - 7, 0)):
        x = offset + col * module
        y = offset + row * module
        for inset, span, colour, rx in (
            (0, 7, fg, _FINDER_RX[0]),
            (1, 5, bg, _FINDER_RX[1]),
            (2, 3, fg, _FINDER_RX[2]),
        ):
            parts.append(
                f'<rect x="{_num(x + inset * module)}" y="{_num(y + inset * module)}" '
                f'width="{_num(span * module)}" height="{_num(span * module)}" '
                f'fill="{colour}" rx="{rx}" ry="{rx}"/>'
            )

    for row_index, row in enumerate(rows):
        for col_index, dark in enumerate(row):
            if not dark or _in_finder(row_index, col_index, count):
                continue
            parts.append(
                f'<circle cx="{_num(offset + (col_index + 0.5) * module)}" '
                f'cy="{_num(offset + (row_index + 0.5) * module)}" '
                f'r="{_num(radius)}" fill="{fg}"/>'
            )

    parts.append("</svg>")
    return "".join(parts)


def render(url: str, out: Path, *, size: int = 1024) -> Path:
    try:
        import segno
    except ModuleNotFoundError as missing:  # pragma: no cover - depends on env
        raise SystemExit(
            "QR generation needs segno: pip install 'gander-runtime[qr]'"
        ) from missing

    out.parent.mkdir(parents=True, exist_ok=True)
    # A poster has no white card around it, so the margin is drawn in.
    svg = styled_svg(segno.make(url, error="m").matrix, px=size, quiet=4, label=f"QR code for {url}")
    out.write_text(svg, encoding="utf-8")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QR code for the Genesis live page")
    parser.add_argument("--url", required=True, help="e.g. https://host/live")
    parser.add_argument("--out", default="live-qr.svg", help="output path")
    parser.add_argument("--size", type=int, default=1024, help="rendered width in px")
    args = parser.parse_args(argv)
    try:
        url = public_live_url(args.url)
    except UnsafeQRTarget as unsafe:
        print(f"refusing to encode this URL: {unsafe}", file=sys.stderr)
        return 2
    print(render(url, Path(args.out), size=args.size))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
