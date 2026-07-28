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
        # Gemini occasionally leaves a trailing comma before a closing bracket.
        # This is unambiguous to repair and avoids an unnecessary second call.
        repaired = re.sub(r",\s*([}\]])", r"\1", payload)
        if repaired != payload:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        logger.error("script JSON parse failed: %s\n%s", e, payload[:500])
        return {
            "_parse_error": str(e),
            "_raw": payload[:2000],
            "questions": [
                "script 생성 중 JSON 파싱 오류. 사용자 요청을 다시 한 번 명확히 말씀해 주세요."
            ],
        }


def _message_text(content: Any) -> str:
    if isinstance(content, list):
        return " ".join(
            (part.get("text", "") if isinstance(part, dict) else str(part))
            for part in content
        )
    return str(content)


def _parse_failure_plan(error: object) -> dict[str, Any]:
    """End cleanly instead of presenting a zero-step approval card."""
    return {
        "mode": "chat",
        "reply": (
            "편집 계획 JSON 생성이 두 번 모두 올바른 형식으로 끝나지 않았어. "
            "빈 계획을 승인 화면에 표시하지 않고 이번 실행을 종료했어. "
            "같은 요청을 다시 보내면 새 계획을 생성할게."
        ),
        "steps": [],
        "questions": [],
        "_script_error": str(error)[:1000],
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

    # 긴 영상/다중 영상은 최초 호출부터 초압축 컨텍스트를 사용한다. 일반
    # 프롬프트가 deadline에 걸린 뒤 같은 크기의 요청을 반복하는 일을 막는다.
    scenes = video_context.get("scenes") if isinstance(video_context, dict) else []
    scene_count = len(scenes) if isinstance(scenes, list) else 0
    try:
        source_duration_sec = float(
            (video_context or {}).get("duration_sec")
            or (video_context or {}).get("duration")
            or 0
        )
    except (TypeError, ValueError):
        source_duration_sec = 0.0
    large_context = scene_count > 50 or source_duration_sec > 120

    # Script 전용 압축 프롬프트. Supervisor용 전체 문서를 중복 주입하지 않는다.
    sys_text = build_script_node_system_prompt(
        video_context=video_context,
        ultra_compact=large_context,
    )

    # user prompt
    user_parts: list[str] = [
        "# 사용자 요청",
        user_request,
    ]

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
    # Script 노드는 아래에서 명시적으로 한 번만 축약 재시도한다. SDK 내부
    # 재시도까지 겹치면 한 요청이 수 분 동안 UI의 busy 상태를 점유한다.
    llm = make_llm("script", max_retries=0, timeout=90, temperature=0.1)
    compact_attempted = False
    try:
        ai_msg = llm.invoke(
            [
                SystemMessage(content=sys_text),
                HumanMessage(content=user_text),
            ]
        )
    except Exception as e:
        # 긴 프롬프트가 Gemini 서버 deadline에 걸리면 거버넌스/few-shot까지
        # 제외한 초압축 프롬프트로 한 번만 자동 복구한다. 실패를 questions로
        # 포장하면 0-step 승인 카드가 뜨므로 최종 실패는 chat 응답으로 종료한다.
        logger.warning("script LLM first attempt failed; retry compact: %s", e)
        compact_sys_text = build_script_node_system_prompt(
            video_context=video_context,
            ultra_compact=True,
        )
        compact_attempted = True
        try:
            retry_llm = make_llm(
                "script", max_retries=0, timeout=90, temperature=0.1
            )
            ai_msg = retry_llm.invoke(
                [
                    SystemMessage(content=compact_sys_text),
                    HumanMessage(content=user_text),
                ]
            )
        except Exception as retry_error:
            logger.exception("script LLM compact retry failed")
            return {
                "script_plan": {
                    **_parse_failure_plan(
                        f"{type(retry_error).__name__}: {retry_error}"
                    ),
                },
                "script_revision": revision + 1,
            }

    raw = _message_text(ai_msg.content)
    plan = _extract_json(raw)

    # A malformed/truncated response is much more common than an invoke
    # exception. Retry it once with the compact prompt and an explicit no-fence
    # JSON reminder instead of surfacing a zero-step approval card.
    if plan.get("_parse_error") and not compact_attempted:
        logger.warning("script JSON malformed; retry compact JSON generation")
        compact_sys_text = build_script_node_system_prompt(
            video_context=video_context,
            ultra_compact=True,
        )
        retry_user_text = (
            user_text
            + "\n\n# 출력 형식 재확인\n"
            + "설명이나 마크다운 코드펜스 없이, 완결된 JSON 객체 하나만 출력하라. "
            + "문자열 안의 줄바꿈은 \\n으로 이스케이프하고 마지막 항목 뒤 쉼표를 쓰지 마라."
        )
        try:
            retry_llm = make_llm(
                "script", max_retries=0, timeout=90, temperature=0.1
            )
            retry_msg = retry_llm.invoke([
                SystemMessage(content=compact_sys_text),
                HumanMessage(content=retry_user_text),
            ])
            raw = _message_text(retry_msg.content)
            plan = _extract_json(raw)
        except Exception as retry_error:
            logger.exception("script malformed-JSON retry failed")
            plan = _parse_failure_plan(
                f"{type(retry_error).__name__}: {retry_error}"
            )

    if plan.get("_parse_error"):
        plan = _parse_failure_plan(plan.get("_parse_error"))

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
