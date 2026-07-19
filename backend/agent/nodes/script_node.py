"""
Script 생성 노드

사용자 자연어 요청 + 사전 영상 분석을 받아서
6 단계 (또는 그 이상) 의 plan JSON 을 생성한다.

사진의 "Script 생성 노드" 가 이 모듈에 해당.

흐름:
1. system prompt: SOUL + AGENTS + TOOLS + tts_voices + analysis 결합 (stable, 캐시)
2. user prompt:  사용자 요청 원문 + (있으면) 이전 plan + 피드백
3. LLM 호출, JSON 추출
4. state 에 script_plan 저장
5. plan.questions 가 비어있지 않으면 interrupt 게이트가 사용자에게 물어봄
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from agent import config
from agent.llm import make_llm
from agent.prompt_builder import build_script_node_system_prompt
from agent.state import AgentState

logger = logging.getLogger(__name__)


# =============================================================
# JSON 추출
# =============================================================

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_json(text: str) -> dict[str, Any]:
    """LLM 응답에서 JSON 블록 추출.

    1) ```json ... ``` 코드블록
    2) 그 외엔 첫 `{` 부터 마지막 `}` 까지
    """
    m = _JSON_BLOCK.search(text)
    payload = m.group(1) if m else text

    if not m:
        # bracket span fallback
        start = payload.find("{")
        end = payload.rfind("}")
        if start != -1 and end != -1:
            payload = payload[start : end + 1]

    try:
        return json.loads(payload)
    except json.JSONDecodeError as e:
        logger.error("script JSON parse failed: %s\n%s", e, payload[:500])
        return {
            "_parse_error": str(e),
            "_raw": payload[:2000],
            "questions": [
                "script 생성 중 JSON 파싱 오류. 사용자 요청을 다시 한 번 명확히 말씀해 주세요."
            ],
        }


# =============================================================
# 노드 본체
# =============================================================

def script_node(state: AgentState) -> dict[str, Any]:
    """script_plan 을 생성해서 state 에 박는다.

    재진입 시 (사용자 피드백 후): state["script_feedback"] 가 있으면
    이전 plan + 피드백을 user prompt 에 포함시켜 재생성.
    """
    started = time.monotonic()
    user_request = state.get("user_request", "")
    video_context = state.get("video_context")
    previous_plan = state.get("script_plan")
    feedback = state.get("script_feedback")
    revision = state.get("script_revision", 0)

    # 무한 재생성 방지
    if revision >= 5:
        logger.warning("script_revision >= 5, force end")
        return {
            "script_plan": {
                **(previous_plan or {}),
                "questions": ["plan 재생성이 5 회를 넘었습니다. 요청을 더 간단히 다시 주세요."],
            },
            "script_revision": revision,
        }

    # system prompt (캐시 친화)
    sys_text = build_script_node_system_prompt(video_context=video_context)

    # user prompt
    user_parts: list[str] = [
        "# 사용자 요청",
        user_request,
    ]

    # 트렌드 사전조사 결과 (research_prepass 산출). 있으면 컨셉/BGM/페이싱을
    # 여기에 grounding — trend_elements / references 는 이걸로 채운다.
    trend_brief = state.get("trend_brief")
    if trend_brief:
        user_parts.append("\n# 트렌드 사전조사 (이걸 기획에 반영)")
        user_parts.append("```json")
        user_parts.append(json.dumps(trend_brief, ensure_ascii=False, indent=2))
        user_parts.append("```")
        user_parts.append(
            "위 트렌드를 concept/trend_elements/bgm_progression/pacing 에 반영하고, "
            "references 는 여기 자료로 채워라."
        )

    if state.get("video_paths"):
        user_parts.append("\n# 원본 영상")
        for p in state["video_paths"]:
            user_parts.append(f"- {p}")

    # 이전 turn 에서 만든 편집본이 있으면 새 요청은 그것을 소스로 삼는다.
    # (원본은 유지 · 편집본을 계속 파생시키는 흐름 — 사용자가 "그럼 자막도"
    #  같은 후속 요청을 하면 자동으로 편집본 위에서 이어짐)
    last_output = state.get("final_output_path")
    if last_output:
        user_parts.append("\n# 직전 편집 결과 (이번 요청의 실질 소스)")
        user_parts.append(f"- {last_output}")
        user_parts.append(
            "\n중요: 이번 요청은 위 편집본 위에서 이어서 편집한다. "
            "step 의 video_path 는 원본이 아니라 이 편집본 경로를 사용하라. "
            "다만 편집본 자체는 덮어쓰지 말고 새 파일로 저장 (예: `..._captioned.mp4`)."
        )
        # 이전 turn 의 편집 요약도 알려줌 (사용자가 후속 요청을 이해하기 쉽게).
        conv_summary = state.get("conversation_summary")
        if conv_summary:
            user_parts.append("\n# 이전 대화 요약")
            user_parts.append(conv_summary)

    if previous_plan and feedback:
        user_parts.append("\n# 이전 plan (사용자가 수정 요청)")
        user_parts.append("```json")
        user_parts.append(json.dumps(previous_plan, ensure_ascii=False, indent=2))
        user_parts.append("```")
        user_parts.append("\n# 사용자 피드백")
        user_parts.append(feedback)
        user_parts.append("\n이 피드백을 반영해서 *전체 plan 을 갱신* 해서 다시 출력하라.")

    user_text = "\n".join(user_parts)

    # LLM 호출
    llm = make_llm("script")
    try:
        ai_msg = llm.invoke(
            [
                SystemMessage(content=sys_text),
                HumanMessage(content=user_text),
            ]
        )
    except Exception as e:
        logger.exception("script LLM invoke failed")
        return {
            "script_plan": {
                "questions": [f"script 생성 중 LLM 오류: {type(e).__name__}: {e}"]
            },
            "script_revision": revision + 1,
        }

    raw = ai_msg.content
    if isinstance(raw, list):
        raw = " ".join(
            (p.get("text", "") if isinstance(p, dict) else str(p))
            for p in raw
        )

    plan = _extract_json(str(raw))

    # 기본 필드 보강 (LLM 이 누락한 경우)
    plan.setdefault("steps", [])
    plan.setdefault("questions", [])
    plan.setdefault("target_format", "general")
    plan.setdefault("mode", "edit")
    # chat 모드인데 reply 가 없으면 edit 모드로 강등 (오분류 방어)
    if plan.get("mode") == "chat" and not str(plan.get("reply") or "").strip():
        plan["mode"] = "edit"

    # step_id 백필 — supervisor 의 완료 판정(_step_completed)이 step_id 기준이라
    # LLM 이 빠뜨리면 그 step 은 영영 "미완료"로 남아 매 재진입마다 재실행된다.
    steps = plan.get("steps")
    if isinstance(steps, list):
        for i, step in enumerate(steps, 1):
            if isinstance(step, dict) and not isinstance(step.get("step_id"), int):
                step["step_id"] = i

    duration = time.monotonic() - started
    logger.info(
        "script_node done: format=%s, steps=%d, questions=%d, %.2fs",
        plan.get("target_format"), len(plan.get("steps", [])),
        len(plan.get("questions", [])), duration,
    )

    return {
        "script_plan": plan,
        "script_revision": revision + 1,
        # feedback 은 한 번 쓰고 비움
        "script_feedback": None,
    }


# =============================================================
# 라우팅: interrupt 게이트로 갈지, supervisor 바로 갈지
# =============================================================

def should_interrupt_for_questions(state: AgentState) -> str:
    """script_node 이후 라우팅.

    - plan.mode == "chat" 이면 respond (편집 파이프라인 전체 스킵 — 대화 응답)
    - plan.questions 가 비어있고 사용자 승인 정책이 꺼져있으면 supervisor 로 바로
    - 그 외엔 interrupt 게이트로 (사용자 승인 / 수정 요청)

    Returns:
        "interrupt" | "supervisor" | "respond"
    """
    plan = state.get("script_plan") or {}

    if plan.get("mode") == "chat":
        return "respond"

    has_questions = bool(plan.get("questions"))
    gate_enabled = config.INTERRUPT_POLICY.gate_after_script

    if gate_enabled or has_questions:
        return "interrupt"
    return "supervisor"
