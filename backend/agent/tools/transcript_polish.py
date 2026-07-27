"""Conservative, one-pass correction for cached Whisper transcripts."""

from __future__ import annotations

import copy
import difflib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
DEFAULT_CONFIDENCE_THRESHOLD = 0.85
DEFAULT_MIN_SIMILARITY = 0.45

_SYSTEM_PROMPT = """\
You correct obvious ASR errors in a complete video transcript.

Rules:
1. Be conservative. If the original can plausibly be what the speaker said, leave it unchanged.
2. Correct only clear speech-recognition errors, spelling, spacing, and punctuation.
3. Never summarize, paraphrase, improve style, add information, or remove spoken meaning.
4. Use neighboring segments and the attached source media as evidence. Listen at the supplied timestamps.
5. Do not invent names or technical terms. If media evidence is not clear, keep the original.
6. Corrected text must use valid standard spelling for the detected language.
7. Before returning, silently verify every changed word against both the media and standard spelling.
8. Do not change timestamps, segment order, or segment count.
9. Return only segments that truly need correction. An empty corrections list is valid.
10. Confidence means confidence that the corrected text matches the actual speech, not that it reads better.

Return JSON only:
{
  "corrections": [
    {
      "segment_index": 0,
      "corrected_text": "corrected spoken text",
      "confidence": 0.95,
      "reason": "short, specific reason"
    }
  ]
}
"""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalized_for_similarity(text: str) -> str:
    return re.sub(r"[\W_]+", "", text, flags=re.UNICODE).lower()


def _similarity(original: str, corrected: str) -> float:
    left = _normalized_for_similarity(original)
    right = _normalized_for_similarity(corrected)
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(None, left, right).ratio()


def _extract_response_json(response: Any) -> dict[str, Any]:
    text = getattr(response, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("subtitle correction model returned an empty response")

    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped, count=1)
        stripped = re.sub(r"\s*```$", "", stripped, count=1)

    parsed = json.loads(stripped)
    if not isinstance(parsed, dict):
        raise ValueError("subtitle correction response must be a JSON object")
    return parsed


def _wait_for_file_active(client: Any, uploaded_file: Any) -> Any:
    timeout = float(os.getenv("TRANSCRIPT_POLISH_UPLOAD_TIMEOUT", "180"))
    deadline = time.monotonic() + timeout
    current = uploaded_file

    while True:
        state = getattr(getattr(current, "state", None), "name", None)
        if state in {None, "ACTIVE"}:
            return current
        if state != "PROCESSING":
            raise RuntimeError(f"transcript correction upload failed: {state}")
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"transcript correction upload did not become active within {timeout}s"
            )
        time.sleep(2)
        current = client.files.get(name=current.name)


def _request_corrections(
    segments: list[dict],
    *,
    language: str,
    model: str,
    api_key: str,
    media_path: Path | None = None,
) -> list[dict]:
    from google import genai

    transcript = [
        {
            "segment_index": index,
            "start": segment.get("start"),
            "end": segment.get("end"),
            "text": str(segment.get("text", "")).strip(),
        }
        for index, segment in enumerate(segments)
    ]
    prompt = (
        f"{_SYSTEM_PROMPT}\n"
        f"Detected language: {language or 'unknown'}\n"
        "Complete transcript:\n"
        f"{json.dumps(transcript, ensure_ascii=False)}"
    )
    response_schema = {
        "type": "object",
        "properties": {
            "corrections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "segment_index": {"type": "integer"},
                        "corrected_text": {"type": "string"},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": [
                        "segment_index",
                        "corrected_text",
                        "confidence",
                        "reason",
                    ],
                },
            },
        },
        "required": ["corrections"],
    }

    client = genai.Client(api_key=api_key)
    uploaded_file = None
    try:
        contents: Any = prompt
        if media_path and media_path.exists():
            uploaded_file = client.files.upload(file=media_path)
            uploaded_file = _wait_for_file_active(client, uploaded_file)
            contents = [prompt, uploaded_file]

        response = client.models.generate_content(
            model=model,
            contents=contents,
            config={
                "temperature": 0.1,
                "response_mime_type": "application/json",
                "response_json_schema": response_schema,
            },
        )
    finally:
        if uploaded_file is not None:
            try:
                client.files.delete(name=uploaded_file.name)
            except Exception:
                logger.warning("failed to delete transcript correction upload", exc_info=True)
    result = _extract_response_json(response)
    corrections = result.get("corrections", [])
    if not isinstance(corrections, list):
        raise ValueError("subtitle correction response.corrections must be a list")
    return corrections


