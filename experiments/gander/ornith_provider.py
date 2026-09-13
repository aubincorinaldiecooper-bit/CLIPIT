"""Phase-1 Gander WorkerProvider for an OpenAI-compatible Ornith server.

Copy this file into `gander_runtime/gander_runtime/providers/ornith.py` in the
pinned Gander checkout and register it beside the built-in Codex provider.

Phase 1 proves only: delegate -> reason -> return -> cancel. It intentionally
advertises no worker tools, steering, side queries, or interactions.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from ..contracts import stable_id
from ..coordination import (
    BackendCapabilities,
    DonePayload,
    ProjectRecord,
    UpdatePayload,
    WorkerEvent,
    WorkerMessage,
    WorkerRequest,
)
from ..gateway import WorkerControl
from .registry import ProviderBuildContext, ProviderRegistration


@dataclass(frozen=True)
class OrnithProviderSettings:
    base_url: str = "http://127.0.0.1:8000/v1"
    model: str = "Ornith-1.5-9B"
    api_key_env: str = "ORNITH_API_KEY"
    request_timeout_sec: float = 300.0
    max_parallel_projects: int = 1
    temperature: float = 0.2
    max_tokens: int = 4096

    def __post_init__(self) -> None:
        if not self.base_url.startswith(("http://", "https://")):
            raise ValueError("base_url must be an absolute HTTP(S) URL")
        if not self.model.strip():
            raise ValueError("model must not be empty")
        if self.request_timeout_sec <= 0:
            raise ValueError("request_timeout_sec must be positive")
        if self.max_parallel_projects < 1:
            raise ValueError("max_parallel_projects must be positive")
        if not 0 <= self.temperature <= 2:
            raise ValueError("temperature must be between 0 and 2")
        if self.max_tokens < 1:
            raise ValueError("max_tokens must be positive")


ORNITH_CAPABILITIES = BackendCapabilities(
    steering="none",
    side_queries="none",
    terminal_side_queries="none",
    interactions=False,
    blocking_granularity="run",
    authority_enforcement="none",
    structured_events="limited",
    trusted_risk_signals=False,
    session_resume=False,
    modalities=frozenset({"text"}),
    max_parallel_projects=1,
    context_provisioning="push_bounded",
    session="stateless",
    worker_tools=frozenset(),
)


def _chat_url(base_url: str) -> str:
    return base_url.rstrip("/") + "/chat/completions"


def _bounded_context(request: WorkerRequest) -> str:
    """Render only context already selected and pushed by Gander."""

    chunks: list[str] = []
    if request.original_turn.strip():
        chunks.append(f"Original user utterance:\n{request.original_turn.strip()}")

    source_turn = request.source_turn
    if source_turn is not None and source_turn.final_asr.strip():
        current = source_turn.final_asr.strip()
        if current != request.original_turn.strip():
            chunks.append(f"Current trusted transcript:\n{current}")

    if request.context_plan.brief.strip():
        chunks.append(f"Bounded runtime context:\n{request.context_plan.brief.strip()}")

    refs: list[str] = []
    refs.extend(f"event:{value}" for value in request.context_plan.event_refs)
    refs.extend(f"media:{value}" for value in request.context_plan.media_refs)
    refs.extend(f"artifact:{value}" for value in request.context_plan.artifact_refs)
    if refs:
        chunks.append(
            "Selected evidence references (identifiers only; do not infer their contents):\n"
            + "\n".join(refs)
        )

    chunks.append(f"Delegated task:\n{request.instruction.strip()}")
    return "\n\n".join(chunks)


def _extract_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("Ornith response did not contain choices")
    choice = choices[0]
    if not isinstance(choice, dict):
        raise RuntimeError("Ornith response choice was not an object")
    message = choice.get("message")
    if not isinstance(message, dict):
        raise RuntimeError("Ornith response did not contain a message")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    if message.get("reasoning_content"):
        raise RuntimeError("Ornith returned reasoning_content but no final content")
    raise RuntimeError("Ornith returned an empty final answer")


def _request_ornith(settings: OrnithProviderSettings, prompt: str) -> str:
    body = json.dumps(
        {
            "model": settings.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are the reasoning brain behind a realtime multimodal "
                        "assistant. Complete the delegated task using only the "
                        "supplied text context. Evidence reference identifiers are "
                        "not evidence contents. Do not claim to have seen, heard, "
                        "searched, opened, or used anything that is not explicitly "
                        "present in the supplied context. Return the useful final "
                        "result, not private chain-of-thought."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": settings.temperature,
            "max_tokens": settings.max_tokens,
            "stream": False,
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv(settings.api_key_env, "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        _chat_url(settings.base_url),
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=settings.request_timeout_sec) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"Ornith HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Ornith request failed: {exc}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Ornith response was not a JSON object")
    return _extract_text(payload)


class _OrnithRun:
    def __init__(self, request: WorkerRequest, settings: OrnithProviderSettings) -> None:
        self.request = request
        self.settings = settings
        self.session_id = request.lineage_id or request.run_id
        self._queue: asyncio.Queue[WorkerEvent | None] = asyncio.Queue()
        self._cancelled = asyncio.Event()
        self._task = asyncio.create_task(self._execute(), name=f"ornith-{request.run_id}")

    def _event(self, seq: int, payload: UpdatePayload | DonePayload, ref: str) -> WorkerEvent:
        return WorkerEvent(
            event_id=stable_id("event", self.request.run_id, ref),
            owner_id=self.request.owner_id,
            task_id=self.request.task_id,
            project_id=self.request.project_id,
            run_id=self.request.run_id,
            generation=self.request.generation,
            seq=seq,
            type="update" if isinstance(payload, UpdatePayload) else "done",
            payload=payload,
        )

    async def _execute(self) -> None:
        try:
            await self._queue.put(
                self._event(
                    1,
                    UpdatePayload(
                        kind="activity",
                        summary="Ornith is reasoning about the delegated task.",
                        next_step="Return the result to the live Gander session.",
                    ),
                    "ornith-start",
                )
            )
            result = await asyncio.to_thread(
                _request_ornith, self.settings, _bounded_context(self.request)
            )
            if self._cancelled.is_set():
                await self._queue.put(
                    self._event(2, DonePayload("cancelled", "Ornith task cancelled."), "ornith-cancelled")
                )
            else:
                await self._queue.put(
                    self._event(2, DonePayload("completed", result), "ornith-done")
                )
        except asyncio.CancelledError:
            await self._queue.put(
                self._event(2, DonePayload("cancelled", "Ornith task cancelled."), "ornith-cancelled")
            )
        except Exception as exc:
            await self._queue.put(
                self._event(2, DonePayload("failed", str(exc)), "ornith-failed")
            )
        finally:
            await self._queue.put(None)

    def events(self) -> AsyncIterator[WorkerEvent]:
        async def iterate() -> AsyncIterator[WorkerEvent]:
            while True:
                event = await self._queue.get()
                if event is None:
                    return
                yield event
                if event.type == "done":
                    return
        return iterate()

    async def send(self, message: WorkerMessage) -> bool:
        del message
        return False

    async def cancel(self, request_id: str) -> bool:
        del request_id
        if self._task.done() or self._cancelled.is_set():
            return True
        self._cancelled.set()
        self._task.cancel()
        return False

    async def close(self) -> None:
        if not self._task.done():
            self._cancelled.set()
            self._task.cancel()
        await asyncio.gather(self._task, return_exceptions=True)


class _OrnithProject:
    def __init__(self, settings: OrnithProviderSettings) -> None:
        self.settings = settings
        self._closed = False

    async def start(self, request: WorkerRequest, control: WorkerControl) -> _OrnithRun:
        del control
        if self._closed:
            raise RuntimeError("Ornith project is closed")
        return _OrnithRun(request, self.settings)

    async def close(self) -> None:
        self._closed = True


class OrnithProvider:
    name = "ornith-openai"
    capabilities = ORNITH_CAPABILITIES

    def __init__(self, settings: OrnithProviderSettings) -> None:
        self.settings = settings
        self._closed = False

    async def open_project(self, project: ProjectRecord) -> _OrnithProject:
        del project
        if self._closed:
            raise RuntimeError("Ornith provider is closed")
        return _OrnithProject(self.settings)

    async def close(self) -> None:
        self._closed = True


def _build_ornith_provider(
    context: ProviderBuildContext,
    settings: OrnithProviderSettings,
) -> OrnithProvider:
    del context
    return OrnithProvider(settings)


ORNITH_PROVIDER_REGISTRATION = ProviderRegistration(
    key="ornith",
    provider_name="ornith-openai",
    settings_type=OrnithProviderSettings,
    build=_build_ornith_provider,
)
