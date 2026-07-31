"""Canonical transcript reuse across analysis and planning."""

from __future__ import annotations

import json
import importlib
from pathlib import Path
from unittest.mock import MagicMock, patch

from agent import config
from agent.tools import video_analysis
from agent.tools.transcribe import transcribe_video

graph = importlib.import_module("agent.graph")


def test_video_analysis_does_not_overwrite_transcribe_cache(tmp_path):
    videos = tmp_path / "videos"
    subtitles = videos / "subtitles"
    videos.mkdir()
    source = videos / "sample.mp4"
    source.write_bytes(b"video")
    result = {
        "status": "success",
        "segments": [{"start": 0.0, "end": 1.0, "text": "교정본"}],
        "raw_segments": [{"start": 0.0, "end": 1.0, "text": "원본"}],
        "correction": {"status": "applied"},
        "language": "ko",
        "engine": "openai",
    }

    with patch.object(video_analysis, "VIDEOS_DIR", str(videos)), \
         patch.object(video_analysis, "SUBTITLES_DIR", str(subtitles)), \
         patch.object(
             transcribe_video,
             "func",
             MagicMock(return_value=json.dumps(result, ensure_ascii=False)),
         ):
        segments = video_analysis._load_transcript("sample.mp4")

    assert segments[0]["text"] == "교정본"
    assert not (subtitles / "sample.json").exists()


def test_cached_analysis_prefers_canonical_corrected_transcript(tmp_path):
    videos = tmp_path / "videos"
    videos.mkdir()
    source = videos / "sample.mp4"
    source.write_bytes(b"video")
    (videos / "sample_analysis.json").write_text(
        json.dumps({
            "video_path": "sample.mp4",
            "duration": 1.0,
            "orientation": {"detector_version": 2, "clockwise_degrees": 0},
            "transcript": [{"start": 0.0, "end": 1.0, "text": "오래된 분석 대사"}],
            "segments": [],
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    corrected = [{"start": 0.0, "end": 1.0, "text": "교정된 원본 대사"}]

    with patch.object(config, "VIDEOS_DIR", Path(videos)), \
         patch.object(
             transcribe_video,
             "func",
             MagicMock(return_value=json.dumps({
                 "status": "success",
                 "segments": corrected,
             }, ensure_ascii=False)),
         ):
        filename, data = graph._analyze_one_video(str(source))

    assert filename == "sample.mp4"
    assert data["_source_transcript"] == corrected