def _reject(
    rejected: list[dict],
    *,
    index: Any,
    reason: str,
    candidate: Any = None,
) -> None:
    item = {"segment_index": index, "reason": reason}
    if isinstance(candidate, str):
        item["candidate_text"] = candidate
    rejected.append(item)


def polish_transcript(
    segments: list[dict],
    *,
    language: str = "unknown",
    media_path: str | Path | None = None,
) -> tuple[list[dict], dict]:
    """Correct only high-confidence ASR errors and return an audit record."""
    raw_segments = copy.deepcopy(segments)
    model = os.getenv("TRANSCRIPT_POLISH_MODEL", "gemini-2.5-flash")
    threshold = float(
        os.getenv("TRANSCRIPT_POLISH_CONFIDENCE", str(DEFAULT_CONFIDENCE_THRESHOLD))
    )
    min_similarity = float(
        os.getenv("TRANSCRIPT_POLISH_MIN_SIMILARITY", str(DEFAULT_MIN_SIMILARITY))
    )
    metadata = {
        "schema_version": SCHEMA_VERSION,
        "attempted_at": _utc_now(),
        "model": model,
        "confidence_threshold": threshold,
        "min_similarity": min_similarity,
        "changes": [],
        "rejected": [],
    }

    if os.getenv("TRANSCRIPT_POLISH", "1").strip().lower() in {"0", "false", "no", "off"}:
        metadata["status"] = "disabled"
        return raw_segments, metadata

    if not raw_segments:
        metadata["status"] = "no_segments"
        return raw_segments, metadata

    api_key = (
        os.getenv("GOOGLE_API_KEY_SUB_AGENT")
        or os.getenv("GOOGLE_API_KEY")
        or os.getenv("GEMINI_API_KEY")
    )
    if not api_key:
        metadata["status"] = "skipped_missing_api_key"
        return raw_segments, metadata

    try:
        candidates = _request_corrections(
            raw_segments,
            language=language,
            model=model,
            api_key=api_key,
            media_path=Path(media_path) if media_path else None,
        )
    except Exception as error:
        logger.exception("transcript correction failed")
        metadata["status"] = "failed"
        metadata["error"] = str(error)
        return raw_segments, metadata

    corrected_segments = copy.deepcopy(raw_segments)
    seen_indexes: set[int] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            _reject(metadata["rejected"], index=None, reason="candidate is not an object")
            continue

        index = candidate.get("segment_index")
        if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < len(raw_segments):
            _reject(metadata["rejected"], index=index, reason="invalid segment index")
            continue
        if index in seen_indexes:
            _reject(metadata["rejected"], index=index, reason="duplicate segment index")
            continue
        seen_indexes.add(index)

        original = str(raw_segments[index].get("text", "")).strip()
        corrected = candidate.get("corrected_text")
        if not isinstance(corrected, str) or not corrected.strip():
            _reject(metadata["rejected"], index=index, reason="empty corrected text")
            continue
        corrected = corrected.strip()
        if corrected == original:
            continue

        try:
            confidence = float(candidate.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < threshold:
            _reject(
                metadata["rejected"],
                index=index,
                reason=f"confidence {confidence:.3f} is below threshold",
                candidate=corrected,
            )
            continue

        similarity = _similarity(original, corrected)
        if similarity < min_similarity:
            _reject(
                metadata["rejected"],
                index=index,
                reason=f"text similarity {similarity:.3f} is below threshold",
                candidate=corrected,
            )
            continue

        if len(corrected) > max(len(original) * 2, len(original) + 20):
            _reject(
                metadata["rejected"],
                index=index,
                reason="corrected text is implausibly longer than original",
                candidate=corrected,
            )
            continue

        corrected_segments[index]["text"] = corrected
        metadata["changes"].append({
            "segment_index": index,
            "start": raw_segments[index].get("start"),
            "end": raw_segments[index].get("end"),
            "original_text": original,
            "corrected_text": corrected,
            "confidence": round(confidence, 3),
            "similarity": round(similarity, 3),
            "reason": str(candidate.get("reason", "")).strip(),
        })

    metadata["status"] = "applied" if metadata["changes"] else "no_changes"
    return corrected_segments, metadata
