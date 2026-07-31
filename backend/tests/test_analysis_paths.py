"""
분석 JSON 파일명 규칙 단위 테스트

videos/ 밖(편집 결과물 outputs/ 등) 영상이 원본과 basename 이 같을 때 원본 분석을
덮어쓰지 않는지 + edit.py 자동 탐색이 그 규칙과 맞물리는지 검증.
Gemini / OpenCV 호출 없이 순수 경로 로직만 확인.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from agent.tools.edit import _find_analysis_path
from agent.tools.video_analysis import analysis_stem, _analysis_api_key, _is_rate_limit_error


class TestAnalysisApiKey:
    def test_dedicated_analysis_key_wins(self, monkeypatch):
        monkeypatch.setenv("GOOGLE_API_KEY_ANALYSIS", "analysis-key")
        monkeypatch.setenv("GOOGLE_API_KEY", "shared-key")
        assert _analysis_api_key() == "analysis-key"

    def test_shared_key_is_fallback(self, monkeypatch):
        monkeypatch.delenv("GOOGLE_API_KEY_ANALYSIS", raising=False)
        monkeypatch.setenv("GOOGLE_API_KEY", "shared-key")
        assert _analysis_api_key() == "shared-key"

    @pytest.mark.parametrize("message", [
        "429 Too Many Requests",
        "RESOURCE_EXHAUSTED: quota exceeded",
        "rate limit reached",
    ])
    def test_rate_limit_detection(self, message):
        assert _is_rate_limit_error(RuntimeError(message))


@pytest.fixture
def dirs(tmp_path):
    videos = tmp_path / "videos"
    outputs = tmp_path / "outputs"
    videos.mkdir()
    outputs.mkdir()
    return {"tmp": tmp_path, "videos": videos, "outputs": outputs}


# =============================================================
# analysis_stem
# =============================================================

class TestAnalysisStem:
    def test_relative_path_keeps_plain_stem(self, dirs):
        """videos/ 기준 상대경로 = 기존 이름 유지 (graph.py 캐시 탐색 호환)."""
        assert analysis_stem("london.mp4", str(dirs["videos"])) == "london"

    def test_absolute_inside_videos_keeps_plain_stem(self, dirs):
        """절대경로라도 videos/ 안이면 같은 파일 → 기존 이름 유지."""
        path = dirs["videos"] / "london.mp4"
        assert analysis_stem(str(path), str(dirs["videos"])) == "london"

    def test_absolute_outside_videos_is_scoped(self, dirs):
        """[회귀] outputs/london.mp4 가 videos/london_analysis.json 을 덮어쓰면 안 됨."""
        path = dirs["outputs"] / "london.mp4"
        stem = analysis_stem(str(path), str(dirs["videos"]))

        assert stem != "london"
        assert stem.startswith("london_")
        assert stem != analysis_stem(str(dirs["videos"] / "london.mp4"), str(dirs["videos"]))

    def test_scoped_stem_is_stable_and_path_unique(self, dirs):
        """같은 경로 → 같은 stem (재분석 시 캐시 일관), 다른 경로 → 다른 stem."""
        a = dirs["outputs"] / "london.mp4"
        b = dirs["outputs"] / "sub" / "london.mp4"

        assert analysis_stem(str(a), str(dirs["videos"])) == \
            analysis_stem(str(a), str(dirs["videos"]))
        assert analysis_stem(str(a), str(dirs["videos"])) != \
            analysis_stem(str(b), str(dirs["videos"]))

    def test_nested_videos_subdir_keeps_plain_stem(self, dirs):
        nested = dirs["videos"] / "sub" / "london.mp4"
        assert analysis_stem(str(nested), str(dirs["videos"])) == "london"

    def test_sibling_dir_prefix_is_not_treated_as_inside(self, dirs):
        """videos_extra/ 는 videos/ 하위가 아님 (문자열 prefix 매칭 함정)."""
        sibling = dirs["tmp"] / "videos_extra" / "london.mp4"
        assert analysis_stem(str(sibling), str(dirs["videos"])) != "london"


# =============================================================
# edit._find_analysis_path 정합성
# =============================================================

class TestFindAnalysisPath:
    def _write(self, path: Path, marker: str) -> None:
        path.write_text(json.dumps({"marker": marker}), encoding="utf-8")

    def test_outputs_video_prefers_scoped_analysis_over_original(self, dirs):
        """[회귀] 같은 basename 원본 분석이 아니라 자기 분석을 찾아야 함."""
        edited = dirs["outputs"] / "london.mp4"
        self._write(dirs["videos"] / "london_analysis.json", "original")
        scoped = analysis_stem(str(edited), str(dirs["videos"]))
        self._write(dirs["videos"] / f"{scoped}_analysis.json", "edited")

        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            found = _find_analysis_path(str(edited))

        assert found is not None
        assert json.loads(Path(found).read_text(encoding="utf-8"))["marker"] == "edited"

    def test_videos_video_still_uses_plain_name(self, dirs):
        """기존 videos/ 기준 동작 보존."""
        self._write(dirs["videos"] / "london_analysis.json", "original")

        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            by_name = _find_analysis_path("london.mp4")
            by_abs = _find_analysis_path(str(dirs["videos"] / "london.mp4"))

        assert by_name == str(dirs["videos"] / "london_analysis.json")
        assert by_abs == str(dirs["videos"] / "london_analysis.json")

    def test_falls_back_to_plain_name_when_no_scoped_analysis(self, dirs):
        """scoped 분석이 아직 없으면 기존처럼 basename 후보로 폴백."""
        self._write(dirs["videos"] / "london_analysis.json", "original")

        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            found = _find_analysis_path(str(dirs["outputs"] / "london.mp4"))

        assert found == str(dirs["videos"] / "london_analysis.json")

    def test_legacy_variant_names_still_found(self, dirs):
        self._write(dirs["videos"] / "london_analysis_v2.json", "v2")

        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            found = _find_analysis_path("london.mp4")

        assert found == str(dirs["videos"] / "london_analysis_v2.json")

    def test_explicit_analysis_path_wins(self, dirs):
        explicit = dirs["tmp"] / "custom.json"
        self._write(explicit, "explicit")
        self._write(dirs["videos"] / "london_analysis.json", "original")

        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            found = _find_analysis_path("london.mp4", str(explicit))

        assert found == str(explicit)

    def test_missing_analysis_returns_none(self, dirs):
        with patch("agent.tools.edit.VIDEOS_DIR", str(dirs["videos"])):
            assert _find_analysis_path("ghost.mp4") is None


# =============================================================
# 샘플링 간격 자동 선택
# =============================================================

class TestAutoInterval:
    """영상 길이 -> 샘플링 간격 매핑.

    프레임 수를 100~200 장 안팎으로 유지해 토큰 비용과 Gemini 정렬 정확도를
    동시에 잡는 것이 목적.
    """

    @pytest.mark.parametrize("duration_sec,expected", [
        (10, 1.0),      # 아주 짧음
        (60, 1.0),      # 경계: 1분
        (61, 3.0),      # 1분 초과
        (300, 3.0),     # 경계: 5분
        (301, 5.0),     # 5분 초과
        (900, 5.0),     # 경계: 15분
        (901, 10.0),    # 15분 초과
        (1582, 10.0),   # worldcup 26분
        (7200, 10.0),   # 2시간도 상한 유지
    ])
    def test_interval_by_duration(self, duration_sec, expected):
        from agent.tools.video_analysis import _auto_interval_sec
        assert _auto_interval_sec(duration_sec) == expected

    def test_frame_count_stays_bounded(self):
        """긴 영상에서도 프레임 수가 폭증하지 않는지."""
        from agent.tools.video_analysis import _auto_interval_sec
        for duration in (600, 1582, 3600):
            frames = duration / _auto_interval_sec(duration)
            assert frames <= 400, f"{duration}s -> {frames:.0f} 장 (과다)"

    def test_explicit_interval_overrides_auto(self, tmp_path):
        """interval_sec 을 명시하면 자동 선택을 쓰지 않는다."""
        from agent.tools.video_analysis import analyze_video

        fake = tmp_path / "clip.mp4"
        fake.write_bytes(b"fake")

        with patch("agent.tools.video_analysis._probe_duration_sec") as probe, \
             patch("agent.tools.video_analysis._extract_frames", return_value=(20.0, [])):
            analyze_video.invoke({"video_path": str(fake), "interval_sec": 7.0})
            probe.assert_not_called()   # 명시했으므로 길이 조회 자체를 안 함
