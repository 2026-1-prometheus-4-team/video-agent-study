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
from agent.tools.transcript_polish import polish_transcript

load_dotenv()
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
VIDEOS_DIR = PROJECT_ROOT / "videos"
SUBTITLES_DIR = VIDEOS_DIR / "subtitles"


def _transcript_cache_path(source: Path) -> Path:
    """Return the canonical transcript sidecar path for a video."""
    return SUBTITLES_DIR / f"{source.stem}.json"


def _load_cached_transcript(source: Path) -> dict | None:
    path = _transcript_cache_path(source)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        logger.warning("transcript cache load failed: %s", path, exc_info=True)
        return None

    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        return None

    duration = max((float(segment.get("end", 0)) for segment in segments), default=0.0)
    result = {
        "status": "success",
        "segments": segments,
        "raw_segments": data.get("raw_segments", segments),
        "segment_count": len(segments),
        "total_duration": duration,
        "language": data.get("language", "unknown"),
        "engine": data.get("engine", "unknown"),
        "chunk_count": data.get("chunk_count", 0),
        "fallback_used": bool(data.get("fallback_used", False)),
        "cache_hit": True,
        "cache_path": str(path),
        "report": f"segments: {len(segments)}, total_duration: {duration}, cache: hit",
    }
    if isinstance(data.get("correction"), dict):
        result["correction"] = data["correction"]
    return result


def _save_transcript_cache(source: Path, payload: dict) -> Path:
    path = _transcript_cache_path(source)
    path.parent.mkdir(parents=True, exist_ok=True)
    cache_payload = {
        "schema_version": 2,
        "segments": payload.get("segments", []),
        "raw_segments": payload.get("raw_segments", payload.get("segments", [])),
        "correction": payload.get("correction"),
        "language": payload.get("language"),
        "engine": payload.get("engine"),
        "chunk_count": payload.get("chunk_count", 0),
        "fallback_used": bool(payload.get("fallback_used", False)),
        "source_path": str(source.resolve()),
    }
    path.write_text(
        json.dumps(cache_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def _correction_complete(correction: Any) -> bool:
    try:
        schema_version = int(correction.get("schema_version", 0))
    except (AttributeError, TypeError, ValueError):
        schema_version = 0
    return (
        isinstance(correction, dict)
        and schema_version >= 2
        and correction.get("status") in {
            "applied",
            "no_changes",
            "disabled",
            "no_segments",
        }
    )


def _apply_transcript_correction(
    payload: dict,
    *,
    media_path: Path | None = None,
) -> dict:
    """Add one correction attempt while preserving the immutable Whisper output."""
    if _correction_complete(payload.get("correction")):
        return payload

    raw_segments = payload.get("raw_segments")
    if not isinstance(raw_segments, list):
        raw_segments = payload.get("segments", [])
    current_segments = payload.get("segments")
    if not isinstance(current_segments, list):
        current_segments = raw_segments
    previous_correction = payload.get("correction")

    corrected, correction = polish_transcript(
        current_segments,
        language=str(payload.get("language") or "unknown"),
        media_path=media_path,
    )
    if (
        isinstance(previous_correction, dict)
        and previous_correction.get("status") in {"applied", "no_changes"}
        and previous_correction.get("schema_version") != correction.get("schema_version")
    ):
        correction["previous_correction"] = previous_correction
    payload["raw_segments"] = raw_segments
    payload["segments"] = corrected
    payload["correction"] = correction
    payload["segment_count"] = len(corrected)
    payload["total_duration"] = max(
        (float(segment.get("end", 0)) for segment in corrected),
        default=0.0,
    )
    return payload


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
                model="gemini-2.5-flash",
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
def transcribe_video(video_path: str, force: bool = False, polish: bool = True) -> str:
    """Return Whisper transcript as a clean segment list with timestamps.

    Args:
        video_path: Absolute path or project-root-relative video path.
        force: True면 기존 transcript JSON 캐시를 무시하고 다시 전사.
        polish: When True, correct only obvious ASR errors once before caching.
    """
    try:
        source = resolve_input_path(video_path)
    except FileNotFoundError as error:
        return json.dumps({"status": "error", "segments": [], "error": str(error)}, ensure_ascii=False)

    if not force:
        cached = _load_cached_transcript(source)
        if cached:
            if polish and not _correction_complete(cached.get("correction")):
                cached = _apply_transcript_correction(cached, media_path=source)
                try:
                    cache_path = _save_transcript_cache(source, cached)
                    cached["cache_path"] = str(cache_path)
                except OSError:
                    logger.warning("corrected transcript cache save failed", exc_info=True)
            logger.info("transcript cache reused: %s", cached["cache_path"])
            return json.dumps(cached, ensure_ascii=False)

    normalized_path: Path | None = None
    chunks: list[tuple[Path, float]] = []
    primary = os.getenv("WHISPER_ENGINE", "openai").strip().lower()
    if primary not in {"openai", "faster-whisper", "gemini"}:
        return json.dumps({
            "status": "error",
            "segments": [],
            "error": f"unsupported Whisper engine: {primary}",
        }, ensure_ascii=False)

    engines = [primary]
    fallback = "faster-whisper" if primary == "openai" else "openai"
    if os.getenv("WHISPER_DISABLE_FALLBACK", "").lower() not in {"1", "true", "yes"}:
        if fallback not in engines:
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
                elif engine == "gemini":
                    segments, language = _gemini_transcribe(chunks)
                else:
                    raise ValueError(f"unsupported Whisper engine: {engine}")

                segments = [segment for segment in segments if segment["text"]]
                duration = max((segment["end"] for segment in segments), default=0.0)
                payload = {
                    "status": "success",
                    "segments": segments,
                    "raw_segments": segments,
                    "segment_count": len(segments),
                    "total_duration": duration,
                    "language": language,
                    "engine": engine,
                    "chunk_count": len(chunks),
                    "fallback_used": index > 0,
                    "cache_hit": False,
                    "report": (
                        f"segments: {len(segments)}, total_duration: {duration}, "
                        f"language: {language}"
                    ),
                }
                if polish:
                    payload = _apply_transcript_correction(
                        payload,
                        media_path=source,
                    )
                try:
                    cache_path = _save_transcript_cache(source, payload)
                    payload["cache_path"] = str(cache_path)
                    logger.info("transcript cache saved: %s", cache_path)
                except OSError:
                    logger.warning("transcript cache save failed", exc_info=True)
                return json.dumps(payload, ensure_ascii=False)
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
