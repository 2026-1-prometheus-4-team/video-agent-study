"""
쇼츠용 오디오 도구 단위 테스트 (add_bgm_progression / generate_sfx)

FFmpeg 바이너리와 ElevenLabs API 없이 오프라인으로 돌아가도록 mock 처리.
- add_bgm_progression: audio_common.subprocess.run 을 patch (run_ffmpeg + measure_lufs 공통 경로)
- generate_sfx: sfx.requests.post 와 sfx.os.getenv 를 patch
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

import agent.tools.bgm as bgm_module
import agent.tools.audio_common as audio_common_module
from agent.tools.bgm import add_bgm, add_bgm_progression
from agent.tools.audio_mix import mix_audio
from agent.tools.sfx import add_sfx, generate_sfx


_CLOSED_LOOP_METRICS = {
    "dialogue_lufs": -16.0,
    "bgm_non_speech_lufs": -23.0,
    "bgm_speech_lufs": -28.0,
    "mix_lufs": -15.7,
    "actual_dialogue_bgm_gap": {"non_speech_lu": 7.0, "speech_lu": 12.0},
    "gain_correction_db": 0.0,
    "duck_gain_db": -5.0,
    "calibration_passes": 1,
    "calibration_passed": True,
}
_REAL_CLOSED_LOOP_BGM_MIX = bgm_module._closed_loop_bgm_mix


@pytest.fixture(autouse=True)
def _mock_closed_loop_calibration():
    with patch(
        "agent.tools.bgm._ensure_speech_intervals",
        return_value=([(0.5, 1.5)], None, "transcript_timestamps"),
    ), patch(
        "agent.tools.bgm._closed_loop_bgm_mix",
        return_value=dict(_CLOSED_LOOP_METRICS),
    ):
        yield


def _mock_ffmpeg(mock_run):
    """subprocess.run mock 이 출력 파일을 만들고 LUFS 측정용 stderr 를 돌려주게 한다."""

    def _side_effect(cmd, *args, **kwargs):
        last = cmd[-1]
        if isinstance(last, str) and not last.startswith("-"):
            output_path = Path(last)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(b"fake_output")
        return MagicMock(returncode=0, stderr="I:   -14.5 LUFS")

    mock_run.side_effect = _side_effect


def _filter_complex(mock_run) -> str:
    """호출된 ffmpeg 명령들 중 -filter_complex 인자 문자열을 찾아 반환."""
    for call in mock_run.call_args_list:
        cmd = call[0][0]
        if "-filter_complex" in cmd:
            return cmd[cmd.index("-filter_complex") + 1]
    raise AssertionError("filter_complex ffmpeg 호출이 없습니다")


def test_mix_audio_rejects_bgm_inputs(tmp_path):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    bgm = tmp_path / "generated_bgm.mp3"
    bgm.write_bytes(b"music")

    result = json.loads(mix_audio.invoke({
        "video_path": str(video),
        "audio_path": str(bgm),
    }))

    assert result["status"] == "error"
    assert result["required_tool"] == "add_bgm"


def test_ffmpeg_voice_vad_builds_active_intervals(tmp_path):
    media = tmp_path / "video.mp4"
    media.write_bytes(b"video")
    completed = MagicMock(
        returncode=0,
        stderr=(
            "silence_start: 0\n"
            "silence_end: 1.0\n"
            "silence_start: 2.5\n"
            "silence_end: 4.0\n"
        ),
    )
    with patch.object(audio_common_module, "probe_duration", return_value=5.0), \
         patch.object(audio_common_module, "_run", return_value=completed):
        intervals = audio_common_module.detect_voice_activity(media)

    assert intervals == [(0.92, 2.62), (3.92, 5.0)]


def test_closed_loop_recalibrates_out_of_range_gaps(tmp_path):
    video = tmp_path / "video.mp4"
    video.write_bytes(b"video")
    bgm = tmp_path / "bgm.mp3"
    bgm.write_bytes(b"music")
    output = tmp_path / "out.mp4"

    def fake_render(**kwargs):
        kwargs["dialogue_path"].write_bytes(b"dialogue")
        kwargs["bgm_bus_path"].write_bytes(b"bgm")

    with patch.object(bgm_module, "_render_single_buses", side_effect=fake_render), \
         patch.object(
             bgm_module,
             "measure_lufs_intervals",
             side_effect=[-16.0, -30.0, -26.0, -16.0, -28.0, -23.0],
         ), \
         patch.object(bgm_module, "measure_lufs", return_value=-15.5), \
         patch.object(bgm_module, "run_ffmpeg"):
        metrics = _REAL_CLOSED_LOOP_BGM_MIX(
            video=video,
            bgm=bgm,
            output=output,
            duration=5.0,
            speech_intervals=[(1.0, 3.0)],
            speech_target_lufs=-16.0,
        )

    assert metrics["calibration_passes"] == 2
    assert metrics["calibration_passed"] is True
    assert metrics["gain_correction_db"] == 3.0
    assert metrics["actual_dialogue_bgm_gap"] == {
        "non_speech_lu": 7.0,
        "speech_lu": 12.0,
    }


# =============================================================
# add_bgm_progression
# =============================================================

class TestAddBgmProgression:
    def test_transcript_timestamps_gate_ducking_detector(self, tmp_path):
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        subtitles = tmp_path / "subtitles"
        subtitles.mkdir()
        (subtitles / "vlog.json").write_text(
            json.dumps({"segments": [
                {"start": 1.0, "end": 2.0, "text": "hello"},
                {"start": 4.0, "end": 5.0, "text": "world"},
            ]}),
            encoding="utf-8",
        )

        with patch.object(bgm_module, "_SUBTITLES_DIR", subtitles):
            detector_filter, mode, count = bgm_module._speech_detector_filter(video)

        assert mode == "transcript_timestamps"
        assert count == 2
        assert "between(t,0.880,2.180)" in detector_filter
        assert "between(t,3.880,5.180)" in detector_filter

    def test_two_segments_build_atrim_adelay_amix(self, tmp_path):
        """2구간: 각 트랙 atrim + adelay 후 amix, 더킹/loudnorm 체인이 구성된다."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm_a = tmp_path / "upbeat.mp3"
        bgm_a.write_bytes(b"fake_a")
        bgm_b = tmp_path / "healing.mp3"
        bgm_b.write_bytes(b"fake_b")

        segments = [
            {"bgm_path": str(bgm_a), "start_sec": 0.0, "end_sec": 8.0},
            {"bgm_path": str(bgm_b), "start_sec": 8.0, "end_sec": 15.0},
        ]

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            result = add_bgm_progression.invoke(
                {
                    "video_path": str(video),
                    "segments": segments,
                    "output_path": str(tmp_path / "out.mp4"),
                }
            )

        data = json.loads(result)
        assert data["status"] == "success", data
        assert data["segments_applied"] == 2
        assert data["bgm_mixed"] is True
        assert data["mix_verified"] is True
        assert data["dialogue_lufs"] == -16.0
        assert data["bgm_non_speech_lufs"] == -23.0
        assert data["bgm_speech_lufs"] == -28.0
        assert data["actual_dialogue_bgm_gap"] == {
            "non_speech_lu": 7.0, "speech_lu": 12.0,
        }
        assert data["ducking_mode"] == "transcript_timestamps"

    def test_target_lufs_override(self, tmp_path):
        """target_lufs 를 주면 loudnorm 목표가 바뀐다 (쇼츠 -16)."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "bgm.mp3"
        bgm.write_bytes(b"fake")

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            result = add_bgm_progression.invoke(
                {
                    "video_path": str(video),
                    "segments": [
                        {"bgm_path": str(bgm), "start_sec": 0.0, "end_sec": 5.0}
                    ],
                    "output_path": str(tmp_path / "out.mp4"),
                    "target_lufs": -13.0,
                    "max_correction_db": 1.0,
                }
            )

        data = json.loads(result)
        assert data["mix_verified"] is True
        assert data["calibration_passes"] == 1

    def test_volume_and_ducking_are_configurable(self, tmp_path):
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "bgm.mp3"
        bgm.write_bytes(b"fake")

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            result = add_bgm_progression.invoke(
                {
                    "video_path": str(video),
                    "segments": [{"bgm_path": str(bgm), "start_sec": 0, "end_sec": 5}],
                    "output_path": str(tmp_path / "out.mp4"),
                    "volume": 0.8,
                    "ducking": False,
                    "bgm_target_lufs": -20,
                }
            )

        data = json.loads(result)
        assert data["status"] == "success"
        assert data["volume"] == 0.8
        assert data["ducking_applied"] is False
        filt = _filter_complex(mock_run)
        assert "loudnorm=I=-20.0:TP=-2:LRA=7,volume=0.8" in filt
        assert "sidechaincompress" not in filt

    def test_invalid_volume_is_rejected(self, tmp_path):
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "bgm.mp3"
        bgm.write_bytes(b"fake")
        result = add_bgm_progression.invoke(
            {
                "video_path": str(video),
                "segments": [{"bgm_path": str(bgm), "start_sec": 0, "end_sec": 5}],
                "volume": 0,
            }
        )
        data = json.loads(result)
        assert data["status"] == "error"
        assert "volume must be between" in data["error"]


class TestAddBgm:
    def test_normalizes_music_and_reports_verified_mix(self, tmp_path):
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "bgm.mp3"
        bgm.write_bytes(b"fake")

        with patch("agent.tools.audio_common.subprocess.run") as mock_run, \
             patch("agent.tools.bgm.probe_duration", return_value=5.0):
            _mock_ffmpeg(mock_run)
            result = add_bgm.invoke(
                {
                    "video_path": str(video),
                    "bgm_path": str(bgm),
                    "output_path": str(tmp_path / "out.mp4"),
                }
            )

        data = json.loads(result)
        assert data["status"] == "success"
        assert data["bgm_mixed"] is True
        assert data["mix_verified"] is True
        assert data["dialogue_lufs"] == -16.0
        assert data["bgm_non_speech_lufs"] == -23.0
        assert data["bgm_speech_lufs"] == -28.0
        assert data["mix_lufs"] == -15.7

    def test_empty_segments_error(self, tmp_path):
        """빈 segments → 에러."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")

        result = add_bgm_progression.invoke(
            {"video_path": str(video), "segments": []}
        )
        data = json.loads(result)
        assert data["status"] == "error"
        assert "empty" in data["error"]

    def test_missing_bgm_is_skipped(self, tmp_path):
        """존재하는 구간 1개 + 없는 파일 구간 1개 → 유효 구간만 적용, 경고 남김."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "real.mp3"
        bgm.write_bytes(b"fake")

        segments = [
            {"bgm_path": str(bgm), "start_sec": 0.0, "end_sec": 5.0},
            {"bgm_path": str(tmp_path / "ghost.mp3"), "start_sec": 5.0, "end_sec": 9.0},
        ]

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            result = add_bgm_progression.invoke(
                {
                    "video_path": str(video),
                    "segments": segments,
                    "output_path": str(tmp_path / "out.mp4"),
                }
            )

        data = json.loads(result)
        assert data["status"] == "success"
        assert data["segments_applied"] == 1
        assert len(data["warnings"]) == 1

    def test_all_bgm_missing_error(self, tmp_path):
        """모든 구간의 bgm_path 가 없으면 에러."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")

        segments = [
            {"bgm_path": str(tmp_path / "a.mp3"), "start_sec": 0.0, "end_sec": 5.0},
            {"bgm_path": str(tmp_path / "b.mp3"), "start_sec": 5.0, "end_sec": 9.0},
        ]

        result = add_bgm_progression.invoke(
            {"video_path": str(video), "segments": segments}
        )
        data = json.loads(result)
        assert data["status"] == "error"
        assert data["error"] == "no valid bgm segments"


