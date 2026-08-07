"""타이틀이 화면 밖으로 잘리지 않아야 한다.

실제 증상: 720x1280 세로 영상에 96px 로 그린 "이사? 헬스룩을 위한 대참사" 가
1080px 를 차지했다. drawtext 의 x=(w-text_w)/2 는 text_w > w 이면 음수가 되어
제목 좌우가 통째로 잘려나갔다 ("사? 헬스룩을 위한").
"""

from __future__ import annotations

import pytest

from agent.tools.subtitle import (
    _resolve_font,
    _text_width_px,
    _title_block_top,
    fit_text_to_width,
)

LONG_TITLE = "이사? 헬스룩을 위한 대참사"
FONT = _resolve_font("NotoSansKR-Regular.ttf")


def _widest(lines, font, size):
    return max(_text_width_px(line, font, size) for line in lines)


def test_long_title_fits_within_width():
    max_width = 720 * 0.86

    lines, size = fit_text_to_width(LONG_TITLE, FONT, 96, max_width)

    assert _widest(lines, FONT, size) <= max_width
    assert len(lines) > 1, "한 줄로는 안 들어가므로 줄바꿈돼야 한다"
    assert "".join(lines).replace(" ", "") == LONG_TITLE.replace(" ", ""), (
        "글자를 잃어버리면 안 된다"
    )


def test_short_title_is_left_alone():
    """들어가는 제목까지 축소하거나 쪼개지 않는다."""
    lines, size = fit_text_to_width("정리 시작!", FONT, 96, 720 * 0.86)

    assert lines == ["정리 시작!"]
    assert size == 96


def test_font_size_shrinks_when_wrapping_is_not_enough():
    """2줄로도 안 되면 폰트를 줄인다."""
    very_long = "자취방 대청소 시작합니다 오늘은 옷장부터 정리할 예정입니다"

    lines, size = fit_text_to_width(very_long, FONT, 96, 720 * 0.86, max_lines=2)

    assert size < 96
    assert _widest(lines, FONT, size) <= 720 * 0.86


def test_unbreakable_word_is_split_by_character():
    """공백 없는 긴 문자열도 화면 안에 넣는다."""
    lines, size = fit_text_to_width("A" * 200, FONT, 96, 720 * 0.86, min_font_size=16)

    assert _widest(lines, FONT, size) <= 720 * 0.86


@pytest.mark.parametrize("font_file", [
    "NotoSansKR-Regular.ttf",
    "BlackHanSans-Regular.ttf",
    "GothicA1-Regular.ttf",
])
def test_every_bundled_font_fits(font_file):
    """폰트마다 글리프 폭이 달라 같은 글자수도 길이가 다르다."""
    font = _resolve_font(font_file)
    if not font:
        pytest.skip(f"{font_file} 미설치 (scripts/download_fonts.py)")
    max_width = 1180 * 0.86

    lines, size = fit_text_to_width(LONG_TITLE, font, 154, max_width)

    assert _widest(lines, font, size) <= max_width


def test_width_measurement_differs_between_fonts():
    """폰트별 실측이 실제로 반영되는지 (상수 근사면 이 테스트가 깨진다)."""
    black = _resolve_font("BlackHanSans-Regular.ttf")
    gothic = _resolve_font("GothicA1-Regular.ttf")
    if not (black and gothic):
        pytest.skip("번들 폰트 미설치")

    assert _text_width_px(LONG_TITLE, black, 154) != _text_width_px(
        LONG_TITLE, gothic, 154
    )


def test_multiline_block_is_vertically_compensated():
    """두 줄이면 블록 높이만큼 위로 올려 같은 자리에 앉힌다."""
    one_line = _title_block_top("center", 100)
    two_lines = _title_block_top("center", 200)

    assert one_line != two_lines
    assert "100" in one_line and "200" in two_lines
    assert _title_block_top("top", 200) == "h*0.05", "상단 고정은 블록 높이와 무관"


def test_measurement_falls_back_without_font_file():
    """폰트를 못 찾아도 (Pillow 없음 포함) 추정값으로 계속 동작한다."""
    width = _text_width_px("한글 텍스트", None, 100)

    assert width > 0
