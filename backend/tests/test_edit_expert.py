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
    cut_by_description,
    cut_video,
    merge_video,
    resize_video,
    search_video_segments,
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
    def test_bare_cut_outputs_are_resolved_from_outputs_dir(self, tmp_path):
        """cut_video의 bare output 이름을 merge_video가 outputs/에서 다시 찾는다."""
        outputs = tmp_path / "outputs"
        videos = tmp_path / "videos"
        legacy = tmp_path / "output"
        outputs.mkdir()
        videos.mkdir()
        legacy.mkdir()
        (outputs / "cut_clip_1.mp4").write_bytes(b"clip1")
        (outputs / "cut_clip_2.mp4").write_bytes(b"clip2")

        with patch("agent.tools.edit._PROJECT_ROOT", str(tmp_path)), \
             patch("agent.tools.edit.OUTPUTS_DIR", str(outputs)), \
             patch("agent.tools.edit.LEGACY_OUTPUT_DIR", str(legacy)), \
             patch("agent.tools.edit.VIDEOS_DIR", str(videos)), \
             patch("agent.tools.edit.subprocess.run") as mock_run:
            _mock_ffmpeg_success(mock_run)
            result = merge_video.invoke({
                "clip_paths": ["cut_clip_1.mp4", "cut_clip_2.mp4"],
                "output_path": "merged.mp4",
            })

        assert result == str(outputs / "merged.mp4")

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

        # merge 이후 origin 기록용 ffprobe 도 호출되므로 전체 호출에서 ffmpeg 를 찾는다
        cmd = next(
            call[0][0] for call in mock_run.call_args_list
            if call[0] and call[0][0] and call[0][0][0] == "ffmpeg"
        )
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
# origin 추적 — 클립이 원본의 어느 구간인지 기록
# =============================================================

class TestOriginTracking:
    """cut/merge 가 남기는 <파일>.origin.json 검증.

    자막 생성 시 재전사 대신 원본 분석 transcript 를 시간축 보정해
    재사용하기 위한 배관이다.
    """

    def test_cut_writes_origin(self, tmp_path):
        from agent.tools.edit import _read_origin

        fake_video = tmp_path / "src.mp4"
        fake_video.write_bytes(b"fake")

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)):
            _mock_ffmpeg_success(mock_run)
            out = cut_video.invoke({
                "video_path": str(fake_video),
                "start_ms": 4000,
                "end_ms": 9000,
            })

        origin = _read_origin(out)
        assert origin is not None
        assert len(origin) == 1
        assert origin[0]["start_ms"] == 4000
        assert origin[0]["end_ms"] == 9000
        assert origin[0]["offset_ms"] == 0

    def test_merge_accumulates_offsets(self, tmp_path):
        """merge 는 각 클립의 원본 구간에 누적 오프셋을 붙여 기록."""
        from agent.tools.edit import _read_origin, _write_origin

        c1 = tmp_path / "c1.mp4"
        c2 = tmp_path / "c2.mp4"
        c1.write_bytes(b"f1")
        c2.write_bytes(b"f2")
        _write_origin(str(c1), [{"source": "/v/a.mp4", "start_ms": 0, "end_ms": 3000, "offset_ms": 0}])
        _write_origin(str(c2), [{"source": "/v/b.mp4", "start_ms": 7000, "end_ms": 12000, "offset_ms": 0}])

        with patch("agent.tools.edit.subprocess.run") as mock_run, \
             patch("agent.tools.edit.OUTPUTS_DIR", str(tmp_path)), \
             patch("agent.tools.edit._probe_duration_ms", return_value=3000):
            _mock_ffmpeg_success(mock_run)
            out = merge_video.invoke({"clip_paths": [str(c1), str(c2)]})

        origin = _read_origin(out)
        assert len(origin) == 2
        assert origin[0]["offset_ms"] == 0        # 첫 클립은 0 부터
        assert origin[1]["offset_ms"] == 3000     # 둘째는 첫 클립 길이만큼 밀림
        assert origin[1]["start_ms"] == 7000      # 원본 구간은 보존

    def test_transcript_reconstructed_with_offset(self, tmp_path):
        """origin + 분석 JSON -> 결과물 시간축에 맞는 자막 재구성."""
        from agent.tools.edit import _write_origin
        from agent.tools.subtitle import _transcript_from_origin

        analysis = {
            "segments": [
                {"start_ms": 0, "end_ms": 1000, "transcript": "첫 대사"},
                {"start_ms": 4000, "end_ms": 5000, "transcript": "둘째 대사"},
                {"start_ms": 9000, "end_ms": 10000, "transcript": "클립 밖 대사"},
            ]
        }
        (tmp_path / "src_analysis.json").write_text(
            json.dumps(analysis, ensure_ascii=False), encoding="utf-8"
        )

        merged = tmp_path / "merged.mp4"
        merged.write_bytes(b"fake")
        _write_origin(str(merged), [
            {"source": str(tmp_path / "src.mp4"), "start_ms": 0, "end_ms": 1000, "offset_ms": 0},
            {"source": str(tmp_path / "src.mp4"), "start_ms": 4000, "end_ms": 5000, "offset_ms": 1000},
        ])

        with patch("agent.tools.subtitle.VIDEOS_DIR", str(tmp_path)):
            tr = _transcript_from_origin(str(merged))

        assert len(tr) == 2, "클립 구간 밖 대사는 제외돼야 함"
        assert tr[0]["text"] == "첫 대사"
        assert tr[0]["start"] == 0.0
        assert tr[1]["text"] == "둘째 대사"
        assert tr[1]["start"] == 1.0, "원본 4초 대사가 결과물 1초 위치로 이동"

    def test_no_origin_returns_empty(self, tmp_path):
        """origin 없으면 빈 리스트 -> 호출측이 재전사로 fallback."""
        from agent.tools.subtitle import _transcript_from_origin

        plain = tmp_path / "plain.mp4"
        plain.write_bytes(b"fake")
        assert _transcript_from_origin(str(plain)) == []