# =============================================================
# generate_sfx
# =============================================================

class TestGenerateSfx:
    def test_add_sfx_normalizes_and_limits_effect(self, tmp_path):
        video = tmp_path / "video.mp4"
        video.write_bytes(b"video")
        sfx = tmp_path / "pop.mp3"
        sfx.write_bytes(b"sfx")

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            result = add_sfx.invoke({
                "video_path": str(video),
                "sfx_path": str(sfx),
                "at_time": 1.5,
                "output_path": str(tmp_path / "out.mp4"),
            })

        data = json.loads(result)
        assert data["status"] == "success"
        assert data["sfx_target_lufs"] == -20.0
        filt = _filter_complex(mock_run)
        assert "loudnorm=I=-20.0:TP=-2:LRA=7" in filt
        assert "adelay=1500|1500" in filt
        assert "alimiter=limit=0.95" in filt

    def test_success_saves_mp3(self, tmp_path):
        """200 응답 → mp3 저장 후 경로 반환."""
        output = tmp_path / "sfx.mp3"
        mock_response = MagicMock(status_code=200, content=b"ID3fake-mp3-bytes")

        with patch("agent.tools.sfx.os.getenv", return_value="test-key"), \
             patch("agent.tools.sfx.requests.post", return_value=mock_response) as mock_post:
            result = generate_sfx.invoke(
                {
                    "description": "띠로리 실패음",
                    "output_path": str(output),
                    "duration_seconds": 2.0,
                }
            )

        data = json.loads(result)
        assert data["status"] == "success"
        assert data["output"] == str(output.resolve())
        assert data["description"] == "띠로리 실패음"
        assert output.read_bytes() == b"ID3fake-mp3-bytes"

        # 요청 body 검증: text + duration_seconds
        _, kwargs = mock_post.call_args
        assert kwargs["json"]["text"].startswith("띠로리 실패음")
        assert "No speech, no voice" in kwargs["json"]["text"]
        assert kwargs["json"]["duration_seconds"] == 2.0
        assert kwargs["headers"]["xi-api-key"] == "test-key"

    def test_no_duration_omits_field(self, tmp_path):
        """duration_seconds 없으면 payload 에서 생략."""
        output = tmp_path / "sfx.mp3"
        mock_response = MagicMock(status_code=200, content=b"bytes")

        with patch("agent.tools.sfx.os.getenv", return_value="test-key"), \
             patch("agent.tools.sfx.requests.post", return_value=mock_response) as mock_post:
            generate_sfx.invoke(
                {"description": "한숨 소리", "output_path": str(output)}
            )

        _, kwargs = mock_post.call_args
        assert "duration_seconds" not in kwargs["json"]

    def test_missing_api_key_error(self, tmp_path):
        """API 키 없으면 명확한 에러."""
        with patch("agent.tools.sfx.os.getenv", return_value=None):
            result = generate_sfx.invoke({"description": "삐끗"})
        data = json.loads(result)
        assert data["status"] == "error"
        assert "ELEVENLABS_API_KEY" in data["error"]

    def test_empty_description_error(self, tmp_path):
        """빈 설명 → 에러."""
        with patch("agent.tools.sfx.os.getenv", return_value="test-key"):
            result = generate_sfx.invoke({"description": "   "})
        data = json.loads(result)
        assert data["status"] == "error"

    def test_api_error_propagated(self, tmp_path):
        """API 4xx → 에러 + status_code 포함."""
        mock_response = MagicMock(status_code=422, text="bad request")

        with patch("agent.tools.sfx.os.getenv", return_value="test-key"), \
             patch("agent.tools.sfx.requests.post", return_value=mock_response):
            result = generate_sfx.invoke({"description": "샤라랑 반짝임"})

        data = json.loads(result)
        assert data["status"] == "error"
        assert data["status_code"] == 422
