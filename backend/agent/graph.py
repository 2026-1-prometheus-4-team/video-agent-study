"""
LangGraph 메인 그래프

흐름 (사진과 일치):

    START
      ↓
    [analysis_node]    ← video_context 가 없고 video_paths 있으면 사전 분석
      ↓
    [script_node]      ← 6 단계 plan JSON 생성
      ↓ (questions 있거나 gate 정책 켜져 있으면)
    [interrupt_gate]   ← LangGraph interrupt(): 사용자 승인 / 수정 피드백
      ↓ (OK)
    [supervisor_node]  ← ReAct 루프, spawn_tools 로 sub-agent 격리 호출
      ↓
    [critic_node]      ← PASS / RETRY
      ↓
    END (PASS) | supervisor (RETRY)

설계 결정 (이전 토의 결과 반영):
- 결정 1: sub-agent 완전 격리 (OpenClaw ACP 패턴) — handoff X, tool-style spawn 만
- 결정 2: 캐싱은 Gemini implicit 우선 — cache_boundary 마커로 stable prefix 유도
- 결정 3: Script + interrupt 를 별도 노드로 (사진 그대로)
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any, Optional

from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt
from langgraph.checkpoint.memory import MemorySaver

from agent.llm import make_llm
from agent.nodes import (
    script_node,
    critic_node,
    should_interrupt_for_questions,
    route_after_critic,
    summary_node,
    should_summarize,
)
from agent.prompt_builder import build_supervisor_system_prompt
from agent.state import AgentState, ExecutionStep, VideoContext
from agent.sub_agent import make_spawn_tools
from agent.tools.memory import MEMORY_TOOLS

logger = logging.getLogger(__name__)


# =============================================================
# analysis_node — 사전 영상 분석
# =============================================================

def analysis_node(state: AgentState) -> dict[str, Any]:
    """video_context 가 없고 video_paths 가 있으면 사전 분석."""
    if state.get("video_context"):
        logger.info("analysis_node: video_context 이미 있음 -> skip")
        return {}

    video_paths = state.get("video_paths") or []
    if not video_paths:
        logger.warning("analysis_node: video_paths 비어 있음. analysis skip.")
        return {}

    import json as _json
    from pathlib import Path
    from agent import config
    from agent.tools.video_analysis import analyze_video

    first = video_paths[0]
    filename = Path(first).name  # analyze_video 는 파일명만 받음 (videos/ 기준)

    try:
        # 기존 분석 JSON 이 있으면 재사용 (재분석 비용 + API 쿼터 절약)
        cached_json = config.VIDEOS_DIR / f"{Path(filename).stem}_analysis.json"
        if cached_json.exists():
            logger.info("analysis_node: 기존 분석 JSON 재사용 - %s", cached_json)
            data = _json.loads(cached_json.read_text(encoding="utf-8"))
        else:
            raw = analyze_video.invoke({"video_path": filename})
            data = _json.loads(raw)

        if "error" in data:
            logger.warning("analysis_node: analyze_video 오류 -> skeleton. %s", data["error"])
            ctx: VideoContext = {"file_path": first, "duration": 0.0, "scenes": [], "transcript": []}
        else:
            scenes = [
                {
                    "start": seg["start_ms"] / 1000,
                    "end": seg["end_ms"] / 1000,
                    "description": seg.get("description", ""),
                }
                for seg in data.get("segments", [])
            ]
            ctx = {
                "file_path": first,
                "duration": data.get("duration", 0.0),
                "scenes": scenes,
                "transcript": [],  # transcript 는 audio_expert 가 채움
            }
            logger.info("analysis_node: %d scenes 추출 완료 (%.1fs)", len(scenes), ctx["duration"])

    except Exception as e:
        logger.exception("analysis_node: analyze_video 실패 -> skeleton")
        ctx = {"file_path": first, "duration": 0.0, "scenes": [], "transcript": []}

    return {"video_context": ctx}


# =============================================================
# interrupt_gate — 사용자 승인 / 수정
# =============================================================

def interrupt_gate(state: AgentState) -> dict[str, Any]:
    """사용자 승인 게이트.

    LangGraph 의 `interrupt()` 를 부르면 graph 가 멈추고
    클라이언트는 `Command(resume=<value>)` 로 재개한다.

    resume value 예:
    - {"approved": True}                              -> supervisor 로
    - {"approved": False, "feedback": "음~ 추가"}      -> script 재생성
    """
    plan = state.get("script_plan") or {}
    questions = plan.get("questions") or []

    payload = {
        "type": "script_approval",
        "plan": plan,
        "questions": questions,
        "instructions": "이 plan 대로 진행할까요? 수정사항이 있으면 feedback 에 자연어로 적어주세요.",
    }

    user_response = interrupt(payload)
    if not isinstance(user_response, dict):
        user_response = {"approved": True}

    if user_response.get("approved"):
        return {"script_feedback": None}

    return {"script_feedback": user_response.get("feedback") or "사용자가 수정 요청 (구체 없음)"}


def route_after_interrupt(state: AgentState) -> str:
    """interrupt 결과로 라우팅."""
    return "script" if state.get("script_feedback") else "supervisor"


# =============================================================
# supervisor_node — ReAct 루프, sub-agent spawn
# =============================================================

def _format_execution_trace(trace: list[ExecutionStep]) -> str:
    if not trace:
        return "(아직 실행된 step 없음)"
    lines = []
    for s in trace:
        lines.append(
            f"- step {s.get('step_id','?')}: {s.get('expert','?')}.{s.get('action','?')} "
            f"-> {s.get('status','?')}"
        )
    return "\n".join(lines)


def _step_completed(step: dict, trace: list[ExecutionStep]) -> bool:
    sid = step.get("step_id")
    return any(t.get("step_id") == sid and t.get("status") == "ok" for t in trace)


_FINAL_LITERAL = re.compile(r"FINAL_OUTPUT:\s*(\S+)")
_FINAL_MP4 = re.compile(r"[\w./\-]+\.(?:mp4|mov)\b", re.I)
_CLIP_HINT = re.compile(r"clip|cut|part|segment|chunk", re.I)


def _extract_final_output(text: str) -> Optional[str]:
    """supervisor 의 마지막 응답에서 최종 산출 경로 추출.

    1) `FINAL_OUTPUT: <path>` 리터럴 (프롬프트에서 강제한 형식) — 최우선
    2) 없으면 텍스트의 마지막 .mp4/.mov 경로 — LLM 이 한국어로 paraphrase 한
       경우 (예: "최종본은 outputs/xxx.mp4 입니다") 대비. 단 파일명이 clip/cut
       같은 중간 산출물 힌트를 포함하면 skip.
    """
    m = _FINAL_LITERAL.search(text)
    if m:
        return m.group(1)

    paths = _FINAL_MP4.findall(text)
    for p in reversed(paths):
        if not _CLIP_HINT.search(p):
            return p
    return None


def _build_trace_from_messages(messages: list, plan: dict) -> list[ExecutionStep]:
    """supervisor 의 spawn tool 호출 메시지에서 ExecutionStep 들 추출."""
    from langchain_core.messages import ToolMessage

    steps_by_expert = {s.get("expert"): s for s in plan.get("steps", [])}
    path_pat = re.compile(r"\b[\w./\-]+\.(?:mp4|mov|wav|mp3|aac|srt|vtt|png|jpg|json)\b", re.I)

    out: list[ExecutionStep] = []
    for m in messages:
        if not isinstance(m, ToolMessage):
            continue
        tool_name = getattr(m, "name", "?")
        expert = f"{tool_name}_expert"
        content = getattr(m, "content", "")
        if isinstance(content, list):
            content = " ".join(
                (p.get("text", "") if isinstance(p, dict) else str(p)) for p in content
            )
        paths = path_pat.findall(str(content))
        plan_step = steps_by_expert.get(expert, {})
        out.append({
            "step_id": plan_step.get("step_id", -1),
            "expert": expert,
            "action": plan_step.get("action", tool_name),
            "status": "ok" if "error" not in str(content).lower() else "error",
            "summary": str(content)[:200],
            "output_paths": list(dict.fromkeys(paths)),
            "duration_sec": 0.0,
        })
    return out


def supervisor_node(state: AgentState) -> dict[str, Any]:
    """ReAct 루프 안에서 sub-agent 들을 tool 처럼 부른다.

    `langchain.agents.create_agent` 의 내장 ReAct loop 사용.
    한 번 invoke 하면 모든 step 이 끝날 때까지 자체적으로 돈다.
    """
    started = time.monotonic()
    plan = state.get("script_plan") or {}
    video_context = state.get("video_context")
    trace = list(state.get("execution_trace", []))

    spawn_tools = make_spawn_tools(
        video_context=video_context,
        parent_depth=state.get("spawn_depth", 0),
        parent_session_id=state.get("session_id"),
    )
    # 사용자 장기 기억 툴 추가. supervisor 가 대화에서 발견한 선호를 저장/삭제.
    spawn_tools = list(spawn_tools) + list(MEMORY_TOOLS)

    sys_text = build_supervisor_system_prompt(
        video_context=video_context,
        session_memory=_format_execution_trace(trace),
        script_plan=plan,
        conversation_summary=state.get("conversation_summary"),
        user_memories=state.get("user_memories") or [],
    )

    from langgraph.prebuilt import create_react_agent
    supervisor_llm = make_llm("supervisor")
    react_agent = create_react_agent(
        model=supervisor_llm,
        tools=spawn_tools,
        prompt=sys_text,
    )

    pending_steps = [s for s in plan.get("steps", []) if not _step_completed(s, trace)]
    if not pending_steps:
        logger.info("supervisor: 모든 step 완료. critic 으로.")
        return {}

    next_brief = json.dumps(pending_steps, ensure_ascii=False, indent=2)
    user_text = (
        "# 아직 실행 안 된 step 들\n\n"
        f"```json\n{next_brief}\n```\n\n"
        "각 step 의 expert 를 *spawn tool* 로 부르고, 의존 관계에 따라 순서대로/병렬로 실행하라.\n"
        "한 step 끝나면 결과 (특히 산출 파일 경로) 를 다음 step task 에 명시적으로 박아라.\n"
        "모든 step 산출물이 나오면 마지막 영상 경로를 'FINAL_OUTPUT: <path>' 형식으로 보고하라."
    )

    try:
        result_state = react_agent.invoke(
            {"messages": [HumanMessage(content=user_text)]},
            config={"recursion_limit": 40},
        )
    except Exception as e:
        logger.exception("supervisor invoke failed")
        # 429 · quota · rate limit 계열은 재시도해도 같은 결과 → 즉시 PASS 로
        # 종료해서 무한 RETRY 방지 + 사용자에게 원인 명시.
        err_text = f"{type(e).__name__}: {e}"
        is_quota = any(k in err_text.lower() for k in ("resource_exhausted", "429", "quota"))
        return {
            "critic_verdict": {
                "verdict": "PASS" if is_quota else "RETRY",
                "issues": [f"supervisor 오류: {err_text}"],
                "message_to_user": (
                    "Gemini API 쿼터 소진 (무료 티어 하루 20 요청). "
                    ".env 에 GOOGLE_API_KEY_SUPERVISOR / _SCRIPT / _CRITIC / _SUB_AGENT / "
                    "_SUMMARY 로 팀원 키를 분산하거나 유료 티어로 전환해줘."
                    if is_quota
                    else "Supervisor 실행 중 오류. 다시 시도 필요."
                ),
            }
        }

    new_messages = result_state.get("messages", [])
    last_text = ""
    if new_messages:
        last = new_messages[-1]
        c = getattr(last, "content", "")
        if isinstance(c, list):
            c = " ".join((p.get("text", "") if isinstance(p, dict) else str(p)) for p in c)
        last_text = str(c)

    new_trace = trace + _build_trace_from_messages(new_messages, plan)
    # final path 우선순위: (1) supervisor 텍스트의 FINAL_OUTPUT / .mp4
    # (2) 기존 state.final_output_path (3) execution trace 마지막 산출 경로.
    # 마지막 fallback 은 supervisor 가 최종 리포트 형식을 어길 때도 결과물이
    # 사라지지 않게 하는 안전망.
    final_output = _extract_final_output(last_text) or state.get("final_output_path")
    if not final_output:
        for step in reversed(new_trace):
            paths = step.get("output_paths") or []
            for p in reversed(paths):
                if p.lower().endswith((".mp4", ".mov")) and not _CLIP_HINT.search(p):
                    final_output = p
                    break
            if final_output:
                break

    duration = time.monotonic() - started
    logger.info(
        "supervisor done in %.2fs (trace=%d, final=%s)",
        duration, len(new_trace), final_output,
    )

    return {
        "execution_trace": new_trace,
        "final_output_path": final_output,
        "messages": new_messages,
    }


# =============================================================
# Graph 빌드
# =============================================================

def build_graph(checkpointer=None):
    """전체 그래프 빌드.

    Args:
        checkpointer: LangGraph checkpointer. interrupt 사용하려면 *반드시* 필요.
                      None 이면 MemorySaver 자동 부착.
    """
    if checkpointer is None:
        checkpointer = MemorySaver()

    g = StateGraph(AgentState)

    g.add_node("analysis", analysis_node)
    g.add_node("script", script_node)
    g.add_node("interrupt_gate", interrupt_gate)
    g.add_node("supervisor", supervisor_node)
    g.add_node("critic", critic_node)
    g.add_node("summary", summary_node)

    g.add_edge(START, "analysis")
    g.add_edge("analysis", "script")

    g.add_conditional_edges(
        "script",
        should_interrupt_for_questions,
        {"interrupt": "interrupt_gate", "supervisor": "supervisor"},
    )

    g.add_conditional_edges(
        "interrupt_gate",
        route_after_interrupt,
        {"script": "script", "supervisor": "supervisor"},
    )

    g.add_edge("supervisor", "critic")

    # critic 뒤: RETRY → supervisor 재실행, 그 외엔 summary (조건부) 후 종료.
    g.add_conditional_edges(
        "critic",
        route_after_critic,
        {"end": "summary", "supervisor": "supervisor"},
    )

    # summary_node 는 조건 안 맞으면 no-op (dict {} 리턴) — 부담 없음.
    g.add_edge("summary", END)

    return g.compile(checkpointer=checkpointer)


# =============================================================
# 실행 헬퍼
# =============================================================

def run_agent(
    user_request: str,
    video_paths: Optional[list[str]] = None,
    video_context: Optional[VideoContext] = None,
    thread_id: str = "default",
):
    """단발성 실행 (interrupt 안 만나는 시나리오 위주, 테스트용)."""
    app = build_graph()
    initial: AgentState = {
        "user_request": user_request,
        "video_paths": video_paths or [],
        "video_context": video_context,
        "execution_trace": [],
        "script_revision": 0,
        "spawn_depth": 0,
        "session_id": thread_id,
    }
    return app.invoke(initial, config={"configurable": {"thread_id": thread_id}})


def run_agent_stream(
    user_request: str,
    video_paths: Optional[list[str]] = None,
    video_context: Optional[VideoContext] = None,
    thread_id: str = "default",
):
    """스트리밍 실행. 각 노드 산출물을 차례로 yield."""
    app = build_graph()
    initial: AgentState = {
        "user_request": user_request,
        "video_paths": video_paths or [],
        "video_context": video_context,
        "execution_trace": [],
        "script_revision": 0,
        "spawn_depth": 0,
        "session_id": thread_id,
    }
    for chunk in app.stream(
        initial,
        config={"configurable": {"thread_id": thread_id}},
        stream_mode="updates",
    ):
        yield chunk
