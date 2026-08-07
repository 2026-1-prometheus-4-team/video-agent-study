"""캡션 단계가 편집 계보 메타(.origin.json / .pad.json)를 승계해야 한다.

실제 증상: 자막 cue 30개가 정상 생성됐는데 최종본에 자막이 한 줄도 안 나왔다.
add_auto_subtitle(burn=false) 이 남긴 cue 문서는 그 시점 stem 에 묶여 있고,
서버는 최종본 stem 의 cues.json 이 없으면 .origin.json 을 따라가 복원한다.
add_title / BGM 은 사이드카를 승계하는데 캡션 계열만 빠뜨려서, 강조 캡션이
자막 단계 뒤에 오는 순간 최종본에 둘 다 없어졌다 (final_video.mp4 사이드카 0개).
그 결과 프론트는 자막을 못 올리고 자막 스타일 카드도 안 떴다.
"""

from __future__ import annotations

import json
import subprocess

import pytest

from agent.tools.subtitle import add_caption, add_captions_batch, add_emoji_overlay

ORIGIN = {"clips": [{"source": "1.mp4", "start_ms": 0, "end_ms": 1000, "offset_ms": 0}]}
PAD = {"x": 0, "y": 437, "w": 720, "h": 405}


def _has_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


pytestmark = pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg 없음")


@pytest.fixture
def video_with_sidecars(tmp_path):
    """1초짜리 무음 테스트 영상 + 사이드카 2개."""
    video = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x568:duration=1:rate=10",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-shortest", "-pix_fmt", "yuv420p", str(video),
        ],
        capture_output=True,
        check=True,
    )
    (tmp_path / "clip.mp4.origin.json").write_text(json.dumps(ORIGIN), encoding="utf-8")
    (tmp_path / "clip.mp4.pad.json").write_text(json.dumps(PAD), encoding="utf-8")
    return video


def _output_of(raw: str):
    payload = json.loads(raw)
    assert "error" not in payload, payload
    return payload["output"]


def _assert_sidecars_carried(output: str):
    from pathlib import Path

    out = Path(output)
    for suffix in (".origin.json", ".pad.json"):
        sidecar = Path(f"{out}{suffix}")
        assert sidecar.exists(), f"{suffix} 가 승계되지 않아 자막 계보가 끊긴다"

    assert json.loads(Path(f"{out}.origin.json").read_text(encoding="utf-8")) == ORIGIN
    assert json.loads(Path(f"{out}.pad.json").read_text(encoding="utf-8")) == PAD


def test_add_caption_carries_sidecars(video_with_sidecars):
    raw = add_caption.invoke(
        {"video_path": str(video_with_sidecars), "text": "육각렌치 실화냐?", "at_time": 0.0}
    )
    _assert_sidecars_carried(_output_of(raw))


def test_add_captions_batch_carries_sidecars(video_with_sidecars, tmp_path):
    raw = add_captions_batch.invoke(
        {
            "video_path": str(video_with_sidecars),
            "captions": [{"text": "첫 줄", "start": 0.0, "end": 0.5}],
            "output_path": str(tmp_path / "batched.mp4"),
        }
    )
    _assert_sidecars_carried(_output_of(raw))


def test_add_emoji_overlay_carries_sidecars(video_with_sidecars):
    raw = add_emoji_overlay.invoke(
        {"video_path": str(video_with_sidecars), "emoji": "🔥", "at_time": 0.0}
    )
    _assert_sidecars_carried(_output_of(raw))


def test_sidecars_absent_stays_quiet(tmp_path):
    """사이드카가 없던 입력이면 아무것도 만들지 않고 조용히 지나간다."""
    video = tmp_path / "bare.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=320x568:duration=1:rate=10",
            "-pix_fmt", "yuv420p", str(video),
        ],
        capture_output=True,
        check=True,
    )

    output = _output_of(
        add_caption.invoke({"video_path": str(video), "text": "자막", "at_time": 0.0})
    )

    from pathlib import Path

    assert not Path(f"{output}.origin.json").exists()
    assert not Path(f"{output}.pad.json").exists()
