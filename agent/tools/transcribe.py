"""Whisper transcription tool for audio_expert."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from langchain_core.tools import tool

from agent.tools.audio_common import probe_duration, resolve_input_path, run_ffmpeg

load_dotenv()
logger = logging.getLogger(__name__)


def _normalize_audio(video_path: Path) -> Path:
    handle = tempfile.NamedTemporaryFile(prefix="whisper_", suffix=".wav", delete=False)
    handle.close()
    output = Path(handle.name)
    run_ffmpeg(
        "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        "-y", str(output),
    )
    return output


def _split_audio(audio_path: Path) -> list[tuple[Path, float]]:
    """Split normalized audio into API-friendly chunks and return start offsets."""
    duration = probe_duration(audio_path)
    chunk_seconds = float(os.getenv("WHISPER_CHUNK_SECONDS", "120"))
    if not duration or chunk_seconds <= 0 or duration <= chunk_seconds:
        return [(audio_path, 0.0)]

    chunks: list[tuple[Path, float]] = []
    offset = 0.0
    while offset < duration:
        handle = tempfile.NamedTemporaryFile(prefix="whisper_chunk_", suffix=".m4a", delete=False)
        handle.close()
        chunk_path = Path(handle.name)
        run_ffmpeg(
            "-ss", str(offset),
            "-t", str(min(chunk_seconds, duration - offset)),
            "-i", str(audio_path),
            "-c", "copy",
            "-y", str(chunk_path),
        )
        chunks.append((chunk_path, offset))
        offset += chunk_seconds
    return chunks


def _segment_dict(segment: Any, offset: float = 0.0) -> dict:
    def read(name: str) -> Any:
        return segment[name] if isinstance(segment, dict) else getattr(segment, name)

    return {
        "start": round(float(read("start")) + offset, 2),
        "end": round(float(read("end")) + offset, 2),
        "text": str(read("text")).strip(),
    }


def _openai_whisper(chunks: list[tuple[Path, float]]) -> tuple[list[dict], str]:
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    segments: list[dict] = []
    language = "unknown"

    for chunk_path, offset in chunks:
        with open(chunk_path, "rb") as f:
            response = client.audio.transcriptions.create(
                model="whisper-1",
                file=f,
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )
        language = response.language or language
        for seg in response.segments or []:
            segments.append(_segment_dict(seg, offset))

    return segments, language


def _gemini_transcribe(chunks: list[tuple[Path, float]]) -> tuple[list[dict], str]:
    from google import genai

    client = genai.Client()
    segments: list[dict] = []
    language = "unknown"

    prompt = """
    Transcribe this audio.
    Return JSON only:
    {
      "language": "detected language",
      "segments": [
        {"start": 0.0, "end": 1.2, "text": "spoken text"}
      ]
    }
    Timestamps must be seconds relative to the start of this audio file.
    """

    for chunk_path, offset in chunks:
        uploaded_file = client.files.upload(file=chunk_path)
        try:
            response = client.models.generate_content(
                model="gemini-3.5-flash",
                contents=[prompt, uploaded_file],
                config={"response_mime_type": "application/json"},
            )
            result = json.loads(response.text)
        finally:
            client.files.delete(name=uploaded_file.name)

        segments.extend(
            _segment_dict(segment, offset)
            for segment in result["segments"]
        )
        language = result.get("language", language)

    return segments, language


def _local_whisper(audio_path: Path) -> tuple[list[dict], str]:
    from faster_whisper import WhisperModel

    model = WhisperModel(
        os.getenv("FASTER_WHISPER_MODEL", "base"),
        device=os.getenv("FASTER_WHISPER_DEVICE", "auto"),
        compute_type=os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8"),
    )
    segments, info = model.transcribe(
        str(audio_path),
        vad_filter=False,
        no_speech_threshold=0.75,
        condition_on_previous_text=False,
    )
    return [_segment_dict(segment) for segment in segments], info.language


@tool
def transcribe_video(video_path: str) -> str:
    """Return Whisper transcript as a clean segment list with timestamps.

    Args:
        video_path: Absolute path or project-root-relative video path.
    """
    try:
        source = resolve_input_path(video_path)
    except FileNotFoundError as error:
        return json.dumps({"status": "error", "segments": [], "error": str(error)}, ensure_ascii=False)

    normalized_path: Path | None = None
    chunks: list[tuple[Path, float]] = []
    primary = os.getenv("WHISPER_ENGINE", "openai").strip().lower()
    engines = [primary]
    fallback = "faster-whisper" if primary == "openai" else "openai"
    if os.getenv("WHISPER_DISABLE_FALLBACK", "").lower() not in {"1", "true", "yes"}:
        engines.append(fallback)

    errors: list[str] = []
    try:
        normalized_path = _normalize_audio(source)
        chunks = _split_audio(normalized_path)
        for index, engine in enumerate(engines):
            try:
                if engine == "openai":
                    segments, language = _openai_whisper(chunks)
                elif engine == "faster-whisper":
                    segments, language = _local_whisper(normalized_path)
                else:
                    raise ValueError(f"unsupported Whisper engine: {engine}")

                segments = [segment for segment in segments if segment["text"]]
                duration = max((segment["end"] for segment in segments), default=0.0)
                return json.dumps(
                    {
                        "status": "success",
                        "segments": segments,
                        "segment_count": len(segments),
                        "total_duration": duration,
                        "language": language,
                        "engine": engine,
                        "chunk_count": len(chunks),
                        "fallback_used": index > 0,
                        "report": (
                            f"segments: {len(segments)}, total_duration: {duration}, "
                            f"language: {language}"
                        ),
                    },
                    ensure_ascii=False,
                )
            except Exception as error:
                logger.exception("Whisper engine failed: %s", engine)
                errors.append(f"{engine}: {error}")
    except Exception as error:
        errors.append(f"audio normalization: {error}")
    finally:
        if normalized_path:
            normalized_path.unlink(missing_ok=True)
        for chunk_path, _ in chunks:
            if chunk_path != normalized_path:
                chunk_path.unlink(missing_ok=True)

    return json.dumps(
        {"status": "error", "segments": [], "fallback_used": len(engines) > 1, "error": "; ".join(errors)},
        ensure_ascii=False,
    )


TOOLS = [transcribe_video]
