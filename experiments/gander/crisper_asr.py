from __future__ import annotations

import argparse
import asyncio
import os
import tempfile
import wave
from pathlib import Path
from typing import Any

from crisperwhisper import CrisperWhisperModel
from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 120


def _write_wav(pcm: bytes) -> Path:
    handle = tempfile.NamedTemporaryFile(prefix="clipit-crisper-", suffix=".wav", delete=False)
    path = Path(handle.name)
    handle.close()
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm)
    return path


def _get(item: Any, *names: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        for name in names:
            if name in item:
                return item[name]
        return default
    for name in names:
        value = getattr(item, name, None)
        if value is not None:
            return value
    return default


class CrisperAsr:
    def __init__(self, model_name: str, mode: str, default_language: str | None) -> None:
        self.model_name = model_name
        self.mode = mode
        self.default_language = default_language
        self.model = CrisperWhisperModel(model_name)

    def transcribe(self, pcm: bytes, start_ms: int, language: str | None) -> dict[str, Any]:
        wav_path = _write_wav(pcm)
        try:
            result = self.model.transcribe(
                str(wav_path),
                language=language or self.default_language,
                mode=self.mode,
                word_timestamps=True,
            )
        finally:
            wav_path.unlink(missing_ok=True)

        text = str(_get(result, "text", default="") or "").strip()
        offset = start_ms / 1000.0
        words: list[dict[str, Any]] = []
        for word in _get(result, "words", default=[]) or []:
            start = _get(word, "start")
            end = _get(word, "end")
            token = str(_get(word, "word", "text", default="") or "")
            if start is None or end is None or not token:
                continue
            words.append(
                {
                    "start": round(offset + float(start), 3),
                    "end": round(offset + float(end), 3),
                    "text": token,
                    "probability": 0.0,
                }
            )

        duration = round(len(pcm) / (SAMPLE_RATE * 2), 3)
        segments: list[dict[str, Any]] = []
        if text:
            segments.append(
                {
                    "start": words[0]["start"] if words else round(offset, 3),
                    "end": words[-1]["end"] if words else round(offset + duration, 3),
                    "text": text,
                    "words": words,
                    "no_speech_probability": 0.0,
                    "average_log_probability": 0.0,
                }
            )

        return {
            "text": text,
            "language": language or self.default_language,
            "language_probability": 0.0,
            "confidence": 0.0,
            "confidence_available": False,
            "duration": duration,
            "segments": segments,
            "words": words,
        }


def create_app(model_name: str, mode: str, default_language: str | None) -> FastAPI:
    app = FastAPI(title="Clipit CrisperWhisper ASR", version="0.1.0")
    engine = CrisperAsr(model_name, mode, default_language)
    lock = asyncio.Lock()

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "engine": "crisperwhisper",
                "model": model_name,
                "mode": mode,
                "sample_rate": SAMPLE_RATE,
            }
        )

    @app.post("/transcribe")
    async def transcribe(
        request: Request,
        start_ms: int = Query(default=0, ge=0),
        sample_rate: int = Query(default=SAMPLE_RATE),
        language: str = Query(default=""),
    ) -> JSONResponse:
        if sample_rate != SAMPLE_RATE:
            return JSONResponse({"type": "error", "message": f"sample_rate must be {SAMPLE_RATE}"}, status_code=400)

        pcm = await request.body()
        if not pcm or len(pcm) % 2:
            return JSONResponse({"type": "error", "message": "input must be non-empty PCM16"}, status_code=400)
        if len(pcm) > SAMPLE_RATE * 2 * MAX_AUDIO_SECONDS:
            return JSONResponse({"type": "error", "message": "input exceeds 120 seconds"}, status_code=413)

        async with lock:
            result = await asyncio.to_thread(engine.transcribe, pcm, start_ms, language or None)
        return JSONResponse(result)

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve CrisperWhisper using Gander's external ASR contract")
    parser.add_argument("--model", default=os.getenv("CRISPER_MODEL", "medium"))
    parser.add_argument("--mode", choices=("verbatim", "intended"), default=os.getenv("CRISPER_MODE", "verbatim"))
    parser.add_argument("--language", default=os.getenv("CRISPER_LANGUAGE") or None)
    parser.add_argument("--host", default=os.getenv("CRISPER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("CRISPER_PORT", "8995")))
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(create_app(args.model, args.mode, args.language), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
