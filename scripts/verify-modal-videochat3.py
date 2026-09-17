#!/usr/bin/env python3
"""Fail unless the deployed VideoChat3 class exposes Clipit's required methods."""

from __future__ import annotations

import os
import sys

import modal

APP_NAME = os.environ.get("MODAL_APP_NAME", "clipit-videochat3")
CLASS_NAME = os.environ.get("MODAL_CLASS_NAME", "VideoChat3Service")
ENVIRONMENT = os.environ.get("MODAL_ENVIRONMENT", "main")
REQUIRED_METHODS = ("health", "watch", "watch_stream", "verify_intervals")


def main() -> int:
    deployed = modal.Cls.from_name(
        APP_NAME,
        CLASS_NAME,
        environment_name=ENVIRONMENT,
    )
    deployed.hydrate()
    instance = deployed()

    missing: list[str] = []
    for method_name in REQUIRED_METHODS:
        try:
            getattr(instance, method_name)
        except Exception:
            missing.append(method_name)

    if missing:
        print(
            f"ERROR: {APP_NAME}/{CLASS_NAME} in {ENVIRONMENT} is missing: "
            + ", ".join(missing),
            file=sys.stderr,
        )
        return 1

    print(
        f"OK: {APP_NAME}/{CLASS_NAME} in {ENVIRONMENT} exposes "
        + ", ".join(REQUIRED_METHODS)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
