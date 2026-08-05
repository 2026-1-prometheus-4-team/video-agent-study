"""쇼츠 기획 파이프라인 스파인 테스트 (오프라인).

- analysis_node 가 감정/대사 메타를 scene 에 실어보내고 transcript 를 호이스팅하는가
- research_prepass 가 리서치 의도에서만 돌고 아니면 no-op 인가
- trend_distill 이 등록됐는가
"""

import json

import pytest


class TestAnalysisEmotionalData:
    def test_scene_carries_mood_actions_transcript(self, monkeypatch):
        import agent.graph as g

        monkeypatch.setattr(g, "_analyze_one_video", lambda p: (
            "a.mp4",
            {
                "duration": 5.0,
                "segments": [{
                    "start_ms": 0, "end_ms": 3000,
                    "description": "엘리베이터 셀카",
                    "mood": "energetic",
                    "people_count": 1,
                    "people": ["젊은 여성"],
                    "actions": ["셀카 촬영"],
                    "transcript": "결국 새벽 4시에 이사했어요",
                }],
            },
        ))
        ctx = g.analysis_node({"video_paths": ["videos/a.mp4"]})["video_context"]
        scene = ctx["scenes"][0]
        assert scene["mood"] == "energetic"
        assert scene["actions"] == ["셀카 촬영"]
        assert scene["transcript"] == "결국 새벽 4시에 이사했어요"
        # 대사가 상위 transcript 로 호이스팅됐는가 (자막/검색 blob 이 씀)
        assert ctx["transcript"][0]["text"] == "결국 새벽 4시에 이사했어요"

    def test_no_transcript_no_hoist(self, monkeypatch):
        import agent.graph as g

        monkeypatch.setattr(g, "_analyze_one_video", lambda p: (
            "a.mp4",
            {"duration": 2.0, "segments": [{"start_ms": 0, "end_ms": 1000, "description": "장면"}]},
        ))
        ctx = g.analysis_node({"video_paths": ["videos/a.mp4"]})["video_context"]
        assert ctx["transcript"] == []
        assert "mood" not in ctx["scenes"][0]


class TestResearchPrepass:
    def test_skips_without_research_intent(self):
        from agent.graph import research_prepass
        # 단순 편집 요청 — 리서치 no-op
        assert research_prepass({"user_request": "3초에서 7초 잘라줘"}) == {}
        assert research_prepass({"user_request": "자막 넣어줘"}) == {}

    def test_runs_on_research_intent(self, monkeypatch):
        import agent.graph as g
        import agent.tools.research_external as rx
        import agent.tools.research_llm as rl

        # 트렌드 리서치는 기본 OFF — 명시 활성화 시에만 실행된다.
        monkeypatch.setenv("ENABLE_TREND_RESEARCH", "true")

        # research_prepass 는 함수 내부에서 import 하므로 소스 모듈의 툴 객체를
        # 통째로 fake(.invoke 가진) 로 교체한다 (StructuredTool 은 attr 설정 불가).
        class _Fake:
            def __init__(self, ret):
                self._ret = ret
            def invoke(self, _a):
                return self._ret

        monkeypatch.setattr(rx, "youtube_search",
                            _Fake(json.dumps({"results": [{"title": "이사 브이로그"}]})))
        monkeypatch.setattr(rx, "web_search", _Fake(json.dumps({"results": []})))
        monkeypatch.setattr(rl, "trend_distill", _Fake(json.dumps({
            "niche": "이사 쇼츠",
            "trend_elements": ["빠른 컷", "현실 공감", "유쾌 내레이션"],
            "named_concept": "우당탕탕 현실 이사",
        })))
        out = g.research_prepass({"user_request": "이사 브이로그 트렌디하게 숏츠로 만들어줘"})
        assert "trend_brief" in out
        assert out["trend_brief"]["trend_elements"] == ["빠른 컷", "현실 공감", "유쾌 내레이션"]

    def test_reentry_does_not_reresearch(self):
        from agent.graph import research_prepass
        # 이미 trend_brief 있으면 재조사 안 함
        out = research_prepass({
            "user_request": "트렌디하게 기획해줘",
            "trend_brief": {"niche": "x"},
        })
        assert out == {}

    def test_distill_failure_is_noop(self, monkeypatch):
        import agent.graph as g
        import agent.tools.research_external as rx
        import agent.tools.research_llm as rl

        monkeypatch.setenv("ENABLE_TREND_RESEARCH", "true")

        class _Fake:
            def __init__(self, ret):
                self._ret = ret
            def invoke(self, _a):
                return self._ret

        monkeypatch.setattr(rx, "youtube_search", _Fake("{}"))
        monkeypatch.setattr(rx, "web_search", _Fake("{}"))
        monkeypatch.setattr(rl, "trend_distill", _Fake(json.dumps({"_error": "quota"})))
        out = g.research_prepass({"user_request": "요즘 트렌드 분석해서 기획해줘"})
        assert out == {}  # 실패해도 기획은 계속


class TestToolRegistration:
    def test_new_tools_registered(self):
        from agent.tools import tool_groups, tool_map
        edit = [t.name for t in tool_groups["edit"]]
        audio = [t.name for t in tool_groups["audio"]]
        research = [t.name for t in tool_groups["research"]]
        assert {"speed_video", "split_screen", "crossfade_video"} <= set(edit)
        assert {"add_bgm_progression", "generate_sfx"} <= set(audio)
        assert "trend_distill" in research
        assert "trend_distill" in tool_map
