from __future__ import annotations

import json

import pytest

from gander_runtime.providers.ornith import (
    ORNITH_CAPABILITIES,
    OrnithProviderSettings,
    OrnithWorkerProvider,
)


class _Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return json.dumps({"data": []}).encode()


def test_capabilities_match_current_checkpoint():
    assert ORNITH_CAPABILITIES.session == "stateless"
    assert ORNITH_CAPABILITIES.context_provisioning == "push_bounded"
    assert ORNITH_CAPABILITIES.worker_tools == frozenset()
    assert ORNITH_CAPABILITIES.interactions is False
    assert ORNITH_CAPABILITIES.steering == "none"
    assert ORNITH_CAPABILITIES.max_parallel_projects == 4


@pytest.mark.asyncio
async def test_provider_warmup_uses_models_endpoint(monkeypatch):
    seen = {}

    def _urlopen(request, timeout):
        seen["url"] = request.full_url
        seen["timeout"] = timeout
        return _Response()

    monkeypatch.setenv("ORNITH_API_KEY", "test-key")
    monkeypatch.setattr("urllib.request.urlopen", _urlopen)

    provider = OrnithWorkerProvider(
        OrnithProviderSettings(
            base_url="https://ornith.example",
            timeout_sec=12,
        )
    )

    await provider.warmup()

    assert seen["url"] == "https://ornith.example/v1/models"
    assert seen["timeout"] == 12
