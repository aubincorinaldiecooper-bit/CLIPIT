from __future__ import annotations

import json

import pytest

# Run after copying ornith_provider.py into the Gander providers package.
from gander_runtime.coordination import ContextPlan, WorkerPolicyView, WorkerRequest
from gander_runtime.providers.ornith import OrnithProvider, OrnithProviderSettings


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return json.dumps({"choices": [{"message": {"content": "delegated result"}}]}).encode()


@pytest.mark.asyncio
async def test_ornith_provider_returns_done(monkeypatch):
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: _Response())
    provider = OrnithProvider(OrnithProviderSettings())
    project = await provider.open_project(object())
    request = WorkerRequest(
        task_id="task-1",
        run_id="run-1",
        project_id="project-1",
        owner_id="owner-1",
        generation=1,
        instruction="Solve the delegated task",
        context_plan=ContextPlan(brief="Only use supplied evidence"),
        policy=WorkerPolicyView(),
        lineage_id="lineage-1",
    )
    run = await project.start(request, object())
    events = [event async for event in run.events()]
    assert [event.type for event in events] == ["update", "done"]
    assert events[-1].payload.status == "completed"
    assert events[-1].payload.result == "delegated result"


def test_phase1_capabilities_are_conservative():
    provider = OrnithProvider(OrnithProviderSettings())
    assert provider.capabilities.session == "stateless"
    assert provider.capabilities.context_provisioning == "push_bounded"
    assert provider.capabilities.worker_tools == frozenset()
    assert provider.capabilities.interactions is False
