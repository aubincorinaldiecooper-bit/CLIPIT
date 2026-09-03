"""
Getting the source video onto the container, once, and not filling the disk.

Separated from the service so it can be tested: this module deletes files, and
file-deleting code should be exercised before it runs on a container holding
somebody's footage. It imports nothing from Modal and nothing from a GPU.

Run the tests with:  python3 modal/test_sourcecache.py
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import tempfile

# Anything URL-shaped, removed from text that is about to travel.
_URLISH = re.compile(r"https?://\S+")


def scrub(text: str) -> str:
    """
    Text that is safe to hand back to a caller and safe to log.

    Applied to every failure message leaving this service. A signed URL is a
    temporary key to someone's footage; the rule here is that it is never
    logged, and a failure `reason` is logged like anything else. One place to
    enforce that beats remembering at every raise site.
    """
    return _URLISH.sub("<signed url>", text)


# How much downloaded video one container may keep. Modal reuses a warm
# container across many calls, and each new video left its copy on disk for
# the container's whole life — so a busy container filled up and every later
# download failed. The cache is what makes one fetch per video possible, so it
# is bounded rather than removed.
CACHE_BUDGET_BYTES = 8 * 1024 * 1024 * 1024


def evict_cache(keep: str) -> None:
    """
    Trims the cache to its budget, oldest first, never touching `keep`.

    `keep` is the file this call is about to read. Modal runs one input at a
    time in a container by default, so there is no second reader to surprise;
    if that ever changes, this is the line that has to change with it.

    Orphaned `.partial` files go too. A download that failed leaves one behind
    — small individually, unbounded over a container's life.
    """
    root = tempfile.gettempdir()
    files = []
    for name in os.listdir(root):
        if not name.startswith("clipit-source-"):
            continue
        full = os.path.join(root, name)
        try:
            stat = os.stat(full)
        except OSError:
            continue
        if name.endswith(".partial"):
            # Nothing is reading it: a partial only exists after a failure.
            if full != f"{keep}.partial":
                _remove(full)
            continue
        files.append((stat.st_mtime, stat.st_size, full))

    total = sum(size for _, size, _ in files)
    for _, size, full in sorted(files):
        if total <= CACHE_BUDGET_BYTES:
            break
        if full == keep:
            continue
        if _remove(full):
            total -= size


def _remove(path: str) -> bool:
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def cache_path(video_key: str) -> str:
    safe = hashlib.sha256(video_key.encode("utf-8")).hexdigest()[:32]
    return os.path.join(tempfile.gettempdir(), f"clipit-source-{safe}.mp4")


def _assert_expected(path: str, expect_bytes: int | None) -> None:
    """
    Refuses a file that is not the one the caller identified.

    Clipit reads the object's content tag, and only then signs the URL this
    service fetches. A video re-processed in between overwrites the same key,
    so the bytes arriving here can belong to a version the identity does not
    name — and they would be embedded, cached under that identity, and
    indistinguishable from correct work. The caller detects it after the fact;
    this catches it before a single vector is made.

    Size, because it is what the caller already knows from the same reply the
    tag came from, and it costs nothing. It is not a content hash: two
    versions could in principle match. Binding the download to an exact object
    version is the airtight fix and needs trying against real storage.
    """
    if expect_bytes is None:
        return
    actual = os.path.getsize(path)
    if actual != expect_bytes:
        raise RuntimeError(
            f"the source video is {actual} bytes but the caller identified one of {expect_bytes}; "
            "it was most likely replaced between the two, so these bytes are not the ones asked for"
        )


def fetch_once(video_url: str, video_key: str, expect_bytes: int | None = None) -> tuple[str, bool]:
    """
    Pull the source down once and keep it for the life of the container.

    Returns the path and whether this call paid the download. A warm container
    asked for a second batch of windows from the same video does no network
    work at all, which is the difference between one fetch per video and one
    per window.
    """
    path = cache_path(video_key)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        _assert_expected(path, expect_bytes)
        return path, False

    partial = f"{path}.partial"

    # The URL never touches the command line.
    #
    # A signed URL is a temporary key to somebody's footage, and this codebase
    # already holds that a logged signed URL is a logged copy of the video. On
    # the argv route it escaped twice over: into the process listing, and —
    # worse — into CalledProcessError, whose text is the entire command. That
    # text went straight back to Clipit as a failure `reason`, and from there
    # into the logs. Verified before fixing: the signature was in the string.
    #
    # curl reads its configuration from stdin instead, so the URL is in
    # neither place, and a failure is re-raised carrying only curl's own
    # message and its exit status.
    #
    # No `location`, either. A presigned GET does not redirect, so following
    # one would only mean fetching something other than what Clipit signed.
    config = "\n".join([
        f'url = "{video_url}"',
        f'output = "{partial}"',
        "silent", "show-error", "fail", "max-time = 900",
    ]) + "\n"
    try:
        subprocess.run(
            ["curl", "--config", "-"], input=config, text=True,
            capture_output=True, check=True, timeout=960,
        )
    except subprocess.CalledProcessError as error:
        _remove(partial)
        detail = scrub((error.stderr or "").strip()) or f"curl exited {error.returncode}"
        raise RuntimeError(f"could not download the source video: {detail}") from None
    except subprocess.TimeoutExpired:
        _remove(partial)
        raise RuntimeError("could not download the source video: timed out") from None

    try:
        _assert_expected(partial, expect_bytes)
    except Exception:
        # Never let bytes the caller did not ask for enter the cache under an
        # identity that does not describe them.
        _remove(partial)
        raise

    os.replace(partial, path)
    evict_cache(keep=path)
    return path, True
