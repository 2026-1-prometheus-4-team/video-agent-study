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

from agent.tools.bgm import add_bgm_progression
from agent.tools.sfx import generate_sfx


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


# =============================================================
# add_bgm_progression
# =============================================================

class TestAddBgmProgression:
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
        assert data["measured_lufs"] == -14.5

        filt = _filter_complex(mock_run)
        # 두 구간 각각 atrim + adelay
        assert filt.count("atrim=0:") == 2
        assert "adelay=0|0" in filt              # 첫 구간 start 0s
        assert "adelay=8000|8000" in filt        # 둘째 구간 start 8s
        # 두 트랙을 하나로 합치는 amix + 최종 mix amix
        assert filt.count("amix=inputs=") == 2
        assert "amix=inputs=2:duration=longest" in filt
        # 더킹 + 라우드니스 정규화
        assert "sidechaincompress" in filt
        assert "loudnorm=I=-14.0" in filt

    def test_target_lufs_override(self, tmp_path):
        """target_lufs 를 주면 loudnorm 목표가 바뀐다 (쇼츠 -16)."""
        video = tmp_path / "vlog.mp4"
        video.write_bytes(b"fake_video")
        bgm = tmp_path / "bgm.mp3"
        bgm.write_bytes(b"fake")

        with patch("agent.tools.audio_common.subprocess.run") as mock_run:
            _mock_ffmpeg(mock_run)
            add_bgm_progression.invoke(
                {
                    "video_path": str(video),
                    "segments": [
                        {"bgm_path": str(bgm), "start_sec": 0.0, "end_sec": 5.0}
                    ],
                    "output_path": str(tmp_path / "out.mp4"),
                    "target_lufs": -16.0,
                }
            )

        filt = _filter_complex(mock_run)
        assert "loudnorm=I=-16.0" in filt

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
        assert kwargs["json"]["text"] == "띠로리 실패음"
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
