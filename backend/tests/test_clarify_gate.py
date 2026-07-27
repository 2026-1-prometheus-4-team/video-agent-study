"""clarify 게이트 / ask_user / respond 모드 / 검색 고도화 유닛 테스트 (오프라인).

conftest 가 무거운 SDK 를 sys.modules mock 으로 대체하므로 전부 네트워크 없이 돈다.
"""

import json

import pytest
from langchain_core.messages import ToolMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END
from langgraph.types import Command

from agent.graph import (
    _build_trace_from_messages,
    _make_ask_user_tool,
    _normalize_candidates,
    _tool_result_status,
    clarify_gate,
    respond_node,
    route_after_supervisor,
)
from agent.nodes.script_node import should_interrupt_for_questions
from agent.state import AgentState


# =============================================================
# ask_user 툴
# =============================================================

class TestAskUserTool:
    def test_records_question_and_instructs_awaiting(self):
        holder = {}
        ask_user = _make_ask_user_tool(holder)
        result = ask_user.invoke({
            "question": "어느 장면을 쓸까?",
            "candidates": [
                {"start_ms": 1000, "end_ms": 3000, "label": "가족 식사", "score": 0.42},
            ],
            "context": "검색 신뢰도 낮음",
        })

        assert "AWAITING_USER" in result
        q = holder["question"]
        assert q["question"] == "어느 장면을 쓸까?"
        assert q["candidates"][0]["start_ms"] == 1000
        assert q["candidates"][0]["score"] == 0.42
        assert q["context"] == "검색 신뢰도 낮음"

    def test_normalize_candidates_seconds_coercion(self):
        # start/end 키로 초 단위가 오면 ms 로 승격
        out = _normalize_candidates([{"start": 12, "end": 15, "description": "장면"}])
        assert out[0]["start_ms"] == 12000
        assert out[0]["end_ms"] == 15000
        assert out[0]["label"] == "장면"

    def test_normalize_candidates_caps_and_filters(self):
        many = [{"start_ms": i * 1000, "end_ms": i * 1000 + 500} for i in range(20)]
        assert len(_normalize_candidates(many)) == 10
        assert _normalize_candidates([{"start_ms": "bad", "end_ms": None}, "notdict"]) == []


# =============================================================
# clarify_gate (미니 그래프로 interrupt 왕복)
# =============================================================

def _mini_clarify_graph():
    g = StateGraph(AgentState)
    g.add_node("clarify", clarify_gate)
    g.add_edge(START, "clarify")
    g.add_edge("clarify", END)
    return g.compile(checkpointer=MemorySaver())


class TestClarifyGate:
    def test_interrupt_payload_and_resume(self):
        app = _mini_clarify_graph()
        cfg = {"configurable": {"thread_id": "t1"}}
        initial = {
            "pending_question": {
                "question": "이 후보 맞아?",
                "candidates": [{"start_ms": 0, "end_ms": 1000, "label": "인트로"}],
                "options": [],
                "context": "저신뢰",
            },
        }

        chunks = list(app.stream(initial, cfg, stream_mode="updates"))
        intr = [c for c in chunks if "__interrupt__" in c]
        assert intr, "clarify 는 interrupt 를 발생시켜야 함"
        payload = intr[0]["__interrupt__"][0].value
        assert payload["type"] == "clarify"
        assert payload["question"] == "이 후보 맞아?"
        assert payload["candidates"][0]["end_ms"] == 1000
        assert "instructions" in payload

        # resume: 자유 답변 + 선택 인덱스
        list(app.stream(Command(resume={"reply": "맞아", "selected": [0]}), cfg,
                        stream_mode="updates"))
        state = app.get_state(cfg).values
        assert state["pending_question"] is None
        assert state["clarify_answer"] == {"reply": "맞아", "selected": [0]}
        assert state["clarify_history"][0]["answer"]["reply"] == "맞아"

    def test_non_dict_resume_coerced_to_reply(self):
        app = _mini_clarify_graph()
        cfg = {"configurable": {"thread_id": "t2"}}
        list(app.stream({"pending_question": {"question": "?"}}, cfg,
                        stream_mode="updates"))
        list(app.stream(Command(resume="두번째"), cfg, stream_mode="updates"))
        state = app.get_state(cfg).values
        assert state["clarify_answer"] == {"reply": "두번째"}


