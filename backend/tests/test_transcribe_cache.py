"""Whisper 엔진 라우팅과 원본 전사 캐시 회귀 테스트."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from agent.tools.transcribe import transcribe_video


def test_openai_engine_calls_openai_not_gemini(tmp_path, monkeypatch):
    source = tmp_path / "sample.mp4"
    normalized = tmp_path / "sample.wav"
    source.write_bytes(b"video")
    normalized.write_bytes(b"audio")
    monkeypatch.setenv("WHISPER_ENGINE", "openai")
    monkeypatch.setenv("WHISPER_DISABLE_FALLBACK", "1")

    with patch("agent.tools.transcribe.resolve_input_path", return_value=source), \
         patch("agent.tools.transcribe._normalize_audio", return_value=normalized), \
         patch("agent.tools.transcribe._split_audio", return_value=[(normalized, 0.0)]), \
         patch("agent.tools.transcribe._openai_whisper",
               return_value=([{"start": 0.0, "end": 1.0, "text": "안녕"}], "ko")) as openai, \
         patch("agent.tools.transcribe._gemini_transcribe") as gemini, \
         patch("agent.tools.transcribe._save_transcript_cache",
               return_value=tmp_path / "sample.json"):
        result = json.loads(transcribe_video.invoke({
            "video_path": str(source),
            "force": True,
            "polish": False,
        }))

    assert result["status"] == "success"
    assert result["engine"] == "openai"
    openai.assert_called_once()
    gemini.assert_not_called()


def test_cache_hit_skips_audio_processing(tmp_path):
    source = tmp_path / "sample.mp4"
    source.write_bytes(b"video")
    cached = {
        "status": "success",
        "segments": [{"start": 0, "end": 1, "text": "캐시"}],
        "cache_hit": True,
        "cache_path": str(tmp_path / "sample.json"),
    }

    with patch("agent.tools.transcribe.resolve_input_path", return_value=source), \
         patch("agent.tools.transcribe._load_cached_transcript", return_value=cached), \
         patch("agent.tools.transcribe._normalize_audio") as normalize:
        result = json.loads(transcribe_video.invoke({
            "video_path": str(source),
            "polish": False,
        }))

    assert result["cache_hit"] is True
    assert result["segments"][0]["text"] == "캐시"
    normalize.assert_not_called()


def test_cache_is_written_to_canonical_subtitles_dir(tmp_path):
    from agent.tools import transcribe

    source = tmp_path / "videos" / "move_2.mp4"
    source.parent.mkdir()
    source.write_bytes(b"video")
    subtitles = tmp_path / "videos" / "subtitles"

    with patch.object(transcribe, "SUBTITLES_DIR", subtitles):
        path = transcribe._save_transcript_cache(source, {
            "segments": [{"start": 0, "end": 1.5, "text": "원본 전사"}],
            "language": "ko",
            "engine": "openai",
            "chunk_count": 1,
            "fallback_used": False,
        })

    assert path == subtitles / "move_2.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["source_path"] == str(source.resolve())
    assert payload["engine"] == "openai"


def test_video_without_audio_reports_cause_not_ffmpeg_noise(tmp_path):
    """무음 영상은 ffmpeg 원문 대신 원인과 대안을 돌려준다.

    실제로 사용자에게 노출됐던 문자열:
      "전사 실패: audio normalization: ffmpeg failed: ...
       Output file does not contain any stream"
    """
    source = tmp_path / "screen_capture.mp4"
    source.write_bytes(b"video-without-audio")

    with patch("agent.tools.transcribe.resolve_input_path", return_value=source), \
         patch("agent.tools.transcribe._has_audio_stream", return_value=False), \
         patch("agent.tools.transcribe._normalize_audio") as normalize:
        result = json.loads(transcribe_video.invoke({
            "video_path": str(source),
            "force": True,
        }))

    normalize.assert_not_called(), "오디오가 없으면 ffmpeg 를 태우지 않는다"
    assert result["status"] == "error"
    assert result["error"] == "no_audio_stream"
    assert "오디오 트랙이 없어서" in result["message"]
    assert "add_caption" in result["message"], "다음에 뭘 하면 되는지 알려준다"


def test_audio_probe_failure_does_not_block_transcription(tmp_path, monkeypatch):
    """ffprobe 판단이 불가할 때 전사를 막으면 멀쩡한 영상까지 죽는다."""
    source = tmp_path / "sample.mp4"
    normalized = tmp_path / "sample.wav"
    source.write_bytes(b"video")
    normalized.write_bytes(b"audio")
    monkeypatch.setenv("WHISPER_ENGINE", "openai")
    monkeypatch.setenv("WHISPER_DISABLE_FALLBACK", "1")

    with patch("agent.tools.transcribe.resolve_input_path", return_value=source), \
         patch("agent.tools.transcribe.subprocess.run", side_effect=OSError("ffprobe missing")), \
         patch("agent.tools.transcribe._normalize_audio", return_value=normalized), \
         patch("agent.tools.transcribe._split_audio", return_value=[(normalized, 0.0)]), \
         patch("agent.tools.transcribe._openai_whisper",
               return_value=([{"start": 0.0, "end": 1.0, "text": "안녕"}], "ko")), \
         patch("agent.tools.transcribe._save_transcript_cache",
               return_value=tmp_path / "sample.json"):
        result = json.loads(transcribe_video.invoke({
            "video_path": str(source),
            "force": True,
            "polish": False,
        }))

    assert result["status"] == "success"
