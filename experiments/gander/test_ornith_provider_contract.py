from __future__ import annotations

import json

import pytest

# Run after copying ornith_provider.py into the Gander providers package.
from gander_runtime.coordination import (
    ContextPlan,
    TurnEnvelope,
    WorkerPolicyView,
    WorkerRequest,
)
from gander_runtime.providers.ornith import (
    OrnithProvider,
    OrnithProviderSettings,
    _bounded_context,
)


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self):
        return json.dumps({"choices": [{"message": {"content": "delegated result"}}]}).encode()


def _policy() -> WorkerPolicyView:
    return WorkerPolicyView(
        contract_revision=1,
        must_ask=("critical_input.missing", "irreversible_ambiguity"),
        delegated_questions=("formatting.detail",),
        allowed_actions=("read", "search", "draft", "edit_draft"),
        permission_actions=("send", "publish", "overwrite", "destructive_action"),
        denied_actions=(),
        subscribed_milestones=("final.completed",),
    )


def _request() -> WorkerRequest:
    return WorkerRequest(
        task_id="task-1",
        run_id="run-1",
        project_id="project-1",
        owner_id="owner-1",
        generation=1,
        instruction="Explain what the user should do next.",
        original_turn="What should I do next?",
        context_plan=ContextPlan(
            brief="The bracket is visibly misaligned before the bolt is tightened.",
            media_refs=("frame-17",),
        ),
        policy=_policy(),
        lineage_id="lineage-1",
        source_turn=TurnEnvelope(
            owner_id="owner-1",
            voice_session_id="voice-1",
            turn_id="turn-1",
            final_asr="What should I do next?",
        ),
    )


@pytest.mark.asyncio
async def test_ornith_provider_returns_done(monkeypatch):
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: _Response())
    provider = OrnithProvider(OrnithProviderSettings())
    project = await provider.open_project(object())
    run = await project.start(_request(), object())
    events = [event async for event in run.events()]
    assert [event.type for event in events] == ["update", "done"]
    assert events[-1].payload.status == "completed"
    assert events[-1].payload.result == "delegated result"


def test_bounded_context_does_not_invent_media_contents():
    prompt = _bounded_context(_request())
    assert "What should I do next?" in prompt
    assert "The bracket is visibly misaligned" in prompt
    assert "media:frame-17" in prompt
    assert "identifiers only; do not infer their contents" in prompt


def test_phase1_capabilities_are_conservative():
    provider = OrnithProvider(OrnithProviderSettings())
    assert provider.capabilities.session == "stateless"
    assert provider.capabilities.context_provisioning == "push_bounded"
    assert provider.capabilities.worker_tools == frozenset()
    assert provider.capabilities.interactions is False
    assert provider.capabilities.steering == "none"
