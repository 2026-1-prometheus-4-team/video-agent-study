"""Conservative, one-pass correction for cached Whisper transcripts."""

from __future__ import annotations

import copy
import difflib
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 2
DEFAULT_CONFIDENCE_THRESHOLD = 0.85
DEFAULT_MIN_SIMILARITY = 0.45
DEFAULT_ENHANCEMENT_CONFIDENCE = 0.9
DEFAULT_ENHANCEMENT_MAX_RATIO = 0.25
_ANNOTATION_RE = re.compile(r"(\([^()\n]{1,14}\)|\[[^\[\]\n]{1,14}\])")
_SOUND_CAPTION_RE = re.compile(r"^\[[^\[\]\n]{1,14}\]$")

_SYSTEM_PROMPT = """\
You review a complete video transcript for two separate purposes:
A. correct obvious ASR errors;
B. suggest sparse, evidence-grounded expressive captions for the rendered subtitles.

ASR correction rules:
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

Expressive caption rules:
1. Expressive text is display-only. It must never replace or alter the corrected spoken transcript.
2. Use `display_edits` for an audible or clearly visible reaction/tone attached to a spoken segment.
   Preserve every spoken word and add exactly one short parenthetical expression, for example:
   `(당황) 이게 왜 안 되지?`, `드디어 끝났다 (안도)`.
3. Use `sound_captions` only for a clearly audible, meaningful non-speech sound at the supplied time.
   Use square brackets, for example `[쾅]`, `[웃음]`, `[한숨]`.
4. Do not describe ordinary editing, camera movement, background music, or events that are not clear
   in the attached media. Never invent a sound, emotion, joke, or reaction from transcript text alone.
5. Keep additions sparse: at most 25 percent of spoken segments, and at most three standalone sounds.
6. Do not add emojis, hashtags, narration, explanations, or multiple annotations to one caption.
7. Empty `display_edits` and `sound_captions` arrays are preferred when evidence is weak.

Return JSON only:
{
  "corrections": [
    {
      "segment_index": 0,
      "corrected_text": "corrected spoken text",
      "confidence": 0.95,
      "reason": "short, specific reason"
    }
  ],
  "display_edits": [
    {
      "segment_index": 0,
      "display_text": "(당황) original spoken words preserved",
      "confidence": 0.95,
      "reason": "reaction is clearly visible or audible"
    }
  ],
  "sound_captions": [
    {
      "start": 1.2,
      "end": 2.0,
      "text": "[쾅]",
      "confidence": 0.96,
      "reason": "impact is clearly audible"
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
) -> dict[str, list[dict]]:
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
            "display_edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "segment_index": {"type": "integer"},
                        "display_text": {"type": "string"},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": [
                        "segment_index",
                        "display_text",
                        "confidence",
                        "reason",
                    ],
                },
            },
            "sound_captions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "start": {"type": "number"},
                        "end": {"type": "number"},
                        "text": {"type": "string"},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": ["start", "end", "text", "confidence", "reason"],
                },
            },
        },
        "required": ["corrections", "display_edits", "sound_captions"],
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
    for key in ("corrections", "display_edits", "sound_captions"):
        if not isinstance(result.get(key), list):
            raise ValueError(f"subtitle correction response.{key} must be a list")
    return {
        "corrections": result["corrections"],
        "display_edits": result["display_edits"],
        "sound_captions": result["sound_captions"],
    }


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


def _candidate_confidence(candidate: dict) -> float:
    try:
        confidence = float(candidate.get("confidence", 0.0))
    except (TypeError, ValueError):
        return 0.0
    return confidence if math.isfinite(confidence) else 0.0


def _validate_display_edits(
    candidates: list[dict],
    corrected_segments: list[dict],
    metadata: dict,
) -> None:
    threshold = float(
        os.getenv(
            "SUBTITLE_ENHANCE_CONFIDENCE",
            str(DEFAULT_ENHANCEMENT_CONFIDENCE),
        )
    )
    ratio = min(
        0.5,
        max(
            0.0,
            float(
                os.getenv(
                    "SUBTITLE_ENHANCE_MAX_RATIO",
                    str(DEFAULT_ENHANCEMENT_MAX_RATIO),
                )
            ),
        ),
    )
    max_edits = math.ceil(len(corrected_segments) * ratio)
    valid: list[dict] = []
    seen_indexes: set[int] = set()

    for candidate in candidates:
        if not isinstance(candidate, dict):
            _reject(
                metadata["enhancement_rejected"],
                index=None,
                reason="display edit is not an object",
            )
            continue
        index = candidate.get("segment_index")
        if (
            not isinstance(index, int)
            or isinstance(index, bool)
            or not 0 <= index < len(corrected_segments)
        ):
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason="invalid display edit segment index",
            )
            continue
        if index in seen_indexes:
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason="duplicate display edit segment index",
            )
            continue
        seen_indexes.add(index)

        base_text = str(corrected_segments[index].get("text", "")).strip()
        display_text = candidate.get("display_text")
        if not isinstance(display_text, str) or not display_text.strip():
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason="empty display text",
            )
            continue
        display_text = display_text.strip()
        annotations = _ANNOTATION_RE.findall(display_text)
        if len(annotations) != 1 or annotations[0].startswith("["):
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason="display edit must contain exactly one parenthetical annotation",
                candidate=display_text,
            )
            continue

        confidence = _candidate_confidence(candidate)
        if confidence < threshold:
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason=f"enhancement confidence {confidence:.3f} is below threshold",
                candidate=display_text,
            )
            continue

        spoken_part = _ANNOTATION_RE.sub("", display_text).strip()
        similarity = _similarity(base_text, spoken_part)
        if similarity < 0.9:
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason=f"display text changed spoken words ({similarity:.3f} similarity)",
                candidate=display_text,
            )
            continue
        if len(display_text) > max(len(base_text) + 18, int(len(base_text) * 1.6)):
            _reject(
                metadata["enhancement_rejected"],
                index=index,
                reason="display text is too long",
                candidate=display_text,
            )
            continue

        valid.append({
            "segment_index": index,
            "start": corrected_segments[index].get("start"),
            "end": corrected_segments[index].get("end"),
            "spoken_text": base_text,
            "display_text": display_text,
            "confidence": round(confidence, 3),
            "reason": str(candidate.get("reason", "")).strip(),
        })

    valid.sort(key=lambda item: (-item["confidence"], item["segment_index"]))
    accepted = valid[:max_edits]
    for item in valid[max_edits:]:
        _reject(
            metadata["enhancement_rejected"],
            index=item["segment_index"],
            reason=f"display edit density exceeds {ratio:.0%}",
            candidate=item["display_text"],
        )
    accepted.sort(key=lambda item: item["segment_index"])
    metadata["display_edits"] = accepted


def _validate_sound_captions(
    candidates: list[dict],
    corrected_segments: list[dict],
    metadata: dict,
) -> None:
    threshold = float(
        os.getenv(
            "SUBTITLE_ENHANCE_CONFIDENCE",
            str(DEFAULT_ENHANCEMENT_CONFIDENCE),
        )
    )
    max_captions = max(0, int(os.getenv("SUBTITLE_ENHANCE_MAX_SOUNDS", "3")))
    transcript_end = max(
        (float(segment.get("end", 0.0)) for segment in corrected_segments),
        default=0.0,
    )
    valid: list[dict] = []

    for candidate in candidates:
        if not isinstance(candidate, dict):
            _reject(
                metadata["enhancement_rejected"],
                index=None,
                reason="sound caption is not an object",
            )
            continue
        text = candidate.get("text")
        if not isinstance(text, str) or not _SOUND_CAPTION_RE.fullmatch(text.strip()):
            _reject(
                metadata["enhancement_rejected"],
                index=None,
                reason="sound caption must be one short square-bracket annotation",
                candidate=text,
            )
            continue
        text = text.strip()
        try:
            start = float(candidate.get("start"))
            end = float(candidate.get("end"))
        except (TypeError, ValueError):
            start, end = -1.0, -1.0
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end <= start
            or end - start > 3.0
            or (transcript_end and end > transcript_end + 5.0)
        ):
            _reject(
                metadata["enhancement_rejected"],
                index=None,
                reason="invalid sound caption timing",
                candidate=text,
            )
            continue
        confidence = _candidate_confidence(candidate)
        if confidence < threshold:
            _reject(
                metadata["enhancement_rejected"],
                index=None,
                reason=f"sound confidence {confidence:.3f} is below threshold",
                candidate=text,
            )
            continue
        valid.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "text": text,
            "confidence": round(confidence, 3),
            "reason": str(candidate.get("reason", "")).strip(),
        })

    valid.sort(key=lambda item: (-item["confidence"], item["start"]))
    accepted = valid[:max_captions]
    for item in valid[max_captions:]:
        _reject(
            metadata["enhancement_rejected"],
            index=None,
            reason=f"sound caption count exceeds {max_captions}",
            candidate=item["text"],
        )
    accepted.sort(key=lambda item: (item["start"], item["end"]))
    metadata["sound_captions"] = accepted


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
        "display_edits": [],
        "sound_captions": [],
        "enhancement_rejected": [],
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
        review = _request_corrections(
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

    # Backward-compatible with tests and old adapters that returned corrections only.
    if isinstance(review, list):
        review = {
            "corrections": review,
            "display_edits": [],
            "sound_captions": [],
        }
    candidates = review.get("corrections", [])
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

    _validate_display_edits(
        review.get("display_edits", []),
        corrected_segments,
        metadata,
    )
    _validate_sound_captions(
        review.get("sound_captions", []),
        corrected_segments,
        metadata,
    )
    applied = (
        metadata["changes"]
        or metadata["display_edits"]
        or metadata["sound_captions"]
    )
    metadata["status"] = "applied" if applied else "no_changes"
    return corrected_segments, metadata