# =============================================================
# 발화 경계 스냅 — 말이 중간에 끊기지 않게
# =============================================================

class TestSpeechSnap:
    """cut 지점이 발화 도중이면 그 발화 경계까지 넓힌다.

    자막 원천은 Whisper 원본(videos/subtitles/<원본>.json)을 1순위로 쓴다.
    분석 JSON 의 transcript 는 프레임 구간에 뭉개져 있어 경계가 부정확하기 때문.
    """

    @pytest.fixture
    def speech_dirs(self, tmp_path):
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        subs.mkdir(parents=True)
        (subs / "src.json").write_text(json.dumps({
            "segments": [
                {"start": 1.25, "end": 4.14, "text": "첫 문장입니다"},
                {"start": 5.43, "end": 8.76, "text": "둘째 문장입니다"},
            ]
        }, ensure_ascii=False), encoding="utf-8")
        (videos / "src.mp4").write_bytes(b"fake")
        return videos

    def test_whisper_json_preferred_over_analysis(self, speech_dirs):
        """Whisper 원본이 있으면 분석 JSON 대신 그걸 쓴다."""
        from agent.tools.subtitle import _source_speech

        # 경계가 다른 분석 JSON 도 같이 둔다
        (speech_dirs / "src_analysis.json").write_text(json.dumps({
            "segments": [{"start_ms": 0, "end_ms": 1000, "transcript": "뭉개진 경계"}]
        }, ensure_ascii=False), encoding="utf-8")

        with patch("agent.tools.subtitle.VIDEOS_DIR", str(speech_dirs)), \
             patch("agent.tools.subtitle.SUBTITLES_DIR", str(speech_dirs / "subtitles")):
            speech = _source_speech(str(speech_dirs / "src.mp4"))

        assert len(speech) == 2
        assert speech[0]["start_ms"] == 1250, "Whisper 의 실제 발화 시작"
        assert speech[0]["text"] == "첫 문장입니다"

    def test_snap_extends_to_speech_boundary(self, speech_dirs):
        """발화 한가운데를 자르면 발화 시작/끝으로 넓힌다."""
        from agent.tools.edit import _snap_to_speech

        with patch("agent.tools.subtitle.VIDEOS_DIR", str(speech_dirs)), \
             patch("agent.tools.subtitle.SUBTITLES_DIR", str(speech_dirs / "subtitles")):
            # 5430~8760ms 발화의 한가운데(7000)에서 시작하는 컷
            start, end = _snap_to_speech(str(speech_dirs / "src.mp4"), 7000, 10000)

        assert start == 5430, "발화 시작으로 당겨져야 함"

    def test_snap_leaves_silence_untouched(self, speech_dirs):
        """발화가 없는 구간은 그대로 둔다."""
        from agent.tools.edit import _snap_to_speech

        with patch("agent.tools.subtitle.VIDEOS_DIR", str(speech_dirs)), \
             patch("agent.tools.subtitle.SUBTITLES_DIR", str(speech_dirs / "subtitles")):
            result = _snap_to_speech(str(speech_dirs / "src.mp4"), 20000, 23000)

        assert result == (20000, 23000)

    def test_snap_respects_max_extend(self, speech_dirs):
        """아주 긴 발화 한가운데는 의도적 컷으로 보고 넓히지 않는다."""
        from agent.tools.edit import _snap_to_speech

        subs = speech_dirs / "subtitles"
        (subs / "long.json").write_text(json.dumps({
            "segments": [{"start": 0.0, "end": 60.0, "text": "아주 긴 발화"}]
        }, ensure_ascii=False), encoding="utf-8")
        (speech_dirs / "long.mp4").write_bytes(b"fake")

        with patch("agent.tools.subtitle.VIDEOS_DIR", str(speech_dirs)), \
             patch("agent.tools.subtitle.SUBTITLES_DIR", str(subs)):
            # 발화 시작에서 30초나 떨어진 지점 -> _SNAP_MAX_EXTEND_MS 초과라 그대로
            result = _snap_to_speech(str(speech_dirs / "long.mp4"), 30000, 35000)

        assert result == (30000, 35000)
