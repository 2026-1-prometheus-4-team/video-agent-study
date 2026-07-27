"""팀원 머지분(PR #23/#24/#25)이 모노레포 구조에서 살아있는지 고정하는 테스트.

main 은 옛 평면 구조라 git rename 감지가 일부 실패했고, 수동 이식한 부분이
다음 리팩터에서 조용히 사라지지 않게 계약을 박아둔다.
"""

import importlib
import json
import os

import pytest


# =============================================================
# PR #25 (이은채) — voice 선택 + 전사→TTS
# =============================================================

class TestTtsVoiceSelection:
    def _mod(self):
        return importlib.import_module("agent.tools.tts")

    def test_voice_id_param_wins(self):
        resolved, _, err = self._mod()._resolve_voice("male_ko_general", "explicit_id")
        assert resolved == "explicit_id" and err is None

    def test_numeric_alias_reads_env_slot(self, monkeypatch):
        monkeypatch.setenv("ELEVENLABS_VOICE_3", "slot_three")
        resolved, catalog, err = self._mod()._resolve_voice("3")
        assert resolved == "slot_three" and catalog == "3" and err is None

    def test_numeric_alias_missing_slot_names_the_var(self, monkeypatch):
        monkeypatch.delenv("ELEVENLABS_VOICE_9", raising=False)
        resolved, _, err = self._mod()._resolve_voice("9")
        # 조용한 기본값 폴백 금지 — 무엇이 없는지 알려줘야 한다
        assert resolved is None and "ELEVENLABS_VOICE_9" in err

    def test_raw_id_passes_through(self):
        resolved, catalog, err = self._mod()._resolve_voice("abc123raw")
        assert resolved == "abc123raw" and catalog is None and err is None

    def test_transcribe_to_speech_tool_registered(self):
        from agent.tools import tool_groups

        names = [t.name for t in tool_groups["audio"]]
        assert "transcribe_video_to_speech" in names

    def test_text_to_speech_keeps_both_param_sets(self):
        """팀원의 voice_id/model + 내 stability/style/speed 가 공존해야 함."""
        import inspect

        sig = inspect.signature(self._mod().text_to_speech.func)
        for p in ("text", "voice", "voice_id", "stability", "style", "speed",
                  "output_path", "model"):
            assert p in sig.parameters, p


# =============================================================
# PR #24 (byungkun) — 다중 영상 병렬 분석 + transcript 통합
# =============================================================

