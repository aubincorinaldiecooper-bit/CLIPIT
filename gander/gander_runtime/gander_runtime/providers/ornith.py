"""Working Gander WorkerProvider adapter for the Ornith OpenAI-compatible server.

Copy this file into `gander_runtime/gander_runtime/providers/ornith.py` in the
pinned Gander checkout. This is the provider version validated with the current
Gander + Ornith Modal runtime.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from dataclasses import dataclass
from typing import Any, AsyncIterator

from ..contracts import new_id
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
    base_url: str
    model: str = "ornith"
    api_key_env: str = "ORNITH_API_KEY"
    timeout_sec: float = 120.0
    temperature: float = 0.2
    max_tokens: int = 1536


ORNITH_CAPABILITIES = BackendCapabilities(
    steering="none",
    side_queries="none",
    terminal_side_queries="none",
    interactions=False,
    blocking_granularity="run",
    authority_enforcement="gateway",
    structured_events="native",
    trusted_risk_signals=False,
    session_resume=False,
    modalities=frozenset({"text"}),
    max_parallel_projects=4,
    context_provisioning="push_bounded",
    session="stateless",
    worker_tools=frozenset(),
)


class OrnithRun:
    def __init__(self, request: WorkerRequest, settings: OrnithProviderSettings):
        self.request = request
        self.settings = settings
        self.session_id = f"ornith:{request.run_id}"
        self._queue: asyncio.Queue[WorkerEvent | None] = asyncio.Queue()
        self._seq = 0
        self._terminal = False
        self._task: asyncio.Task | None = None

    async def start(self):
        self._task = asyncio.create_task(
            self._drive(),
            name=f"ornith-{self.request.run_id}",
        )

    def _make_event(self, payload):
        self._seq += 1
        if isinstance(payload, UpdatePayload):
            event_type = "update"
        elif isinstance(payload, DonePayload):
            event_type = "done"
        else:
            raise TypeError(f"Unsupported Ornith payload: {type(payload)}")

        return WorkerEvent(
            event_id=new_id("event"),
            owner_id=self.request.owner_id,
            task_id=self.request.task_id,
            project_id=self.request.project_id,
            run_id=self.request.run_id,
            generation=self.request.generation,
            seq=self._seq,
            type=event_type,
            payload=payload,
        )

    async def _publish(self, payload):
        if self._terminal:
            return
        event = self._make_event(payload)
        if event.type == "done":
            self._terminal = True
        await self._queue.put(event)

    def _build_prompt(self) -> str:
        pieces = [
            "You are the long-horizon Brain inside Gander.",
            "",
            "Gander's realtime Cerebellum handles live audio-visual perception and interaction timing.",
            "",
            "Your job is reasoning, planning, and deciding what the agent should do with the task.",
            "",
            f"TASK:\n{self.request.instruction}",
        ]

        brief = getattr(self.request.context_plan, "brief", "")
        if brief:
            pieces.extend(["", "GANDER CONTEXT:", brief])

        source_turn = self.request.source_turn
        if source_turn is not None:
            text = getattr(source_turn, "final_asr", "")
            if text:
                pieces.extend(["", "TRUSTED USER TURN:", text])

        pieces.extend([
            "",
            "Return a concise final response.",
            "Do not expose chain-of-thought.",
        ])
        return "\n".join(pieces)

    def _request_ornith(self) -> dict[str, Any]:
        api_key = os.environ.get(self.settings.api_key_env, "")
        if not api_key:
            raise RuntimeError(f"Missing environment variable {self.settings.api_key_env}")

        url = self.settings.base_url.rstrip("/") + "/v1/chat/completions"
        payload = {
            "model": self.settings.model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are Gander's back Brain. "
                        "Gander's Cerebellum owns realtime audio-visual perception. "
                        "You own longer-horizon reasoning."
                    ),
                },
                {"role": "user", "content": self._build_prompt()},
            ],
            "temperature": self.settings.temperature,
            "max_tokens": self.settings.max_tokens,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.settings.timeout_sec) as response:
            return json.loads(response.read().decode("utf-8"))

    async def _drive(self):
        try:
            await self._publish(
                UpdatePayload(
                    kind="activity",
                    summary="Ornith Brain accepted the Gander task.",
                    next_step="Reasoning about the task.",
                )
            )
            result = await asyncio.to_thread(self._request_ornith)
            choices = result.get("choices") or []
            if not choices:
                raise RuntimeError("Ornith returned no choices")
            message = choices[0].get("message") or {}
            answer = message.get("content")
            if not answer:
                raise RuntimeError("Ornith returned no final content")
            await self._publish(DonePayload(status="completed", result=answer.strip()))
        except asyncio.CancelledError:
            if not self._terminal:
                await self._publish(DonePayload(status="cancelled", result="Ornith task cancelled."))
            raise
        except Exception as exc:
            if not self._terminal:
                await self._publish(
                    DonePayload(
                        status="failed",
                        result=f"Ornith Brain failure: {type(exc).__name__}: {exc}",
                    )
                )

    async def events(self) -> AsyncIterator[WorkerEvent]:
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
            if event.type == "done":
                return

    async def send(self, message: WorkerMessage) -> bool:
        return False

    async def cancel(self, request_id: str) -> bool:
        if self._terminal:
            return True
        if self._task is not None:
            self._task.cancel()
        return False

    async def close(self):
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        await self._queue.put(None)


class OrnithProject:
    def __init__(self, project: ProjectRecord, settings: OrnithProviderSettings):
        self.project = project
        self.settings = settings
        self._runs: set[OrnithRun] = set()
        self._closed = False

    async def start(self, request: WorkerRequest, control: WorkerControl) -> OrnithRun:
        if self._closed:
            raise RuntimeError("Ornith project is closed")
        if request.project_id != self.project.project_id:
            raise ValueError("WorkerRequest project mismatch")
        run = OrnithRun(request=request, settings=self.settings)
        self._runs.add(run)
        await run.start()
        return run

    async def close(self):
        if self._closed:
            return
        self._closed = True
        runs = tuple(self._runs)
        for run in runs:
            await run.close()
        self._runs.clear()


class OrnithWorkerProvider:
    name = "ornith-openai"
    capabilities = ORNITH_CAPABILITIES

    def __init__(self, settings: OrnithProviderSettings):
        self.settings = settings
        self._projects: dict[str, OrnithProject] = {}
        self._closed = False

    def _warmup_sync(self) -> None:
        api_key = os.environ.get(self.settings.api_key_env, "")
        if not api_key:
            raise RuntimeError(f"Missing environment variable {self.settings.api_key_env}")
        url = self.settings.base_url.rstrip("/") + "/v1/models"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=self.settings.timeout_sec) as response:
            if response.status >= 400:
                raise RuntimeError(f"Ornith warmup failed: HTTP {response.status}")
            response.read()

    async def warmup(self) -> None:
        # Gander calls provider.warmup() before announcing the realtime session ready.
        await asyncio.to_thread(self._warmup_sync)

    async def open_project(self, project: ProjectRecord) -> OrnithProject:
        if self._closed:
            raise RuntimeError("Ornith provider is closed")
        existing = self._projects.get(project.project_id)
        if existing is not None:
            return existing
        created = OrnithProject(project=project, settings=self.settings)
        self._projects[project.project_id] = created
        return created

    async def close(self):
        if self._closed:
            return
        self._closed = True
        for project in tuple(self._projects.values()):
            await project.close()
        self._projects.clear()


def _build_ornith_provider(
    context: ProviderBuildContext,
    settings: OrnithProviderSettings,
):
    return OrnithWorkerProvider(settings)


ORNITH_PROVIDER_REGISTRATION = ProviderRegistration(
    key="ornith",
    provider_name="ornith-openai",
    settings_type=OrnithProviderSettings,
    build=_build_ornith_provider,
)