# =============================================================
# 라우팅
# =============================================================

class TestRouting:
    def test_route_after_supervisor(self):
        assert route_after_supervisor({"pending_question": {"question": "?"}}) == "clarify"
        assert route_after_supervisor({"pending_question": None}) == "critic"
        assert route_after_supervisor({}) == "critic"

    def test_terminal_verdict_skips_critic(self):
        """quota 소진 등 재시도 무의미한 오류는 critic 건너뛰고 종료."""
        state = {"critic_verdict": {"verdict": "PASS", "terminal": True}}
        assert route_after_supervisor(state) == "end"

    def test_terminal_verdict_yields_to_pending_question(self):
        state = {
            "pending_question": {"question": "?"},
            "critic_verdict": {"terminal": True},
        }
        assert route_after_supervisor(state) == "clarify"

    def test_step_id_backfilled_when_llm_omits(self):
        """step_id 없으면 _step_completed 가 영영 미완료로 봐서 재실행 루프."""
        # agent.nodes.__init__ 이 동명 함수를 re-export 해서 attribute 접근으로는
        # 모듈이 아니라 함수가 잡힌다 -> import_module 로 모듈 자체를 가져온다.
        import importlib
        sn = importlib.import_module("agent.nodes.script_node")

        plan = {"steps": [{"expert": "edit_expert"}, {"expert": "text_expert"}]}

        class _FakeMsg:
            content = json.dumps(plan, ensure_ascii=False)

        class _FakeLLM:
            def invoke(self, _messages):
                return _FakeMsg()

        orig = sn.make_llm
        sn.make_llm = lambda *a, **k: _FakeLLM()
        try:
            out = sn.script_node({"user_request": "자막 넣어줘"})
        finally:
            sn.make_llm = orig

        assert [s["step_id"] for s in out["script_plan"]["steps"]] == [1, 2]

    def test_unrequested_tts_bgm_and_captions_are_removed(self):
        import importlib
        sn = importlib.import_module("agent.nodes.script_node")

        plan = {
            "creative_brief": {
                "bgm_flow": "경쾌하게",
                "storyboard": [{
                    "narration": "자동 생성 나레이션",
                    "on_screen_text": "자동 생성 화면 문구",
                }],
            },
            "steps": [
                {
                    "step_id": 1, "expert": "edit_expert", "action": "cut_video",
                    "params": {"output_path": "resized.mp4"},
                },
                {
                    "step_id": 2, "expert": "audio_expert", "action": "text_to_speech",
                    "params": {"output_path": "narration.mp3"},
                },
                {
                    "step_id": 3, "expert": "audio_expert", "action": "mix_audio",
                    "params": {
                        "video_path": "resized.mp4",
                        "audio_path": "narration.mp3",
                        "output_path": "narrated.mp4",
                    },
                },
                {
                    "step_id": 4, "expert": "audio_expert", "action": "add_bgm",
                    "params": {
                        "video_path": "narrated.mp4",
                        "output_path": "with_bgm.mp4",
                    },
                },
                {
                    "step_id": 5, "expert": "text_expert", "action": "add_auto_subtitle",
                    "params": {"video_path": "narrated.mp4"},
                },
                {
                    "step_id": 6, "expert": "text_expert", "action": "add_caption",
                    "params": {
                        "video_path": "with_bgm.mp4",
                        "output_path": "captioned.mp4",
                    },
                },
            ],
            "questions": ["TTS 보이스?", "BGM 분위기?"],
        }

        cleaned = sn._enforce_requested_features(
            plan,
            "핵심 장면을 골라 한글 자막 넣어줘",
        )

        assert [s["action"] for s in cleaned["steps"]] == [
            "cut_video",
            "add_auto_subtitle",
        ]
        assert [s["step_id"] for s in cleaned["steps"]] == [1, 2]
        assert cleaned["steps"][1]["params"]["video_path"] == "resized.mp4"
        assert cleaned["questions"] == []
        assert cleaned["creative_brief"]["bgm_flow"] == ""
        assert cleaned["creative_brief"]["storyboard"][0]["narration"] == ""
        assert cleaned["creative_brief"]["storyboard"][0]["on_screen_text"] == ""

    def test_cut_plan_is_reduced_using_whisper_snapped_duration(self):
        import importlib
        sn = importlib.import_module("agent.nodes.script_node")

        cuts = [
            {
                "step_id": i + 1,
                "expert": "edit_expert",
                "action": "cut_video",
                "params": {
                    "video_path": "videos/a.mp4" if i < 3 else "videos/b.mp4",
                    "start_ms": i * 10_000,
                    "end_ms": i * 10_000 + 10_000,
                    "output_path": f"videos/clips/c{i}.mp4",
                },
            }
            for i in range(4)
        ]
        plan = {
            "steps": cuts + [{
                "step_id": 5,
                "expert": "edit_expert",
                "action": "merge_video",
                "params": {
                    "clip_paths": [f"videos/clips/c{i}.mp4" for i in range(4)],
                    "output_path": "videos/final.mp4",
                },
            }],
        }
        context = {
            "transcript": [
                {
                    "video": "videos/a.mp4",
                    "start": 0,
                    "end": 12,
                    "text": "긴 첫 발화",
                },
            ],
        }

        constrained = sn._constrain_cut_duration(
            plan,
            "25~35초 영상으로 만들어줘",
            context,
        )

        remaining_cuts = [
            s for s in constrained["steps"] if s["action"] == "cut_video"
        ]
        assert len(remaining_cuts) == 3
        merge = next(s for s in constrained["steps"] if s["action"] == "merge_video")
        assert len(merge["params"]["clip_paths"]) == 3
        assert constrained["estimated_cut_duration_ms"] <= 35_000

    def test_chat_mode_routes_to_respond(self):
        state = {"script_plan": {"mode": "chat", "reply": "방금 1:23 구간을 잘랐어."}}
        assert should_interrupt_for_questions(state) == "respond"

    def test_edit_mode_still_gates(self):
        state = {"script_plan": {"mode": "edit", "steps": [], "questions": []}}
        assert should_interrupt_for_questions(state) == "interrupt"

    def test_respond_node_emits_reply(self):
        state = {"script_plan": {"mode": "chat", "reply": "그 컷은 0:12~0:31 이야."}}
        out = respond_node(state)
        assert out["messages"][0].content == "그 컷은 0:12~0:31 이야."


