"""
edit_expert Tool 단위 테스트

FFmpeg 바이너리 없이도 돌아가도록 subprocess.run 을 mock 처리.
실제 영상 파일도 필요 없음 (tmp_path 로 가짜 파일 생성).
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agent.tools.edit import cut_by_description, cut_video, merge_video, search_video_segments


def _mock_ffmpeg_success(mock_run):
    """subprocess.run mock 이 실제 FFmpeg처럼 출력 파일을 만들게 한다."""

    def _side_effect(cmd, *args, **kwargs):
        output_path = Path(cmd[-1])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"fake_output")
        return MagicMock(returncode=0, stderr="")

    mock_run.side_effect = _side_effect


# =============================================================
# cut_video
# =============================================================

class TestCutVideo:
    def test_success(self, tmp_path):
        """정상 케이스: FFmpeg 성공 시 output 경로 반환."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake_video_data")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)

            result = cut_video.invoke({
                "video_path": str(fake_video),
                "start_ms": 6000,
                "end_ms": 12000,
            })

        assert not result.startswith("ERROR"), f"예상치 못한 오류: {result}"
        assert result.endswith(".mp4")

        cmd = mock_run.call_args[0][0]
        assert "ffmpeg" in cmd
        assert "-ss" in cmd
        assert "6.000" in cmd   # 6000ms = 6.000s
        assert "-t" in cmd
        assert "6.000" in cmd   # duration 6000ms = 6.000s

    def test_file_not_found(self):
        """존재하지 않는 파일 경로 → ERROR 반환."""
        result = cut_video.invoke({
            "video_path": "nonexistent_video.mp4",
            "start_ms": 0,
            "end_ms": 5000,
        })
        assert result.startswith("ERROR")

    def test_invalid_timestamps(self, tmp_path):
        """end_ms <= start_ms → ERROR 반환."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        result = cut_video.invoke({
            "video_path": str(fake_video),
            "start_ms": 5000,
            "end_ms": 3000,
        })
        assert result.startswith("ERROR")
        assert "end_ms" in result

    def test_ffmpeg_failure(self, tmp_path):
        """FFmpeg returncode != 0 → ERROR 반환."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            mock_run.return_value = MagicMock(
                returncode=1, stderr="Invalid data found when processing input"
            )
            result = cut_video.invoke({
                "video_path": str(fake_video),
                "start_ms": 0,
                "end_ms": 5000,
            })

        assert result.startswith("ERROR")
        assert "rc=1" in result

    def test_custom_output_path(self, tmp_path):
        """output_path 지정 시 해당 경로로 저장."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")
        out = str(tmp_path / "my_cut.mp4")

        with patch("agent.tools.edit.subprocess.run") as mock_run:
            _mock_ffmpeg_success(mock_run)
            result = cut_video.invoke({
                "video_path": str(fake_video),
                "start_ms": 1000,
                "end_ms": 4000,
                "output_path": out,
            })

        assert result == out
        cmd = mock_run.call_args[0][0]
        assert cmd[-1] == out

    def test_bare_output_filename_goes_to_outputs_dir(self, tmp_path):
        """디렉터리 없는 output_path 도 outputs/ 기준으로 안전하게 처리."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)
            result = cut_video.invoke({
                "video_path": str(fake_video),
                "start_ms": 1000,
                "end_ms": 3000,
                "output_path": "clip.mp4",
            })

        assert result == str(tmp_path / "clip.mp4")


# =============================================================
# merge_video
# =============================================================

