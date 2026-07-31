"""Tests for conservative transcript correction and cache migration."""

from __future__ import annotations

import json
from unittest.mock import patch

from agent.tools import transcribe
from agent.tools.transcript_polish import polish_transcript


def _segments() -> list[dict]:
    return [
        {"start": 0.0, "end": 1.0, "text": "오늘은 방을 치울게요"},
        {"start": 1.0, "end": 2.0, "text": "간식으로 도카치파를 먹고"},
        {"start": 2.0, "end": 3.0, "text": "다시 정리할게요"},
    ]


def test_high_confidence_similar_correction_is_applied(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    candidates = [{
        "segment_index": 1,
        "corrected_text": "간식으로 포카칩을 먹고",
        "confidence": 0.96,
        "reason": "문맥상 과자 이름의 명백한 음성 인식 오류",
    }]

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        return_value=candidates,
    ):
        corrected, audit = polish_transcript(_segments(), language="ko")

    assert corrected[1]["text"] == "간식으로 포카칩을 먹고"
    assert audit["status"] == "applied"
    assert audit["changes"][0]["original_text"] == "간식으로 도카치파를 먹고"
    assert audit["changes"][0]["confidence"] == 0.96


def test_expression_and_sound_are_saved_without_changing_spoken_text(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    review = {
        "corrections": [{
            "segment_index": 1,
            "corrected_text": "간식으로 포카칩을 먹고",
            "confidence": 0.96,
            "reason": "명백한 상품명 오인식",
        }],
        "display_edits": [{
            "segment_index": 1,
            "display_text": "(신남) 간식으로 포카칩을 먹고",
            "confidence": 0.97,
            "reason": "들뜬 어조가 명확함",
        }],
        "sound_captions": [{
            "start": 2.1,
            "end": 2.8,
            "text": "[쾅]",
            "confidence": 0.98,
            "reason": "충돌음이 명확함",
        }],
    }

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        return_value=review,
    ):
        corrected, audit = polish_transcript(_segments(), language="ko")

    assert corrected[1]["text"] == "간식으로 포카칩을 먹고"
    assert "display_text" not in corrected[1]
    assert audit["schema_version"] == 2
    assert audit["display_edits"][0]["display_text"] == "(신남) 간식으로 포카칩을 먹고"
    assert audit["sound_captions"][0]["text"] == "[쾅]"
    assert audit["status"] == "applied"


def test_expression_that_rewrites_speech_and_unbracketed_sound_are_rejected(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    review = {
        "corrections": [],
        "display_edits": [{
            "segment_index": 0,
            "display_text": "(당황) 방 청소는 완전히 포기할게요",
            "confidence": 0.99,
            "reason": "dramatic rewrite",
        }],
        "sound_captions": [{
            "start": 1.1,
            "end": 1.8,
            "text": "쾅!",
            "confidence": 0.99,
            "reason": "not bracketed",
        }],
    }

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        return_value=review,
    ):
        corrected, audit = polish_transcript(_segments(), language="ko")

    assert corrected == _segments()
    assert audit["display_edits"] == []
    assert audit["sound_captions"] == []
    assert len(audit["enhancement_rejected"]) == 2
    assert audit["status"] == "no_changes"


def test_expression_density_is_capped(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    monkeypatch.setenv("SUBTITLE_ENHANCE_MAX_RATIO", "0.25")
    review = {
        "corrections": [],
        "display_edits": [
            {
                "segment_index": index,
                "display_text": f"(강조) {segment['text']}",
                "confidence": 0.99 - index * 0.01,
                "reason": "clear emphasis",
            }
            for index, segment in enumerate(_segments())
        ],
        "sound_captions": [],
    }

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        return_value=review,
    ):
        _, audit = polish_transcript(_segments(), language="ko")

    assert len(audit["display_edits"]) == 1
    assert len(audit["enhancement_rejected"]) == 2


def test_low_confidence_and_large_rewrite_are_rejected(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    candidates = [
        {
            "segment_index": 0,
            "corrected_text": "방을 청소하겠습니다",
            "confidence": 0.8,
            "reason": "style rewrite",
        },
        {
            "segment_index": 1,
            "corrected_text": "저녁에는 친구와 식당에서 식사를 했습니다",
            "confidence": 0.99,
            "reason": "hallucinated context",
        },
    ]

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        return_value=candidates,
    ):
        corrected, audit = polish_transcript(_segments(), language="ko")

    assert corrected == _segments()
    assert audit["status"] == "no_changes"
    assert len(audit["rejected"]) == 2