# =============================================================
# 트레이스 매핑 (expert 중복 step)
# =============================================================

class TestTraceMapping:
    def test_reentry_continues_from_prior_ok_count(self):
        """clarify 재진입: 이미 성공한 step 이 있으면 다음 step 부터 매핑."""
        plan = {
            "steps": [
                {"step_id": 1, "expert": "edit_expert", "action": "cut_video"},
                {"step_id": 2, "expert": "edit_expert", "action": "merge_video"},
                {"step_id": 3, "expert": "edit_expert", "action": "resize"},
            ]
        }
        prior = [{"step_id": 1, "expert": "edit_expert", "action": "cut_video",
                  "status": "ok", "summary": "", "output_paths": []}]
        messages = [
            ToolMessage(content="[edit_expert] status=ok\noutputs:\n  - outputs/m.mp4",
                        name="edit", tool_call_id="1"),
        ]
        trace = _build_trace_from_messages(messages, plan, prior_trace=prior)
        # 0 부터 세면 step 1 을 덮어써 step 2 가 영영 미완료로 남는다.
        assert trace[0]["step_id"] == 2
        assert trace[0]["action"] == "merge_video"

    def test_errored_step_retry_maps_to_same_step(self):
        """실패한 step 은 성공 카운트에 안 들어가 재시도가 같은 step 에 매핑."""
        plan = {
            "steps": [
                {"step_id": 1, "expert": "edit_expert", "action": "cut_video"},
                {"step_id": 2, "expert": "edit_expert", "action": "merge_video"},
            ]
        }
        prior = [{"step_id": 1, "expert": "edit_expert", "action": "cut_video",
                  "status": "error", "summary": "", "output_paths": []}]
        messages = [
            ToolMessage(content="[edit_expert] status=ok\noutputs:\n  - outputs/c.mp4",
                        name="edit", tool_call_id="1"),
        ]
        trace = _build_trace_from_messages(messages, plan, prior_trace=prior)
        assert trace[0]["step_id"] == 1

    def test_same_expert_two_steps_mapped_by_occurrence(self):
        plan = {
            "steps": [
                {"step_id": 1, "expert": "edit_expert", "action": "cut_video"},
                {"step_id": 2, "expert": "edit_expert", "action": "merge_video"},
            ]
        }
        messages = [
            ToolMessage(content="[edit_expert] status=ok (1.0s)\noutputs:\n  - outputs/cut_a.mp4",
                        name="edit", tool_call_id="1"),
            ToolMessage(content="[edit_expert] status=ok (1.0s)\noutputs:\n  - outputs/merged_b.mp4",
                        name="edit", tool_call_id="2"),
        ]
        trace = _build_trace_from_messages(messages, plan)
        assert [t["step_id"] for t in trace] == [1, 2]
        assert trace[1]["action"] == "merge_video"

    def test_non_spawn_tools_ignored(self):
        plan = {"steps": [{"step_id": 1, "expert": "edit_expert", "action": "cut_video"}]}
        messages = [
            ToolMessage(content='{"status": "success"}', name="search_video_segments",
                        tool_call_id="1"),
            ToolMessage(content="질문이 사용자에게 전달 대기 중이다.", name="ask_user",
                        tool_call_id="2"),
        ]
        assert _build_trace_from_messages(messages, plan) == []

    def test_status_token_parsing(self):
        assert _tool_result_status("[edit_expert] status=ok (1s)\nsummary: error 없이 완료") == "ok"
        assert _tool_result_status("[edit_expert] status=error (1s)\nERROR: boom") == "error"
        assert _tool_result_status("ERROR: ffmpeg 실패") == "error"
        assert _tool_result_status("결과: outputs/a.mp4") == "ok"