class TestMergeVideo:
    def test_two_clips_concat_command(self, tmp_path):
        """클립 2개 → FFmpeg concat demuxer 명령 정상 생성 확인."""
        clip1 = tmp_path / "clip1.mp4"
        clip2 = tmp_path / "clip2.mp4"
        clip1.write_bytes(b"fake1")
        clip2.write_bytes(b"fake2")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)

            result = merge_video.invoke({
                "clip_paths": [str(clip1), str(clip2)],
            })

        assert not result.startswith("ERROR"), f"예상치 못한 오류: {result}"
        assert result.endswith(".mp4")

        cmd = mock_run.call_args[0][0]
        assert "ffmpeg" in cmd
        assert "-f" in cmd
        assert "concat" in cmd
        assert "-safe" in cmd

    def test_single_clip_no_ffmpeg_call(self, tmp_path):
        """클립 1개면 FFmpeg 호출 없이 해당 경로 바로 반환."""
        clip1 = tmp_path / "clip1.mp4"
        clip1.write_bytes(b"fake1")

        with patch("agent.tools.edit.subprocess.run") as mock_run:
            result = merge_video.invoke({
                "clip_paths": [str(clip1)],
            })

        mock_run.assert_not_called()
        assert result == str(clip1)

    def test_empty_list(self):
        """clip_paths 빈 리스트 → ERROR 반환."""
        result = merge_video.invoke({"clip_paths": []})
        assert result.startswith("ERROR")

    def test_missing_clip(self, tmp_path):
        """존재하지 않는 클립 포함 → ERROR 반환."""
        real_clip = tmp_path / "real.mp4"
        real_clip.write_bytes(b"fake")

        result = merge_video.invoke({
            "clip_paths": [str(real_clip), "ghost.mp4"],
        })
        assert result.startswith("ERROR")

    def test_ffmpeg_failure(self, tmp_path):
        """FFmpeg concat 실패 → ERROR 반환."""
        clip1 = tmp_path / "a.mp4"
        clip2 = tmp_path / "b.mp4"
        clip1.write_bytes(b"f1")
        clip2.write_bytes(b"f2")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            mock_run.return_value = MagicMock(returncode=1, stderr="concat error")
            result = merge_video.invoke({
                "clip_paths": [str(clip1), str(clip2)],
            })

        assert result.startswith("ERROR")


# =============================================================
# analysis 기반 검색 / 컷
# =============================================================

class TestAnalysisDrivenEdit:
    def test_search_video_segments_matches_description_and_objects(self, tmp_path):
        """분석 JSON의 description / objects 기반으로 구간 검색."""
        analysis = {
            "segments": [
                {
                    "start_ms": 0,
                    "end_ms": 1000,
                    "description": "도입부 셀카 장면",
                    "objects": ["사람"],
                },
                {
                    "start_ms": 1000,
                    "end_ms": 2500,
                    "description": "타워 브리지 전경",
                    "objects": ["타워 브리지", "강"],
                },
            ]
        }
        analysis_path = tmp_path / "analysis.json"
        analysis_path.write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")

        result = search_video_segments.invoke({
            "video_path": "london.mp4",
            "query": "타워 브리지",
            "analysis_path": str(analysis_path),
        })
        payload = json.loads(result)

        assert payload["status"] == "success"
        assert len(payload["matches"]) == 1
        assert payload["matches"][0]["start_ms"] == 1000

    def test_cut_by_description_cuts_each_match_and_merges(self, tmp_path):
        """내용 기반 검색 -> cut_video -> merge_video 흐름."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")
        analysis = {
            "segments": [
                {"start_ms": 0, "end_ms": 1000, "description": "스테이크 접시"},
                {"start_ms": 2000, "end_ms": 3000, "description": "스테이크 클로즈업"},
            ]
        }
        analysis_path = tmp_path / "analysis.json"
        analysis_path.write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)
            result = cut_by_description.invoke({
                "video_path": str(fake_video),
                "query": "스테이크",
                "analysis_path": str(analysis_path),
                "merge": True,
                "output_path": "steak.mp4",
            })

        payload = json.loads(result)
        assert payload["status"] == "success"
        assert len(payload["clips"]) == 2
        assert payload["merged_output"] == str(tmp_path / "steak.mp4")

