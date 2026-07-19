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

from agent.tools.edit import (
    crossfade_video,
    cut_by_description,
    cut_video,
    merge_video,
    resize_video,
    search_video_segments,
    speed_video,
    split_screen,
)


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


# =============================================================
# resize_video — 화면비 변환
# =============================================================

class TestResizeVideo:
    def test_crop_mode_builds_crop_filter(self, tmp_path):
        """crop 모드는 increase + crop 필터로 꽉 채운다."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_video_meta",
                   return_value={"width": 1920, "height": 1080, "codec_name": "h264", "fps": "30/1"}):
            _mock_ffmpeg_success(mock_run)
            result = resize_video.invoke({
                "video_path": str(fake_video),
                "aspect_ratio": "9:16",
                "mode": "crop",
            })

        assert not result.startswith("ERROR"), result
        vf = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-vf") + 1]
        assert "force_original_aspect_ratio=increase" in vf
        assert "crop=" in vf
        # 1080 높이 기준 9:16 -> 1080*9/16 = 607.5 -> 반올림 608 (짝수)
        assert "608:1080" in vf

    def test_pad_mode_builds_pad_filter(self, tmp_path):
        """pad 모드는 decrease + pad 필터로 여백을 채운다."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_video_meta",
                   return_value={"width": 1920, "height": 1080, "codec_name": "h264", "fps": "30/1"}):
            _mock_ffmpeg_success(mock_run)
            result = resize_video.invoke({
                "video_path": str(fake_video),
                "aspect_ratio": "9:16",
                "mode": "pad",
            })

        assert not result.startswith("ERROR"), result
        vf = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-vf") + 1]
        assert "force_original_aspect_ratio=decrease" in vf
        assert "pad=" in vf

    def test_invalid_aspect_ratio(self, tmp_path):
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        result = resize_video.invoke({
            "video_path": str(fake_video),
            "aspect_ratio": "3:7",
        })
        assert result.startswith("ERROR")
        assert "지원하지 않는 비율" in result

    def test_invalid_mode(self, tmp_path):
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        result = resize_video.invoke({
            "video_path": str(fake_video),
            "mode": "stretch",
        })
        assert result.startswith("ERROR")

    def test_file_not_found(self):
        result = resize_video.invoke({"video_path": "nonexistent.mp4"})
        assert result.startswith("ERROR")


# =============================================================
# speed_video — 배속
# =============================================================

