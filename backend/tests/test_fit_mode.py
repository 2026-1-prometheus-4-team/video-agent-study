"""가로 클립과 세로 클립은 같은 캔버스에 다르게 들어가야 한다.

세로 소스를 세로 캔버스에 crop 하면 비율이 같아 잘리는 게 없지만, 가로 소스를
세로로 crop 하면 화면 대부분이 사라진다 (1280x720 -> 9:16 이면 가로의 68%).
그래서 mode="auto" 는 클립마다 판단한다 — 세로는 꽉 채우고, 가로는 폭을 맞춘 뒤
위아래를 검은 여백으로 둔다.
"""

from __future__ import annotations

import pytest

from agent.tools.edit import _fit_filter, _fit_mode_for_clip

PORTRAIT = (720, 1280)  # 9:16 목표 캔버스


@pytest.mark.parametrize(
    "src_w,src_h,expected",
    [
        (1280, 720, "pad"),    # 가로 — 잘리면 손실이 크다
        (1920, 1080, "pad"),
        (720, 1280, "crop"),   # 세로 — 비율이 같아 무손실
        (1080, 1920, "crop"),
        (720, 1600, "crop"),   # 더 길쭉한 세로 — 위아래만 살짝 잘린다
        (1080, 1080, "pad"),   # 정사각 — 세로 캔버스보다 넓다
    ],
)
def test_auto_picks_per_clip(src_w, src_h, expected):
    assert _fit_mode_for_clip("auto", src_w, src_h, *PORTRAIT) == expected


def test_explicit_mode_is_respected():
    """사용자가 crop/pad 를 지정하면 화면비와 무관하게 그대로 따른다."""
    assert _fit_mode_for_clip("crop", 1280, 720, *PORTRAIT) == "crop"
    assert _fit_mode_for_clip("pad", 720, 1280, *PORTRAIT) == "pad"


def test_unknown_size_falls_back_to_pad():
    """메타 판독 실패 시 원본을 보존하는 쪽으로 — crop 은 되돌릴 수 없다."""
    assert _fit_mode_for_clip("auto", 0, 0, *PORTRAIT) == "pad"


def test_landscape_target_flips_the_decision():
    """16:9 로 만들 때는 반대가 된다 — 세로 소스가 여백을 받는다."""
    landscape = (1280, 720)
    assert _fit_mode_for_clip("auto", 720, 1280, *landscape) == "pad"
    assert _fit_mode_for_clip("auto", 1920, 1080, *landscape) == "crop"


def test_filter_chain_matches_the_decision():
    landscape_clip = _fit_filter(1280, 720, *PORTRAIT, "auto")
    portrait_clip = _fit_filter(720, 1280, *PORTRAIT, "auto")

    assert "pad=720:1280" in landscape_clip
    assert "force_original_aspect_ratio=decrease" in landscape_clip
    assert "crop=720:1280" in portrait_clip
    assert "force_original_aspect_ratio=increase" in portrait_clip
