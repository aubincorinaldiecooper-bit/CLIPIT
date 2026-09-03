"""
How a time range becomes frames — the arithmetic, on its own.

Separated from the service because it is pure, because it was wrong twice
before it was measured, and because a GPU and a Modal account are absurd
prerequisites for checking that sixteen frames span twenty seconds.

Run the tests with:  python3 modal/test_sampling.py
"""

from __future__ import annotations

from dataclasses import dataclass

@dataclass(frozen=True)
class Sampling:
    """How frames are chosen inside an interval. Part of a vector's identity."""

    fps: float
    max_frames: int
    short_side: int

    def describe(self) -> dict:
        # `fps` is the CEILING. A window long enough that max_frames would
        # not reach its end is sampled slower; each result carries the rate
        # it actually got.
        return {"max_fps": self.fps, "max_frames": self.max_frames, "short_side": self.short_side}


# How many more frames to decode than are kept. Decoding is cheap at proxy
# resolution and this is what lets the kept frames be chosen from a fine grid
# instead of being whatever ffmpeg's own bucketing happened to emit.
DECODE_OVERSAMPLE = 4


def decode_rate_for(duration: float, sampling: Sampling) -> float:
    """
    How fast to pull frames out before choosing between them.

    Never above the configured ceiling, and bounded so a long window cannot
    decode an unbounded number of frames: at most `max_frames * OVERSAMPLE`
    come back however long the interval is.
    """
    if duration <= 0:
        return sampling.fps
    return min(sampling.fps, (sampling.max_frames * DECODE_OVERSAMPLE) / duration)


def pick_evenly(count: int, wanted: int) -> list[int]:
    """
    Which of `count` decoded frames to keep, so the kept ones span all of it.

    Two versions of this were wrong before it was measured, which is why the
    arithmetic is a pure function with its own tests rather than an ffmpeg
    flag.

    The first sampled at a fixed rate and stopped at the cap. That does not
    sample an interval, it samples the START of one: at 2 fps capped to 16
    frames, a 10-second window's frames all came from its first 7.5 seconds,
    and a 20-second window saw the same first 7.5 seconds. The vector was then
    filed against the whole interval, so a moment in the back half of a window
    did not exist as far as retrieval was concerned while coverage reported
    the window as indexed.

    The second lowered the rate to `max_frames / duration`, which fixed the
    short windows and still left a whole slice unsampled at the end — 7.5
    seconds of a 120-second window — because frames land at the START of each
    slice. Nudging the seek by half a slice made 10s and 20s exactly
    symmetric and made 120s WORSE, because the shortened input lost a frame to
    the fps filter's bucket boundary. Measured, both times.

    So the timing is not left to ffmpeg at all. Frames come back on a fine
    grid and the kept ones are taken from the CENTRE of each of `wanted`
    equal parts, which is symmetric by construction and does not care how the
    filter buckets anything. Measured at 120 seconds: head and tail gaps of
    3.75 seconds each, against 7.5 seconds of blind tail before.
    """
    if wanted <= 0:
        return []
    if count <= wanted:
        return list(range(count))
    return [min(count - 1, int((k + 0.5) * count / wanted)) for k in range(wanted)]
