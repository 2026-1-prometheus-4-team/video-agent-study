"""회전 메타가 붙은 세로 영상을 가로로 판정하면 안 된다.

실제 증상: 폰으로 세로 촬영한 클립 4개가 컨테이너에 1280x720 + rotation -90 으로
저장돼 있었는데 전부 가로로 판정됐다. 그래서 merge_video 가 1280x720 을 기준
해상도로 잡아 세로 클립을 좌우 여백에 가뒀고, 이어진 9:16 리사이즈가 그 전체를
다시 위아래 여백에 넣어 원본이 최종 화면의 7% 까지 쪼그라들었다.
"""

from __future__ import annotations

import subprocess

import pytest

from agent.tools.edit import _ffprobe_video_meta, _stream_rotation, _streams_compatible


def _has_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def test_rotation_from_display_matrix():
    assert _stream_rotation({"side_data_list": [{"rotation": -90}]}) == -90


def test_rotation_from_legacy_tag():
    """예전 파일은 display matrix 대신 tags.rotate 에 회전을 싣는다."""
    assert _stream_rotation({"tags": {"rotate": "270"}}) == 270


def test_rotation_absent_is_zero():
    assert _stream_rotation({"width": 1280, "height": 720}) == 0


def test_rotation_garbage_is_zero():
    assert _stream_rotation({"side_data_list": [{"rotation": "?"}], "tags": {}}) == 0


def test_streams_with_different_rotation_are_incompatible():
    """회전이 다르면 stream copy 로 붙일 수 없다 — 컨테이너 회전은 첫 것만 남는다."""
    upright = {"codec_name": "h264", "width": 720, "height": 1280, "rotation": 0, "fps": "30/1"}
    rotated = {**upright, "rotation": -90}

    assert _streams_compatible([upright, dict(upright)]) is True
    assert _streams_compatible([upright, rotated]) is False


@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg 없음")
def test_rotated_video_reports_display_size(tmp_path):
    """컨테이너는 가로여도 회전이 붙었으면 세로로 읽어야 한다."""
    base = tmp_path / "base.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:duration=1:rate=10",
            "-pix_fmt", "yuv420p", str(base),
        ],
        capture_output=True,
        check=True,
    )
    rotated = tmp_path / "rotated.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(rotated)],
        capture_output=True,
        check=True,
    )

    assert _ffprobe_video_meta(str(base))["width"] == 640
    assert _ffprobe_video_meta(str(base))["height"] == 360

    meta = _ffprobe_video_meta(str(rotated))
    assert (meta["width"], meta["height"]) == (360, 640), (
        "회전을 무시하면 세로 클립이 가로로 판정돼 병합 기준이 뒤집힌다"
    )


@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg 없음")
def test_merge_base_resolution_follows_portrait_majority(tmp_path):
    """세로 다수 + 가로 하나면 병합 기준은 세로여야 한다 (이번 사고의 구성)."""
    from collections import Counter

    clips = []
    for index in range(4):
        base = tmp_path / f"p{index}_base.mp4"
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:duration=1:rate=10",
                "-pix_fmt", "yuv420p", str(base),
            ],
            capture_output=True,
            check=True,
        )
        portrait = tmp_path / f"p{index}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-display_rotation", "90", "-i", str(base), "-c", "copy", str(portrait)],
            capture_output=True,
            check=True,
        )
        clips.append(portrait)

    landscape = tmp_path / "landscape.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:duration=1:rate=10",
            "-pix_fmt", "yuv420p", str(landscape),
        ],
        capture_output=True,
        check=True,
    )
    clips.append(landscape)

    dims = [
        (m["width"], m["height"])
        for m in (_ffprobe_video_meta(str(c)) for c in clips)
        if m
    ]

    assert Counter(dims).most_common(1)[0][0] == (360, 640)
