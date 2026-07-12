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

    if state.get("video_paths"):
        user_parts.append("\n# 원본 영상")
        for p in state["video_paths"]:
            user_parts.append(f"- {p}")

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

    - plan.questions 가 비어있고 사용자 승인 정책이 꺼져있으면 supervisor 로 바로
    - 그 외엔 interrupt 게이트로 (사용자 승인 / 수정 요청)

    Returns:
        "interrupt" | "supervisor"
    """
    plan = state.get("script_plan") or {}
    has_questions = bool(plan.get("questions"))
    gate_enabled = config.INTERRUPT_POLICY.gate_after_script

    if gate_enabled or has_questions:
        return "interrupt"
    return "supervisor"
