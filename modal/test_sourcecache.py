"""
The download cache: bounded, and it never deletes what is in use.

Run:  python3 modal/test_sourcecache.py

This module removes files from a container's disk. That is worth exercising
before it runs anywhere near somebody's footage, which is the whole reason the
cache lives apart from the service.
"""

import os
import sys
import tempfile
import time

import sourcecache
from sourcecache import cache_path, evict_cache, scrub

FAILURES = []


def check(condition, message):
    if not condition:
        FAILURES.append(message)


def write(path, size, age_seconds=0):
    with open(path, "wb") as handle:
        handle.write(b"\0" * size)
    if age_seconds:
        old = time.time() - age_seconds
        os.utime(path, (old, old))
    return path


def main():
    root = tempfile.mkdtemp()
    sourcecache.tempfile.gettempdir = lambda: root  # the cache's whole world
    original_budget = sourcecache.CACHE_BUDGET_BYTES
    sourcecache.CACHE_BUDGET_BYTES = 300

    def cached(name, size, age=0):
        return write(os.path.join(root, f"clipit-source-{name}"), size, age)

    # --- the leak this exists to stop --------------------------------------
    oldest = cached("aaa", 200, age=300)
    middle = cached("bbb", 200, age=200)
    newest = cached("ccc", 200, age=100)
    evict_cache(keep=newest)
    check(not os.path.exists(oldest), "the oldest cached video should have gone first")
    check(os.path.exists(newest), "the file about to be read must never be deleted")
    total = sum(os.path.getsize(os.path.join(root, f)) for f in os.listdir(root))
    check(total <= sourcecache.CACHE_BUDGET_BYTES, f"cache left at {total} bytes, over budget")

    # --- keep wins even when it is the oldest ------------------------------
    for name in os.listdir(root):
        os.remove(os.path.join(root, name))
    ancient = cached("ddd", 500, age=9999)
    cached("eee", 200, age=1)
    evict_cache(keep=ancient)
    check(os.path.exists(ancient), "keep must survive even as the oldest and largest file")

    # --- orphaned partials go, the live one stays --------------------------
    for name in os.listdir(root):
        os.remove(os.path.join(root, name))
    live = cached("fff", 10)
    write(f"{live}.partial", 10)
    orphan = write(os.path.join(root, "clipit-source-ggg.partial"), 10)
    evict_cache(keep=live)
    check(not os.path.exists(orphan), "a partial from a failed download should be cleaned up")
    check(os.path.exists(f"{live}.partial"), "the partial for the current fetch must be left alone")

    # --- nothing to do is not an error -------------------------------------
    for name in os.listdir(root):
        os.remove(os.path.join(root, name))
    evict_cache(keep=os.path.join(root, "clipit-source-nothing"))

    # --- unrelated files are none of its business --------------------------
    stranger = write(os.path.join(root, "someone-elses-file"), 5000)
    evict_cache(keep=os.path.join(root, "clipit-source-nothing"))
    check(os.path.exists(stranger), "eviction must only ever touch its own cache files")

    sourcecache.CACHE_BUDGET_BYTES = original_budget

    # --- identity, and the rule that a signed URL never travels ------------
    check(cache_path("a#1") != cache_path("a#2"), "a new content tag must be a new cache entry")
    check(cache_path("a#1") == cache_path("a#1"), "the same identity must reuse one entry")
    leak = 'failed: https://b.example/p.mp4?X-Amz-Signature=SECRET and more'
    check("SECRET" not in scrub(leak), "scrub must remove a signed URL")
    check("failed:" in scrub(leak), "scrub must keep the part that explains the failure")

    if FAILURES:
        print(f"{len(FAILURES)} failure(s):")
        for message in FAILURES:
            print(f"  - {message}")
        sys.exit(1)
    print("source cache: all checks passed")


if __name__ == "__main__":
    main()