# =============================================================
# 검색 고도화 (키워드 경로 — EDIT_SEMANTIC_SEARCH=0)
# =============================================================

class TestSearchUpgrades:
    def _analysis(self, tmp_path, segments):
        p = tmp_path / "analysis.json"
        p.write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
        return str(p)

    def test_adjacent_matches_merged(self, tmp_path):
        from agent.tools.edit import search_video_segments
        analysis_path = self._analysis(tmp_path, [
            {"start_ms": 0, "end_ms": 3000, "description": "가족 식사 장면"},
            {"start_ms": 3000, "end_ms": 6000, "description": "가족 대화 장면"},
            {"start_ms": 20000, "end_ms": 23000, "description": "가족 산책"},
        ])
        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "가족", "analysis_path": analysis_path,
        }))
        assert payload["status"] == "success"
        starts = sorted(m["start_ms"] for m in payload["matches"])
        assert starts == [0, 20000]
        merged = [m for m in payload["matches"] if m["start_ms"] == 0][0]
        assert merged["end_ms"] == 6000
        assert merged["merged_from"] == 2
        assert payload["stats"]["total_above_threshold"] == 3

    def test_no_match_status_with_stats(self, tmp_path):
        from agent.tools.edit import search_video_segments
        analysis_path = self._analysis(tmp_path, [
            {"start_ms": 0, "end_ms": 1000, "description": "도시 야경"},
        ])
        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "강아지", "analysis_path": analysis_path,
        }))
        assert payload["status"] == "no_match"
        assert "stats" in payload and "near_misses" in payload

    def test_empty_segments_no_crash(self, tmp_path):
        """빈 분석 JSON — 임베딩 경로가 빈 행렬로 죽지 않고 no_match."""
        from agent.tools.edit import search_video_segments
        analysis_path = self._analysis(tmp_path, [])
        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "가족", "analysis_path": analysis_path,
        }))
        assert payload["status"] == "no_match"
        assert payload["stats"]["segments_total"] == 0

    def test_zero_duration_segments_dropped_to_no_match(self, tmp_path):
        from agent.tools.edit import search_video_segments
        analysis_path = self._analysis(tmp_path, [
            {"start_ms": 1000, "end_ms": 1000, "description": "가족"},
        ])
        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "가족", "analysis_path": analysis_path,
        }))
        assert payload["status"] == "no_match"

    def test_queries_expansion_hits(self, tmp_path):
        from agent.tools.edit import search_video_segments
        analysis_path = self._analysis(tmp_path, [
            {"start_ms": 0, "end_ms": 1000, "description": "아이와 부모가 걷는다"},
        ])
        payload = json.loads(search_video_segments.invoke({
            "video_path": "v.mp4", "query": "가족",
            "queries": ["아이와 부모"], "analysis_path": analysis_path,
        }))
        assert payload["status"] == "success"
        assert payload["matches"][0]["start_ms"] == 0