def test_correction_failure_keeps_raw_transcript(monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")

    with patch(
        "agent.tools.transcript_polish._request_corrections",
        side_effect=RuntimeError("temporary API failure"),
    ):
        corrected, audit = polish_transcript(_segments(), language="ko")

    assert corrected == _segments()
    assert audit["status"] == "failed"
    assert "temporary API failure" in audit["error"]


def test_legacy_cache_is_corrected_once_and_then_reused(tmp_path, monkeypatch):
    source = tmp_path / "videos" / "sample.mp4"
    source.parent.mkdir()
    source.write_bytes(b"video")
    subtitles = source.parent / "subtitles"
    subtitles.mkdir()
    cache_path = subtitles / "sample.json"
    cache_path.write_text(
        json.dumps({
            "segments": _segments(),
            "language": "ko",
            "engine": "openai",
            "chunk_count": 1,
            "fallback_used": False,
            "source_path": str(source),
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    corrected = _segments()
    corrected[1]["text"] = "간식으로 포카칩을 먹고"
    audit = {
        "schema_version": 2,
        "status": "applied",
        "changes": [{"segment_index": 1}],
        "rejected": [],
    }

    with patch.object(transcribe, "SUBTITLES_DIR", subtitles), \
         patch("agent.tools.transcribe.resolve_input_path", return_value=source), \
         patch(
             "agent.tools.transcribe.polish_transcript",
             return_value=(corrected, audit),
         ) as polish:
        first = json.loads(transcribe.transcribe_video.invoke({
            "video_path": str(source),
        }))
        second = json.loads(transcribe.transcribe_video.invoke({
            "video_path": str(source),
        }))

    assert first["segments"][1]["text"] == "간식으로 포카칩을 먹고"
    assert first["raw_segments"][1]["text"] == "간식으로 도카치파를 먹고"
    assert second["segments"] == first["segments"]
    polish.assert_called_once()

    saved = json.loads(cache_path.read_text(encoding="utf-8"))
    assert saved["schema_version"] == 2
    assert saved["correction"]["status"] == "applied"
    assert saved["raw_segments"][1]["text"] == "간식으로 도카치파를 먹고"


def test_failed_correction_is_retryable():
    payload = {
        "segments": _segments(),
        "raw_segments": _segments(),
        "language": "ko",
        "correction": {"status": "failed", "error": "temporary"},
    }
    corrected = _segments()
    corrected[1]["text"] = "간식으로 포카칩을 먹고"

    with patch(
        "agent.tools.transcribe.polish_transcript",
        return_value=(corrected, {"status": "applied", "changes": []}),
    ) as polish:
        result = transcribe._apply_transcript_correction(payload)

    assert result["segments"][1]["text"] == "간식으로 포카칩을 먹고"
    assert result["correction"]["status"] == "applied"
    polish.assert_called_once()


def test_schema_upgrade_failure_preserves_existing_corrections():
    raw = _segments()
    existing = _segments()
    existing[1]["text"] = "간식으로 포카칩을 먹고"
    payload = {
        "segments": existing,
        "raw_segments": raw,
        "language": "ko",
        "correction": {
            "schema_version": 1,
            "status": "applied",
            "changes": [{"segment_index": 1}],
        },
    }

    with patch(
        "agent.tools.transcribe.polish_transcript",
        return_value=(
            existing,
            {
                "schema_version": 2,
                "status": "failed",
                "error": "quota exhausted",
            },
        ),
    ) as polish:
        result = transcribe._apply_transcript_correction(payload)

    assert result["segments"][1]["text"] == "간식으로 포카칩을 먹고"
    assert result["raw_segments"][1]["text"] == "간식으로 도카치파를 먹고"
    assert result["correction"]["status"] == "failed"
    assert result["correction"]["previous_correction"]["schema_version"] == 1
    assert polish.call_args.args[0][1]["text"] == "간식으로 포카칩을 먹고"
