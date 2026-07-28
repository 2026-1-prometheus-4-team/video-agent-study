"""
LangGraph 메인 그래프

흐름 (사진과 일치):

    START
      ↓
    [analysis_node]    ← video_context 가 없고 video_paths 있으면 사전 분석
      ↓
    [script_node]      ← plan JSON 생성 (mode=chat 이면 respond 로 즉답)
      ↓ (questions 있거나 gate 정책 켜져 있으면)
    [interrupt_gate]   ← LangGraph interrupt(): 사용자 승인 / 수정 피드백
      ↓ (OK)
    [supervisor_node]  ← ReAct 루프, spawn_tools 로 sub-agent 격리 호출
      ↓ (ask_user 로 멈추면)
    [clarify]          ← interrupt(): 후보 확인 → supervisor 재진입
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

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt
from langgraph.checkpoint.memory import MemorySaver

try:
    from langgraph.errors import GraphInterrupt
except ImportError:  # 구버전 호환
    class GraphInterrupt(Exception):
        pass

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

def _analyze_one_video(path: str) -> tuple[str, dict]:
    """영상 하나 분석 (캐시 JSON 우선). 반환: (파일명, 분석 데이터 or {'error': ...})."""
    import json as _json
    from pathlib import Path
    from agent import config
    from agent.tools.video_analysis import analyze_video, detect_orientation

    filename = Path(path).name  # analyze_video 는 파일명만 받음 (videos/ 기준)
    try:
        cached_json = config.VIDEOS_DIR / f"{Path(filename).stem}_analysis.json"
        if cached_json.exists():
            logger.info("analysis_node: 기존 분석 JSON 재사용 - %s", cached_json)
            data = _json.loads(cached_json.read_text(encoding="utf-8"))
        else:
            raw = analyze_video.invoke({"video_path": filename})
            data = _json.loads(raw)

        if "error" in data:
            return filename, data

        # 기존 분석 캐시에도 방향 판정을 한 번만 보강한다. confidence가 낮거나
        # 판정에 실패하면 cut_video가 기존 FFmpeg 메타데이터 동작을 유지한다.
        orientation_cache = data.get("orientation")
        if (
            not isinstance(orientation_cache, dict)
            or orientation_cache.get("detector_version") != 2
        ):
            source = config.VIDEOS_DIR / filename
            orientation = detect_orientation(str(source))
            if orientation.get("clockwise_degrees") is not None:
                data["orientation"] = orientation
                try:
                    cached_json.write_text(
                        _json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except OSError:
                    logger.warning(
                        "analysis_node: orientation 캐시 저장 실패 - %s",
                        cached_json,
                        exc_info=True,
                    )

        # 분석 JSON의 transcript는 오래된 요약일 수 있다. planning과 자막이
        # 동일한 원문을 보도록 항상 canonical Whisper 캐시를 먼저 읽는다.
        transcript = None
        try:
            from agent.tools.transcribe import transcribe_video

            source = config.VIDEOS_DIR / filename
            transcript_raw = transcribe_video.invoke({"video_path": str(source)})
            transcript_data = _json.loads(transcript_raw)
            if transcript_data.get("status") == "success":
                transcript = transcript_data.get("segments", [])
        except Exception:
            logger.warning(
                "analysis_node: %s 원본 전사 확보 실패, 분석 transcript fallback",
                filename,
                exc_info=True,
            )

        # 외부 전사 실패 시에도 기존 분석 JSON의 대사 요약은 planning에 전달한다.
        if not isinstance(transcript, list) or not transcript:
            transcript = data.get("transcript")
            if not isinstance(transcript, list) or not transcript:
                transcript = [
                    {
                        "start": float(seg.get("start_ms", 0)) / 1000,
                        "end": float(seg.get("end_ms", 0)) / 1000,
                        "text": str(seg.get("transcript") or "").strip(),
                    }
                    for seg in data.get("segments", [])
                    if str(seg.get("transcript") or "").strip()
                ]

        data["_source_transcript"] = transcript
        return filename, data
    except Exception as e:
        logger.exception("analysis_node: %s 분석 실패", filename)
        return filename, {"error": str(e)}


def analysis_node(state: AgentState) -> dict[str, Any]:
    """video_context 가 없고 video_paths 가 있으면 사전 분석.

    여러 영상이 입력되면 ThreadPoolExecutor 로 병렬 분석하고,
    scenes 에 video 필드를 붙여 어느 영상의 장면인지 구분한다.
    """
    if state.get("video_context"):
        logger.info("analysis_node: video_context 이미 있음 -> skip")
        return {}

    video_paths = state.get("video_paths") or []
    if not video_paths:
        logger.warning("analysis_node: video_paths 비어 있음. analysis skip.")
        return {}

    from concurrent.futures import ThreadPoolExecutor

    multi = len(video_paths) > 1
    if multi:
        logger.info("analysis_node: 영상 %d개 병렬 분석 시작", len(video_paths))
        with ThreadPoolExecutor(max_workers=min(3, len(video_paths))) as pool:
            results = list(pool.map(_analyze_one_video, video_paths))
    else:
        results = [_analyze_one_video(video_paths[0])]

    scenes: list = []
    transcript: list = []
    videos_meta: list[dict] = []
    total_duration = 0.0

    for filename, data in results:
        if "error" in data:
            logger.warning("analysis_node: %s 오류 -> 제외. %s", filename, data["error"])
            continue
        duration = data.get("duration", 0.0)
        total_duration += duration
        videos_meta.append({"file_path": f"videos/{filename}", "duration": duration})
        for seg in data.get("segments", []):
            scene = {
                "start": seg["start_ms"] / 1000,
                "end": seg["end_ms"] / 1000,
                "description": seg.get("description", ""),
                "transcript": seg.get("transcript", ""),
                "objects": seg.get("objects", []),
                "people_count": seg.get("people_count", 0),
                "people": seg.get("people", []),
                "actions": seg.get("actions", []),
                "scene_change": bool(seg.get("scene_change", False)),
                "mood": seg.get("mood", "neutral"),
            }
            if multi:
                scene["video"] = f"videos/{filename}"  # 어느 영상의 장면인지
            scenes.append(scene)

        for item in data.get("_source_transcript", []):
            if not isinstance(item, dict) or not str(item.get("text", "")).strip():
                continue
            transcript_item = {
                "start": float(item.get("start", 0)),
                "end": float(item.get("end", 0)),
                "text": str(item.get("text", "")).strip(),
            }
            if multi:
                transcript_item["video"] = f"videos/{filename}"
            transcript.append(transcript_item)

    if not videos_meta:
        first = video_paths[0]
        ctx: VideoContext = {"file_path": first, "duration": 0.0, "scenes": [], "transcript": []}
        return {"video_context": ctx}

    ctx = {
        "file_path": videos_meta[0]["file_path"],
        "duration": total_duration,
        "scenes": scenes,
        "transcript": transcript,
    }
    if multi:
        ctx["videos"] = videos_meta  # 다중 영상 목록 (script 가 참조)

    logger.info(
        "analysis_node: 영상 %d개, %d scenes 추출 완료 (총 %.1fs)",
        len(videos_meta), len(scenes), total_duration,
    )
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

    feedback = (
        user_response.get("feedback")
        or user_response.get("reply")
        or "사용자가 수정 요청 (구체 없음)"
    )
    return {"script_feedback": feedback}


def route_after_interrupt(state: AgentState) -> str:
    """interrupt 결과로 라우팅."""
    return "script" if state.get("script_feedback") else "supervisor"


# =============================================================
# clarify_gate — 실행 중 사용자 되묻기 (ask_user 툴 산출 소비)
# =============================================================

def clarify_gate(state: AgentState) -> dict[str, Any]:
    """supervisor 가 실행 도중 ask_user 로 멈췄을 때의 사용자 확인 게이트.

    interrupt payload:
      {"type": "clarify", "question": str,
       "candidates": [{start_ms, end_ms, label, score}], "options": [str],
       "context": str, "instructions": str}

    resume value (프론트 카드 버튼 또는 자유 채팅에서 변환):
      {"reply": "두번째꺼", "selected": [1]} / {"approved": true} 등 —
      해석은 supervisor LLM 에 맡기고 여기선 원문 그대로 저장한다.
    """
    q = state.get("pending_question") or {}
    payload = {
        "type": "clarify",
        "question": q.get("question", ""),
        "candidates": q.get("candidates") or [],
        "options": q.get("options") or [],
        "context": q.get("context", ""),
        "instructions": (
            "후보 타임스탬프를 클릭하면 해당 구간을 미리 볼 수 있어요. "
            "번호로 선택하거나 자유롭게 답해주세요. 다른 요청을 보내도 됩니다."
        ),
    }

    answer = interrupt(payload)
    if not isinstance(answer, dict):
        answer = {"reply": str(answer)}

    history = list(state.get("clarify_history") or [])
    history.append({"question": q, "answer": answer})

    return {
        "pending_question": None,
        "clarify_answer": answer,
        "clarify_history": history,
    }


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


_SPAWN_TOOL_NAMES = {"edit", "audio", "text", "effect", "research"}
_STATUS_TOKEN = re.compile(r"status=(ok|error|needs_user)")


def _tool_result_status(content: str) -> str:
    """SubAgentResult.as_tool_result_text 형식에서 status 파싱.

    'error' 단어 단순 검색은 성공 요약에 'error 없이 완료' 같은 문구만 있어도
    오판하므로 명시 토큰 우선, 폴백은 ERROR 접두/라인만 본다.
    """
    m = _STATUS_TOKEN.search(content)
    if m:
        return "error" if m.group(1) == "error" else "ok"
    lowered = content.lower()
    if (
        content.startswith("ERROR")
        or "\nERROR:" in content
        or "status=error" in lowered
        or "status=fail" in lowered
    ):
        return "error"
    return "ok"


def _build_trace_from_messages(
    messages: list, plan: dict, prior_trace: Optional[list[ExecutionStep]] = None
) -> list[ExecutionStep]:
    """supervisor 의 spawn tool 호출 메시지에서 ExecutionStep 들 추출.

    같은 expert 가 여러 step 을 가질 수 있으므로 (expert, 등장 순서) 로 plan
    step 과 매칭한다 — expert 단독 키는 마지막 step 만 남아 스킵/재실행 오판.

    prior_trace 를 넘기면 그 expert 의 *성공* 횟수부터 이어서 센다. clarify /
    critic RETRY 로 supervisor 에 재진입하면 inner agent 는 fresh message 로
    시작하므로, 0 부터 세면 이미 끝난 step 에 새 결과를 덮어써 (완료 step 재실행
    + 미완료 step 을 done 으로 오인) 실행이 어긋난다. 실패한 step 은 재시도
    대상이므로 세지 않는다 — 재시도 결과가 같은 step 에 매핑돼야 한다.
    """
    from langchain_core.messages import ToolMessage

    steps_by_expert: dict[str, list[dict]] = {}
    for s in plan.get("steps", []):
        steps_by_expert.setdefault(s.get("expert", ""), []).append(s)

    seen_count: dict[str, int] = {}
    for t in prior_trace or []:
        if t.get("status") == "ok":
            expert = t.get("expert", "")
            seen_count[expert] = seen_count.get(expert, 0) + 1
    path_pat = re.compile(r"\b[\w./\-]+\.(?:mp4|mov|wav|mp3|aac|srt|vtt|png|jpg|json)\b", re.I)

    out: list[ExecutionStep] = []
    for m in messages:
        if not isinstance(m, ToolMessage):
            continue
        tool_name = getattr(m, "name", "?")
        if tool_name not in _SPAWN_TOOL_NAMES:
            # ask_user / 검색 / memory 툴 결과는 plan step 이 아님
            continue
        expert = f"{tool_name}_expert"
        content = getattr(m, "content", "")
        if isinstance(content, list):
            content = " ".join(
                (p.get("text", "") if isinstance(p, dict) else str(p)) for p in content
            )
        content = str(content)
        paths = path_pat.findall(content)
        idx = seen_count.get(expert, 0)
        seen_count[expert] = idx + 1
        expert_steps = steps_by_expert.get(expert, [])
        plan_step = expert_steps[idx] if idx < len(expert_steps) else {}
        out.append({
            "step_id": plan_step.get("step_id", -1),
            "expert": expert,
            "action": plan_step.get("action", tool_name),
            "status": _tool_result_status(content),
            "summary": content[:200],
            "output_paths": list(dict.fromkeys(paths)),
            "duration_sec": 0.0,
        })
    return out


# =============================================================
# ask_user 툴 — supervisor 실행 중 사용자 되묻기 채널
# =============================================================

def _normalize_candidates(candidates: Optional[list]) -> list[dict]:
    """LLM 이 넘긴 후보 리스트를 {start_ms, end_ms, label, score} 로 정규화."""
    normalized: list[dict] = []
    for c in candidates or []:
        if not isinstance(c, dict):
            continue
        try:
            start_ms = int(float(c.get("start_ms", c.get("start", 0)) or 0))
            end_ms = int(float(c.get("end_ms", c.get("end", 0)) or 0))
        except (TypeError, ValueError):
            continue
        # start/end 가 초 단위로 온 것 같으면 (둘 다 작으면) ms 로 승격
        if "start_ms" not in c and "end_ms" not in c and end_ms <= 36000:
            start_ms, end_ms = start_ms * 1000, end_ms * 1000
        label = str(
            c.get("label") or c.get("description") or c.get("text") or ""
        )[:160]
        entry: dict = {"start_ms": start_ms, "end_ms": end_ms, "label": label}
        if c.get("score") is not None:
            try:
                entry["score"] = round(float(c["score"]), 3)
            except (TypeError, ValueError):
                pass
        normalized.append(entry)
    return normalized[:10]


def _make_ask_user_tool(holder: dict):
    """supervisor 전용 ask_user 툴 팩토리.

    inner ReAct agent 는 checkpointer 가 없어 interrupt() 를 직접 못 부른다.
    대신 질문을 holder 에 기록하고, supervisor 에게 즉시 실행을 끝내라고
    지시한다. supervisor_node 가 holder 를 보고 clarify 게이트로 라우팅한다.
    """
    from langchain_core.tools import tool

    @tool
    def ask_user(
        question: str,
        candidates: Optional[list[dict]] = None,
        options: Optional[list[str]] = None,
        context: str = "",
    ) -> str:
        """실행을 멈추고 사용자에게 확인을 요청한다. 확신이 없을 때 추측 대신 사용.

        사용 시점: (1) 장면 검색 신뢰도가 낮거나 후보가 여럿일 때 (2) 원본을 크게
        삭제하는 파괴적 편집 전 (3) 취향 결정 (색/폰트/보이스) (4) 예상 밖 결과.

        Args:
            question: 사용자에게 보여줄 질문 한 문장 (한국어).
            candidates: 확인 대상 구간 목록 [{start_ms, end_ms, label, score}].
                search_video_segments 의 matches 를 그대로 넘겨도 된다.
            options: 선택지 텍스트 목록 (구간이 아닌 선택일 때).
            context: 왜 묻는지 한 줄 (예: "'가족' 검색 상위 스코어 0.42 로 낮음").

        Returns:
            안내 문자열. 이 툴을 부른 뒤에는 다른 툴을 부르지 말고
            'AWAITING_USER' 한 단어로 최종 응답을 끝내야 한다.
        """
        try:
            normalized_options = [str(o)[:120] for o in (options or [])][:8]
            combined = f"{question or ''} {context or ''}".lower()
            if any(token in combined for token in ("bgm", "배경음악")) and any(
                token in combined for token in ("없", "찾", "missing", "not found")
            ):
                required = [
                    "AI로 새 BGM 생성 (추천)",
                    "다른 파일 지정",
                    "배경음악 없이 진행",
                ]
                normalized_options = required + [
                    option for option in normalized_options if option not in required
                ]
                normalized_options = normalized_options[:8]

            holder["question"] = {
                "question": str(question or "").strip(),
                "candidates": _normalize_candidates(candidates),
                "options": normalized_options,
                "context": str(context or "")[:300],
            }
            return (
                "질문이 사용자에게 전달 대기 중이다. 지금 즉시 다른 tool 호출 없이 "
                "'AWAITING_USER' 한 단어로 최종 응답을 종료하라."
            )
        except Exception as e:
            return f"ERROR: ask_user 실패 - {e}"

    return ask_user


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

    # 실행 중 되묻기 채널 + 직접 장면 검색 (후보 데이터를 구조 그대로 확보).
    # 검색은 sub-agent 평탄화를 거치면 타임스탬프가 파괴되므로 supervisor 가
    # 직접 부른 뒤 ask_user 후보로 넘긴다.
    question_holder: dict = {}
    from agent.tools.edit import search_video_segments
    spawn_tools = spawn_tools + [_make_ask_user_tool(question_holder), search_video_segments]

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
    clarify_answer = state.get("clarify_answer")
    clarify_history = list(state.get("clarify_history") or [])

    if not pending_steps and not clarify_answer:
        logger.info("supervisor: 모든 step 완료. critic 으로.")
        return {}

    next_brief = json.dumps(pending_steps, ensure_ascii=False, indent=2)
    user_parts = [
        "# 아직 실행 안 된 step 들\n",
        f"```json\n{next_brief}\n```\n",
        "각 step 의 expert 를 *spawn tool* 로 부르고, 의존 관계에 따라 순서대로/병렬로 실행하라.",
        "한 step 끝나면 결과 (특히 산출 파일 경로) 를 다음 step task 에 명시적으로 박아라.",
        "spawn 결과가 status=error/fail 이거나 실제 output 경로가 없으면 그 산출물에 "
        "의존하는 다음 step 을 절대 실행하지 마라. 같은 step 을 올바른 인자로 재시도하고, "
        "복구할 수 없으면 ask_user 로 원인과 선택지를 알려라.",
        "장면 선택이 모호하면 search_video_segments 로 직접 후보를 뽑고, 확신이 없으면"
        " ask_user 로 사용자 확인을 받아라 (추측으로 자르지 말 것).",
        "BGM 파일 누락 질문에서 사용자가 AI 생성을 선택했다면 audio_expert에게 "
        "generate_bgm 실행 후 그 output을 add_bgm에 연결하도록 지시하라.",
        "모든 step 산출물이 나오면 마지막 영상 경로를 'FINAL_OUTPUT: <path>' 형식으로 보고하라.",
    ]

    if clarify_history:
        qa_lines = ["\n# 이번 턴 사용자 Q&A (이미 진행된 확인)"]
        for i, qa in enumerate(clarify_history, 1):
            q = (qa.get("question") or {})
            a = qa.get("answer") or {}
            qa_lines.append(f"{i}. Q: {q.get('question', '')}")
            cands = q.get("candidates") or []
            if cands:
                for ci, c in enumerate(cands):
                    qa_lines.append(
                        f"   후보[{ci}]: {c.get('start_ms')}ms~{c.get('end_ms')}ms {c.get('label','')}"
                    )
            qa_lines.append(f"   A: {json.dumps(a, ensure_ascii=False)}")
        user_parts.append("\n".join(qa_lines))

    if clarify_answer:
        user_parts.append(
            "\n# 방금 도착한 사용자 답변\n"
            f"{json.dumps(clarify_answer, ensure_ascii=False)}\n"
            "이 답변을 반영해 즉시 실행을 이어가라. selected 는 직전 질문의 후보 인덱스다. "
            "답변이 승인/선택이 아니라 *다른 요청*이면 그 요청을 우선 반영하라."
        )

    user_text = "\n".join(user_parts)

    try:
        result_state = react_agent.invoke(
            {"messages": [HumanMessage(content=user_text)]},
            config={"recursion_limit": 40},
        )
    except GraphInterrupt:
        # 방어적 재전파 — interrupt 를 generic except 가 삼켜 critic verdict 로
        # 둔갑시키면 그래프 일시정지가 영영 불가능해진다.
        raise
    except Exception as e:
        logger.exception("supervisor invoke failed")
        # 429 · quota · rate limit 계열은 재시도해도 같은 결과 → 즉시 PASS 로
        # 종료해서 무한 RETRY 방지 + 사용자에게 원인 명시.
        err_text = f"{type(e).__name__}: {e}"
        lowered_error = err_text.lower()
        is_quota = any(
            k in err_text.lower()
            for k in ("resource_exhausted", "429", "quota", "credits are depleted")
        )
        is_connection_error = any(
            key in lowered_error
            for key in (
                "remoteprotocolerror",
                "server disconnected",
                "readtimeout",
                "connecttimeout",
                "connectionerror",
                "connection reset",
            )
        )
        user_msg = (
            "Gemini API 쿼터/크레딧 소진으로 실행을 중단했어. "
            ".env 의 GOOGLE_API_KEY_SUPERVISOR (또는 GOOGLE_API_KEY) 를 크레딧이 남은 "
            "키로 교체하거나 결제를 충전한 뒤 다시 요청해줘."
            if is_quota
            else (
                "Gemini 연결이 응답 없이 종료되어 실행을 멈췄어. 승인된 계획은 유지되어 "
                "있으니 잠시 후 같은 계획으로 다시 실행해줘."
                if is_connection_error
                else f"실행 중 오류가 발생했어: {err_text[:200]} — 다시 시도해줘."
            )
        )
        # critic 이 verdict 를 덮어써도 사용자에겐 메시지가 relay 되도록
        # messages 에도 명시적으로 남긴다 (조사에서 확인된 quota 침묵 문제 대응).
        return {
            "messages": [AIMessage(content=user_msg, name="supervisor")],
            "critic_verdict": {
                "verdict": "PASS" if is_quota else "RETRY",
                "issues": [f"supervisor 오류: {err_text}"],
                "message_to_user": user_msg,
                # quota 소진은 재시도해도 같은 결과 — critic 을 아예 건너뛰고
                # 종료한다. critic 을 태우면 verdict 가 덮여 3회 재시도 후에도
                # 이 메시지가 사용자에게 안 가고 침묵으로 끝난다.
                # 연결 장애는 critic RETRY로 전체 Supervisor를 다시 돌리지 않는다.
                # LLM 내부에서 이미 짧게 재시도했으므로 여기서 종료해야 busy가 풀린다.
                "terminal": is_quota or is_connection_error,
            },
        }

    new_messages = result_state.get("messages", [])
    last_text = ""
    if new_messages:
        last = new_messages[-1]
        c = getattr(last, "content", "")
        if isinstance(c, list):
            c = " ".join((p.get("text", "") if isinstance(p, dict) else str(p)) for p in c)
        last_text = str(c)

    new_trace = trace + _build_trace_from_messages(new_messages, plan, prior_trace=trace)

    # ── ask_user 로 멈춘 경우: 부분 진행 상태를 커밋하고 clarify 게이트로 ──
    # 완료된 step 은 trace 에 남아 재진입 시 스킵되므로 재실행 없이 이어진다.
    if question_holder.get("question"):
        logger.info(
            "supervisor paused for user question: %s",
            question_holder["question"].get("question", "")[:80],
        )
        return {
            "execution_trace": new_trace,
            "messages": new_messages,
            "pending_question": question_holder["question"],
            "clarify_answer": None,
            "clarify_history": clarify_history,
        }
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
        # 소비된 clarify 답변 정리 (히스토리는 이번 턴 내 유지)
        "clarify_answer": None,
        "pending_question": None,
    }


# =============================================================
# respond_node — 편집이 필요 없는 대화 턴 (질문/확인/설명)
# =============================================================

def respond_node(state: AgentState) -> dict[str, Any]:
    """script_node 가 mode="chat" plan 을 낸 경우: plan.reply 를 그대로
    대화 응답으로 흘리고 파이프라인(게이트/실행/검증)을 건너뛴다.

    '방금 어디 잘랐어?', '몇 초짜리야?' 같은 턴이 플랜 승인 카드를 띄우지
    않게 하는 경량 경로.
    """
    plan = state.get("script_plan") or {}
    reply = str(plan.get("reply") or "").strip()
    if not reply:
        reply = "요청을 이해했어요. 편집이 필요하면 구체적으로 말씀해 주세요."
    return {"messages": [AIMessage(content=reply, name="supervisor")]}


def route_after_supervisor(state: AgentState) -> str:
    """supervisor 뒤 라우팅.

    - pending_question 있으면 clarify (사용자 확인)
    - terminal verdict (예: quota 소진) 면 critic 건너뛰고 종료
    - 그 외 critic
    """
    if state.get("pending_question"):
        return "clarify"
    verdict = state.get("critic_verdict") or {}
    if verdict.get("terminal"):
        return "end"
    return "critic"


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
    g.add_node("clarify", clarify_gate)
    g.add_node("supervisor", supervisor_node)
    g.add_node("respond", respond_node)
    g.add_node("critic", critic_node)
    g.add_node("summary", summary_node)

    g.add_edge(START, "analysis")
    g.add_edge("analysis", "script")

    g.add_conditional_edges(
        "script",
        should_interrupt_for_questions,
        {
            "interrupt": "interrupt_gate",
            "supervisor": "supervisor",
            "respond": "respond",
        },
    )

    g.add_conditional_edges(
        "interrupt_gate",
        route_after_interrupt,
        {"script": "script", "supervisor": "supervisor"},
    )

    # supervisor 뒤: 사용자 질문(ask_user)으로 멈췄으면 clarify 게이트 →
    # 답변 받고 supervisor 재진입 (완료 step 은 trace 로 스킵). 아니면 critic.
    g.add_conditional_edges(
        "supervisor",
        route_after_supervisor,
        {"clarify": "clarify", "critic": "critic", "end": "summary"},
    )
    g.add_edge("clarify", "supervisor")

    # 대화 전용 턴은 검증 없이 요약으로.
    g.add_edge("respond", "summary")

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