class TestSpeedVideo:
    def test_whole_video_no_audio_builds_setpts(self, tmp_path):
        """오디오 없는 영상 전체 배속: setpts 만, atempo 없음."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_has_audio", return_value=False):
            _mock_ffmpeg_success(mock_run)
            result = speed_video.invoke({
                "video_path": str(fake_video),
                "factor": 2.0,
            })

        assert not result.startswith("ERROR"), result
        cmd = mock_run.call_args[0][0]
        joined = " ".join(cmd)
        assert "setpts=PTS/2.0" in joined
        assert "atempo" not in joined
        assert "-an" in cmd

    def test_whole_video_4x_chains_atempo_twice(self, tmp_path):
        """오디오 있는 4배속: setpts=PTS/4.0 + atempo=2.0 두 번 체이닝."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_has_audio", return_value=True):
            _mock_ffmpeg_success(mock_run)
            result = speed_video.invoke({
                "video_path": str(fake_video),
                "factor": 4.0,
            })

        assert not result.startswith("ERROR"), result
        fc = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-filter_complex") + 1]
        assert "setpts=PTS/4.0" in fc
        assert fc.count("atempo=2.0") == 2

    def test_segment_speed_cuts_and_merges(self, tmp_path):
        """구간 배속: 앞/뒤 원속도 컷 + 구간 배속 후 병합."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_has_audio", return_value=False), \
             patch("agent.tools.edit._ffprobe_duration_sec", return_value=10.0):
            _mock_ffmpeg_success(mock_run)
            result = speed_video.invoke({
                "video_path": str(fake_video),
                "factor": 2.0,
                "start_ms": 2000,
                "end_ms": 5000,
                "output_path": "sped.mp4",
            })

        assert result == str(tmp_path / "sped.mp4")
        # 여러 ffmpeg 호출 중 하나는 구간 배속(setpts) 명령이어야 한다.
        assert any(
            any("setpts=PTS/2.0" in str(arg) for arg in call.args[0])
            for call in mock_run.call_args_list
        )
        # 앞(원속도 컷) + 배속 구간 + 뒤(원속도 컷) + 병합 = 최소 4회 호출
        assert mock_run.call_count >= 4

    def test_invalid_factor(self, tmp_path):
        """factor 범위(0.5~4.0) 밖 -> ERROR."""
        fake_video = tmp_path / "sample.mp4"
        fake_video.write_bytes(b"fake")

        result = speed_video.invoke({
            "video_path": str(fake_video),
            "factor": 5.0,
        })
        assert result.startswith("ERROR")
        assert "factor" in result

    def test_file_not_found(self):
        result = speed_video.invoke({"video_path": "nonexistent.mp4", "factor": 2.0})
        assert result.startswith("ERROR")


# =============================================================
# split_screen — 화면 분할
# =============================================================

class TestSplitScreen:
    def test_vstack_builds_vstack_filter(self, tmp_path):
        """vstack: 각 패널 1080x960 + vstack 필터."""
        clip1 = tmp_path / "a.mp4"
        clip2 = tmp_path / "b.mp4"
        clip1.write_bytes(b"f1")
        clip2.write_bytes(b"f2")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)
            result = split_screen.invoke({
                "video_paths": [str(clip1), str(clip2)],
                "layout": "vstack",
            })

        assert not result.startswith("ERROR"), result
        fc = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-filter_complex") + 1]
        assert "vstack=inputs=2:shortest=1" in fc
        assert "1080:960" in fc

    def test_hstack_builds_hstack_filter(self, tmp_path):
        """hstack: 각 패널 540x1920 + hstack 필터."""
        clip1 = tmp_path / "a.mp4"
        clip2 = tmp_path / "b.mp4"
        clip1.write_bytes(b"f1")
        clip2.write_bytes(b"f2")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)
            result = split_screen.invoke({
                "video_paths": [str(clip1), str(clip2)],
                "layout": "hstack",
            })

        assert not result.startswith("ERROR"), result
        fc = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-filter_complex") + 1]
        assert "hstack=inputs=2" in fc
        assert "540:1920" in fc

    def test_requires_two_videos(self, tmp_path):
        """영상 1개 -> ERROR."""
        clip1 = tmp_path / "a.mp4"
        clip1.write_bytes(b"f1")

        result = split_screen.invoke({"video_paths": [str(clip1)]})
        assert result.startswith("ERROR")

    def test_invalid_layout(self, tmp_path):
        clip1 = tmp_path / "a.mp4"
        clip2 = tmp_path / "b.mp4"
        clip1.write_bytes(b"f1")
        clip2.write_bytes(b"f2")

        result = split_screen.invoke({
            "video_paths": [str(clip1), str(clip2)],
            "layout": "grid",
        })
        assert result.startswith("ERROR")
        assert "layout" in result


# =============================================================
# crossfade_video — 크로스페이드 전환
# =============================================================

class TestCrossfadeVideo:
    def test_builds_xfade_chain_with_offsets(self, tmp_path):
        """3개 클립 -> xfade 2회 체이닝 + 누적 offset 계산."""
        clips = []
        for name in ("a.mp4", "b.mp4", "c.mp4"):
            p = tmp_path / name
            p.write_bytes(b"fake")
            clips.append(str(p))

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_has_audio", return_value=False), \
             patch("agent.tools.edit._ffprobe_duration_sec", return_value=5.0):
            _mock_ffmpeg_success(mock_run)
            result = crossfade_video.invoke({
                "clip_paths": clips,
                "duration": 0.4,
            })

        assert not result.startswith("ERROR"), result
        fc = mock_run.call_args[0][0][mock_run.call_args[0][0].index("-filter_complex") + 1]
        assert fc.count("xfade=transition=fade") == 2
        # d0=5.0 -> offset1 = 5.0-0.4 = 4.600, 누적 9.6 -> offset2 = 9.200
        assert "offset=4.600" in fc
        assert "offset=9.200" in fc

    def test_with_audio_adds_acrossfade(self, tmp_path):
        """모든 클립에 오디오 있으면 acrossfade 도 체이닝."""
        clips = []
        for name in ("a.mp4", "b.mp4"):
            p = tmp_path / name
            p.write_bytes(b"fake")
            clips.append(str(p))

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._ffprobe_has_audio", return_value=True), \
             patch("agent.tools.edit._ffprobe_duration_sec", return_value=5.0):
            _mock_ffmpeg_success(mock_run)
            result = crossfade_video.invoke({"clip_paths": clips})

        assert not result.startswith("ERROR"), result
        cmd = mock_run.call_args[0][0]
        fc = cmd[cmd.index("-filter_complex") + 1]
        assert "acrossfade=d=0.4" in fc
        assert "[aout]" in cmd

    def test_duration_longer_than_clip(self, tmp_path):
        """전환 길이가 클립보다 길면 -> ERROR."""
        clips = []
        for name in ("a.mp4", "b.mp4"):
            p = tmp_path / name
            p.write_bytes(b"fake")
            clips.append(str(p))

        with patch("agent.tools.edit._ffprobe_duration_sec", return_value=0.2):
            result = crossfade_video.invoke({"clip_paths": clips, "duration": 0.4})
        assert result.startswith("ERROR")

    def test_single_clip_returns_path(self, tmp_path):
        """클립 1개면 FFmpeg 없이 그 경로 반환."""
        clip1 = tmp_path / "a.mp4"
        clip1.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run:
            result = crossfade_video.invoke({"clip_paths": [str(clip1)]})

        mock_run.assert_not_called()
        assert result == str(clip1)

    def test_empty_list(self):
        result = crossfade_video.invoke({"clip_paths": []})
        assert result.startswith("ERROR")