class TestMultiVideoAnalysis:
    def test_scenes_tagged_with_source_video(self, monkeypatch):
        import agent.graph as g

        fake = {
            "a.mp4": {"duration": 10.0, "segments": [
                {"start_ms": 0, "end_ms": 1000, "description": "A 장면"}]},
            "b.mp4": {"duration": 5.0, "segments": [
                {"start_ms": 0, "end_ms": 500, "description": "B 장면"}]},
        }
        monkeypatch.setattr(
            g, "_analyze_one_video", lambda p: (os.path.basename(p), fake[os.path.basename(p)])
        )
        out = g.analysis_node({"video_paths": ["videos/a.mp4", "videos/b.mp4"]})
        ctx = out["video_context"]

        assert ctx["duration"] == 15.0
        assert {s["video"] for s in ctx["scenes"]} == {"videos/a.mp4", "videos/b.mp4"}
        assert [v["file_path"] for v in ctx["videos"]] == ["videos/a.mp4", "videos/b.mp4"]

    def test_single_video_has_no_video_tag(self, monkeypatch):
        import agent.graph as g

        monkeypatch.setattr(g, "_analyze_one_video", lambda p: (
            "a.mp4", {"duration": 3.0, "segments": [
                {"start_ms": 0, "end_ms": 1000, "description": "장면"}]},
        ))
        ctx = g.analysis_node({"video_paths": ["videos/a.mp4"]})["video_context"]
        assert "videos" not in ctx
        assert "video" not in ctx["scenes"][0]

    def test_failed_video_excluded_not_fatal(self, monkeypatch):
        import agent.graph as g

        results = {
            "ok.mp4": {"duration": 4.0, "segments": [
                {"start_ms": 0, "end_ms": 1000, "description": "정상"}]},
            "bad.mp4": {"error": "분석 실패"},
        }
        monkeypatch.setattr(
            g, "_analyze_one_video", lambda p: (os.path.basename(p), results[os.path.basename(p)])
        )
        ctx = g.analysis_node({"video_paths": ["videos/ok.mp4", "videos/bad.mp4"]})["video_context"]
        assert ctx["duration"] == 4.0 and len(ctx["scenes"]) == 1

    def test_transcript_feeds_search_blob(self, tmp_path):
        """byungkun 의 transcript 필드가 내 검색 blob 에 들어가야 발화 기반 검색이 산다."""
        from agent.tools.edit import search_video_segments

        analysis = {"segments": [
            {"start_ms": 0, "end_ms": 3000, "description": "실내",
             "transcript": "진짜 맛있다"},
        ]}
        p = tmp_path / "a.json"
        p.write_text(json.dumps(analysis, ensure_ascii=False), encoding="utf-8")

        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "맛있다", "analysis_path": str(p),
        }))
        assert payload["status"] == "success"
        assert payload["matches"][0]["start_ms"] == 0

    def test_analysis_context_preserves_whisper_and_rich_scene_fields(self, monkeypatch):
        import agent.graph as g

        monkeypatch.setattr(g, "_analyze_one_video", lambda p: (
            "a.mp4",
            {
                "duration": 4.0,
                "segments": [{
                    "start_ms": 0,
                    "end_ms": 4000,
                    "description": "주방 설명",
                    "transcript": "장면 요약 대사",
                    "objects": ["접시"],
                    "people_count": 1,
                    "actions": ["설명한다"],
                    "mood": "밝음",
                }],
                "_source_transcript": [
                    {"start": 0.25, "end": 1.75, "text": "정확한 위스퍼 문장"},
                ],
            },
        ))

        ctx = g.analysis_node({"video_paths": ["videos/a.mp4"]})["video_context"]
        assert ctx["transcript"] == [
            {"start": 0.25, "end": 1.75, "text": "정확한 위스퍼 문장"},
        ]
        assert ctx["scenes"][0]["objects"] == ["접시"]
        assert ctx["scenes"][0]["actions"] == ["설명한다"]
        assert ctx["scenes"][0]["mood"] == "밝음"


# =============================================================
# PR #23 (eunseo) — 폰트
# =============================================================

class TestSubtitleFont:
    def test_common_noto_cjk_alias_resolves_to_bundled_family(self):
        from agent.tools.subtitle_cues import _resolve_font_family

        assert _resolve_font_family("Noto Sans CJK KR") == "NotoSansKR"

    def test_family_derived_from_filename(self):
        from agent.tools.subtitle import _font_family_from_file

        assert _font_family_from_file("NanumGothic-Regular.ttf") == "NanumGothic"
        assert _font_family_from_file("BlackHanSans-Regular.ttf") == "BlackHanSans"
        assert _font_family_from_file("Custom.ttf") == "Custom"

    def test_burn_and_cue_paths_share_the_font_default(self):
        """add_subtitle(번인)과 큐 렌더가 다른 폰트를 쓰면 같은 영상에서 폰트가 갈린다."""
        from agent.tools.subtitle import _DEFAULT_FONT_FILE, _font_family_from_file
        from agent.tools.subtitle_cues import DEFAULT_STYLE

        assert DEFAULT_STYLE["font"] == _font_family_from_file(_DEFAULT_FONT_FILE)

    def test_download_script_targets_backend_fonts_dir(self):
        """스크립트가 받는 폰트가 자막 렌더러가 뒤지는 디렉터리에 떨어져야 한다."""
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        src = (root / "scripts" / "download_fonts.py").read_text(encoding="utf-8")
        assert '"backend", "assets", "fonts"' in src
