"""
Sixteen frames have to describe the whole window, not the start of it.

Run:  python3 modal/test_sampling.py

No Modal, no GPU, no network. The two mistakes this guards against were both
found by review rather than by reasoning, and both looked completely fine in
the code — which is the argument for pinning the arithmetic here.
"""

import sys

from sampling import DECODE_OVERSAMPLE, Sampling, decode_rate_for, pick_evenly

FAILURES = []


def check(condition, message):
    if condition:
        return
    FAILURES.append(message)


def frame_times(duration, sampling):
    """Where in the interval the kept frames actually land."""
    rate = decode_rate_for(duration, sampling)
    count = max(1, int(duration * rate))
    return [index / rate for index in pick_evenly(count, sampling.max_frames)], rate


def main():
    s = Sampling(fps=2.0, max_frames=16, short_side=256)

    # 1. The original bug: frames only from the beginning of the window.
    for duration in (10, 20, 60, 120):
        times, _ = frame_times(duration, s)
        head, tail = times[0], duration - times[-1]
        check(
            tail <= duration / s.max_frames,
            f"{duration}s window leaves {tail:.2f}s at the end unsampled "
            f"(more than one slice of {duration / s.max_frames:.2f}s)",
        )
        # Neither end is systematically favoured.
        check(
            abs(head - tail) <= duration / s.max_frames,
            f"{duration}s window is lopsided: {head:.2f}s at the head, {tail:.2f}s at the tail",
        )

    # 2. A window shorter than the cap keeps every frame it has.
    times, rate = frame_times(4, s)
    check(rate == 2.0, "a short window should decode at the configured rate, not faster")
    check(len(times) == 8, f"a 4s window at 2 fps should keep 8 frames, kept {len(times)}")

    # 3. The cap is never exceeded, however long the window.
    for duration in (10, 120, 3600):
        times, _ = frame_times(duration, s)
        check(len(times) <= s.max_frames, f"{duration}s window kept {len(times)} frames, cap is {s.max_frames}")

    # 4. Decoding stays bounded: a long window must not pull in the whole video.
    for duration in (120, 600, 3600):
        rate = decode_rate_for(duration, s)
        check(
            duration * rate <= s.max_frames * DECODE_OVERSAMPLE + 1,
            f"{duration}s window would decode {duration * rate:.0f} frames",
        )

    # 5. The configured rate is a ceiling, never raised.
    for duration in (1, 10, 120):
        check(decode_rate_for(duration, s) <= s.fps + 1e-9, "decode rate rose above the configured ceiling")

    # 6. Selection itself: in order, no duplicates, in range.
    for count, wanted in ((240, 16), (17, 16), (16, 16), (3, 16), (1, 16)):
        picked = pick_evenly(count, wanted)
        check(picked == sorted(picked), f"pick_evenly({count},{wanted}) came back out of order")
        check(len(picked) == len(set(picked)), f"pick_evenly({count},{wanted}) repeated a frame")
        check(all(0 <= i < count for i in picked), f"pick_evenly({count},{wanted}) went out of range")
        check(len(picked) == min(count, wanted), f"pick_evenly({count},{wanted}) kept {len(picked)}")

    check(pick_evenly(10, 0) == [], "asking for no frames should give none")

    if FAILURES:
        print(f"{len(FAILURES)} failure(s):")
        for message in FAILURES:
            print(f"  - {message}")
        sys.exit(1)

    print("frame sampling: all checks passed")
    for duration in (6, 10, 20, 60, 120):
        times, rate = frame_times(duration, Sampling(fps=2.0, max_frames=16, short_side=256))
        print(
            f"  {duration:>4}s window: decode {rate:5.3f} fps, keep {len(times):>2} frames, "
            f"{times[0]:.2f}s to {times[-1]:.2f}s"
        )


if __name__ == "__main__":
    main()
