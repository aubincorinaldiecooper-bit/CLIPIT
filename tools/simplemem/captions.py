"""Frame captions that fail loudly instead of quietly.

Upstream Omni-SimpleMem's ``ImageProcessor.generate_summary()`` does
``response.choices[0].message.content.strip()`` and, on any exception, returns
the literal ``"Image captured"``. A caption model that answers with
``content=None`` (an OpenAI-compatible gateway does this when a reasoning model
spends the whole ``max_tokens=150`` budget thinking, or when the reply was
filtered) raises inside that ``except``, and the frame is remembered as
"Image captured" — a memory that matches nothing and says nothing, recorded as
a success.

This module makes the same call with the same prompt, and instead:

* a blank reply is asked for once more with a larger completion budget;
* a frame whose caption never arrives is COUNTED, and its memory carries an
  explicit placeholder that no search can mistake for a description;
* the counts travel back on the indexing reply (see ``sidecar._index_sync``),
  so the worker's row and the logs show how much of the memory has captions.

Dependency-free on purpose (no simplemem, no openai import): the OpenAI client
is handed in by the sidecar, and the tests hand in a fake.
"""
from __future__ import annotations

import base64
import io
import logging
from dataclasses import asdict, dataclass
from typing import Any, Callable

CAPTION_PROMPT = "Describe this image in one concise sentence. Focus on key objects, actions, and context."

# Deliberately unlike a caption. A search that embeds this sentence should not
# land near any real description, and a person reading the memory can see at
# once that the frame was never described.
UNCAPTIONED = "[no caption: the caption model returned no text for this frame]"

FIRST_MAX_TOKENS = 150
RETRY_MAX_TOKENS = 600


@dataclass
class CaptionStats:
    """How the captioning of one video went. Zero-initialised per index run."""

    attempted: int = 0
    captioned: int = 0
    retried: int = 0
    failed: int = 0
    lastError: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _text_of(content: Any) -> str:
    """The text of a chat reply, whatever shape the SDK returned it in."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            text = part.get("text") if isinstance(part, dict) else getattr(part, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return " ".join(parts).strip()
    return ""


class CaptionWriter:
    """Captions frames through an OpenAI-compatible client and keeps count."""

    def __init__(
        self,
        client_factory: Callable[[], Any],
        model: str,
        *,
        load_image: Callable[[Any], Any] | None = None,
        first_max_tokens: int = FIRST_MAX_TOKENS,
        retry_max_tokens: int = RETRY_MAX_TOKENS,
        log: logging.Logger | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._model = model
        self._load_image = load_image
        self._first_max_tokens = first_max_tokens
        self._retry_max_tokens = retry_max_tokens
        self._log = log or logging.getLogger(__name__)
        self.stats = CaptionStats()

    def caption(self, data: Any) -> str:
        """Drop-in for upstream's ``generate_summary``: always returns a string."""
        image = data if hasattr(data, "save") else (self._load_image(data) if self._load_image else data)
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG")
        encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")

        self.stats.attempted += 1
        text, why = self._ask(encoded, self._first_max_tokens)
        if text is None:
            self.stats.retried += 1
            text, why = self._ask(encoded, self._retry_max_tokens)
        if text is None:
            self.stats.failed += 1
            self.stats.lastError = why
            self._log.warning("frame caption unavailable: %s", why)
            return UNCAPTIONED
        self.stats.captioned += 1
        return text

    def _ask(self, encoded_jpeg: str, max_tokens: int) -> tuple[str | None, str | None]:
        try:
            client = self._client_factory()
            response = client.chat.completions.create(
                model=self._model,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": CAPTION_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{encoded_jpeg}"}},
                    ],
                }],
                max_tokens=max_tokens,
            )
        except Exception as exc:  # the gateway, the network, the SDK: all end here
            return None, f"{type(exc).__name__}: {exc}"[:300]

        choices = getattr(response, "choices", None) or []
        choice = choices[0] if choices else None
        message = getattr(choice, "message", None)
        text = _text_of(getattr(message, "content", None))
        if text:
            return text, None
        finish = getattr(choice, "finish_reason", None) if choice is not None else "no choices"
        return None, f"empty caption (finish_reason={finish}, max_tokens={max_tokens})"
