"""What is allowed inside the QR code.

A QR code is published the moment it is printed. These are the things that
must never end up on a poster.
"""
from __future__ import annotations

import pytest

from gander_runtime.live_qr import UnsafeQRTarget, _num, public_live_url, styled_svg


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


# --- the drawing ---------------------------------------------------------
#
# Spell UI's QR component is React; this page has none, so its look is drawn
# by hand. These hold the geometry to the upstream file's numbers.

_FINDER = {(r, c) for r in range(7) for c in range(7)}


def _finder_cells(count: int) -> set:
    cells = set()
    for r, c in _FINDER:
        cells |= {(r, c), (r, count - 7 + c), (count - 7 + r, c)}
    return cells


def _demo_matrix():
    segno = pytest.importorskip("segno")
    return segno.make("https://genesis.example/live", error="m").matrix


def test_every_dark_module_outside_the_finders_is_a_dot_a_third_of_a_module():
    matrix = _demo_matrix()
    count = len(matrix)
    module = 268 / count
    svg = styled_svg(matrix)

    expected = sum(
        1
        for r, row in enumerate(matrix)
        for c, dark in enumerate(row)
        if dark and (r, c) not in _finder_cells(count)
    )
    assert svg.count("<circle ") == expected
    # Every dot has the same radius: a third of a module.
    assert svg.count(f' r="{_num(module / 3)}" ') == expected
    # Nothing is drawn as a square module: dots and finders only.
    assert svg.count("<rect ") == 1 + 3 * 3


def test_the_finders_are_three_nested_rounded_squares_with_upstreams_radii():
    matrix = _demo_matrix()
    count = len(matrix)
    module = 268 / count
    svg = styled_svg(matrix)
    for rx, span in ((12, 7), (8, 5), (3, 3)):
        side = _num(span * module)
        assert svg.count(f'width="{side}" height="{side}" fill="#{"0F1720" if rx != 8 else "ffffff"}" rx="{rx}" ry="{rx}"') == 3
    # And the canvas itself is rounded to 12, like upstream's background.
    assert '<rect width="268" height="268" fill="#ffffff" rx="12" ry="12"/>' in svg


def test_a_quiet_zone_moves_the_code_in_and_keeps_the_canvas():
    matrix = _demo_matrix()
    count = len(matrix)
    svg = styled_svg(matrix, quiet=4)
    module = 268 / (count + 8)
    first_finder_at = _num(4 * module)
    assert f'<rect x="{first_finder_at}" y="{first_finder_at}"' in svg
    assert 'viewBox="0 0 268 268"' in svg


def test_the_rendered_size_scales_the_picture_not_its_corners():
    svg = styled_svg(_demo_matrix(), px=1024)
    assert 'width="1024" height="1024" viewBox="0 0 268 268"' in svg
    assert 'rx="12" ry="12"' in svg


def test_the_label_names_the_url_and_is_escaped():
    svg = styled_svg(_demo_matrix(), label='QR code for https://genesis.example/live?a="b"&c')
    assert 'aria-label="QR code for https://genesis.example/live?a=&quot;b&quot;&amp;c"' in svg


def test_a_non_square_matrix_is_refused():
    with pytest.raises(ValueError):
        styled_svg([[1, 0, 1], [1, 0]])
