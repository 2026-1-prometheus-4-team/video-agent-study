"""critic 은 최종 영상의 길이를 실제로 재야 한다.

실제 증상: "60초 이내" 요청에 76.2초짜리가 나왔는데 critic 이 PASS 했다. 길이를
재지 않고 실행 트레이스 텍스트만 보고 판단했기 때문이다. 계획은 컷 합 50.2초로
제한을 지켰지만, 실행 단계에서 컷 경계가 씬 경계로 넓어지며 75.8초가 됐다.
"""

from __future__ import annotations

import subprocess

import pytest

from agent.nodes.critic_node import (
    DURATION_TOLERANCE,
    _measure_duration,
    _target_duration,
)


def _has_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def test_target_from_plan_root():
    assert _target_duration({"target_duration_sec": 60}) == 60.0


def test_target_falls_back_to_creative_brief():
    assert _target_duration({"creative_brief": {"target_duration_sec": 45}}) == 45.0


def test_target_absent_or_invalid_is_none():
    assert _target_duration({}) is None
    assert _target_duration({"target_duration_sec": None}) is None
    assert _target_duration({"target_duration_sec": "육십초"}) is None
    assert _target_duration({"target_duration_sec": 0}) is None
    assert _target_duration(None) is None


def test_missing_file_measures_none():
    """측정 실패가 검증 자체를 막으면 안 된다 — None 으로 조용히 넘어간다."""
    assert _measure_duration("outputs/이런파일은없다.mp4") is None
    assert _measure_duration("") is None
    assert _measure_duration(None) is None


@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg 없음")
def test_measures_real_duration(tmp_path):
    video = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x568:duration=3:rate=10",
            "-pix_fmt", "yuv420p", str(video),
        ],
        capture_output=True,
        check=True,
    )

    measured = _measure_duration(str(video))

    assert measured is not None
    assert abs(measured - 3.0) < 0.3


def test_overrun_is_detected_but_rounding_is_not():
    """76.2초/60초는 위반. 60.5초/60초는 인코딩 오차라 위반이 아니다."""
    target = 60.0
    assert 76.2 > target * DURATION_TOLERANCE
    assert not (60.5 > target * DURATION_TOLERANCE)
