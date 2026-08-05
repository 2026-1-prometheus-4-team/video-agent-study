"""
Critic 노드

Supervisor 가 모든 step 을 끝냈다고 알린 뒤 호출.
PASS / RETRY 결정.

- PASS  -> END
- RETRY -> Supervisor 로 다시 (특정 step 부터)
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from agent import config
from agent.errors import is_terminal_error, user_message_for
from agent.llm import make_llm
from agent.prompt_builder import build_critic_system_prompt
from agent.state import AgentState

logger = logging.getLogger(__name__)


_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_json(text: str) -> dict[str, Any]:
    m = _JSON_BLOCK.search(text)
    payload = m.group(1) if m else text
    if not m:
        start = payload.find("{")
        end = payload.rfind("}")
        if start != -1 and end != -1:
            payload = payload[start : end + 1]
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"verdict": "RETRY", "issues": ["critic JSON parse 실패"], "raw": payload[:1000]}


def _summarize_trace(state: AgentState) -> str:
    trace = state.get("execution_trace", []) or []
    if not trace:
        return "(execution_trace 비어 있음)"
    lines = []
    for step in trace:
        lines.append(
            f"- step {step.get('step_id','?')}: "
            f"{step.get('expert','?')} . {step.get('action','?')} "
            f"-> {step.get('status','?')} ({step.get('duration_sec', 0):.1f}s)"
        )
        if step.get("output_paths"):
            for p in step["output_paths"]:
                lines.append(f"    output: {p}")
        if step.get("summary"):
            lines.append(f"    summary: {step['summary'][:200]}")
    return "\n".join(lines)


def critic_node(state: AgentState) -> dict[str, Any]:
    """결과 검증. PASS / RETRY 결정."""
    final_path = state.get("final_output_path")
    script_plan = state.get("script_plan")
    trace_text = _summarize_trace(state)

    # 1. 객관 가드: 파일 존재 여부 같은 *기계적* 체크는 LLM 부르기 전에 먼저
    objective_issues: list[str] = []
    trace = state.get("execution_trace", []) or []
    plan_steps = (script_plan or {}).get("steps", []) if isinstance(script_plan, dict) else []
    successful_ids = {
        step.get("step_id") for step in trace
        if step.get("status") == "ok" and step.get("step_id") is not None
    }
    # 과거에 실패했더라도 같은 step_id가 이후 재시도에서 성공했다면 해결된
    # 오류다. 오래된 error trace 때문에 영원히 RETRY하지 않도록 제외한다.
    failed_steps = [
        step for step in trace
        if step.get("status") == "error"
        and step.get("step_id") not in successful_ids
    ]
    missing_steps = [
        step for step in plan_steps
        if step.get("step_id") is not None and step.get("step_id") not in successful_ids
    ]
    if failed_steps:
        failed_ids = ", ".join(str(step.get("step_id", "?")) for step in failed_steps)
        objective_issues.append(f"실패한 실행 step 존재: {failed_ids}")
    if missing_steps:
        missing_ids = ", ".join(str(step.get("step_id", "?")) for step in missing_steps)
        objective_issues.append(f"완료되지 않은 계획 step 존재: {missing_ids}")

    # 최종 영상 존재 여부 (절대경로 또는 PROJECT_ROOT 기준 상대).
    final_exists = bool(final_path) and (
        os.path.exists(str(final_path))
        or os.path.exists(os.path.join(str(config.PROJECT_ROOT), str(final_path)))
    )

    # 최종 영상이 아예 없을 때만 하드 RETRY. 있으면 부가 step(효과음/캡션/특정
    # 리사이즈 등)이 일부 실패해도 볼 수 있는 영상이 나온 것이므로 부분 성공으로
    # 넘긴다 — 예전엔 부가 step 하나 실패에도 전체가 "편집 미완료"로 끊겼다.
    if not final_exists:
        retry_candidates = failed_steps + missing_steps
        retry_from = retry_candidates[0].get("step_id") if retry_candidates else None
        verdict = {
            "verdict": "RETRY",
            "issues": objective_issues + ["최종 영상이 만들어지지 않음"],
            "retry_from_step_id": retry_from,
            "message_to_user": (
                f"최종 영상이 아직 안 만들어졌어. step {retry_from}부터 다시 시도할게."
                if retry_from is not None
                else "최종 결과물이 만들어지지 않아 다시 시도할게."
            ),
        }
        logger.warning("critic: 최종 산출물 없음 -> RETRY: %s", objective_issues)
        return {
            "critic_verdict": verdict,
            "critic_retries": state.get("critic_retries", 0) + 1,
        }

    if failed_steps or missing_steps:
        partial_ids = ", ".join(
            str(s.get("step_id", "?")) for s in (failed_steps + missing_steps)
        )
        logger.info("critic: 최종 영상 존재, 일부 step(%s) 미적용 -> PASS(부분)", partial_ids)
        return {
            "critic_verdict": {
                "verdict": "PASS",
                "issues": objective_issues,
                "message_to_user": (
                    "영상은 완성됐어. 다만 일부 부가 편집(효과음/캡션 등 step "
                    f"{partial_ids})은 적용되지 않았어 — 필요하면 그 부분만 다시 요청해줘."
                ),
            },
            "critic_retries": state.get("critic_retries", 0),
        }

    # 2. LLM 검증
    sys_text = build_critic_system_prompt(
        video_context=state.get("video_context"),
        script_plan=script_plan,
        session_memory=trace_text,
    )

    user_text = "\n".join([
        "# 검증 요청",
        f"최종 영상 경로: {final_path}",
        f"파일 존재: {os.path.exists(final_path) if final_path else False}",
        "",
        "위 트레이스를 보고 PASS / RETRY 를 결정하라. JSON 만 출력.",
    ])

    from agent.llm import system_user_invoke
    try:
        ai_msg = system_user_invoke("critic", sys_text, user_text)
    except Exception as e:
        logger.exception("critic LLM failed")
        err_text = f"{type(e).__name__}: {e}"
        return {
            "critic_verdict": {
                "verdict": "RETRY",
                "issues": [f"critic LLM 오류: {err_text}"],
                "message_to_user": user_message_for(e, stage="검증"),
                # 검증 실패로 편집 결과까지 버리지 않는다. 일시 장애/쿼터면
                # 여기서 종료하고, 산출물은 그대로 사용자에게 넘긴다.
                "terminal": is_terminal_error(e),
            },
            "critic_retries": state.get("critic_retries", 0) + 1,
        }

    raw = ai_msg.content
    if isinstance(raw, list):
        raw = " ".join((p.get("text", "") if isinstance(p, dict) else str(p)) for p in raw)

    verdict = _extract_json(str(raw))
    verdict.setdefault("verdict", "RETRY")
    verdict.setdefault("issues", [])
    verdict["issues"].extend(objective_issues)
    verdict.setdefault("message_to_user", "")

    logger.info("critic verdict: %s, issues=%d", verdict.get("verdict"), len(verdict["issues"]))
    retries = state.get("critic_retries", 0)
    if verdict.get("verdict") != "PASS":
        retries += 1
    return {"critic_verdict": verdict, "critic_retries": retries}


# 재시도 1회로 제한 — 재시도마다 supervisor 프롬프트 전체가 재전송되고 오디오/자막
# tail 이 통째로 재실행돼 토큰·시간이 급증한다. 한 번 더 시도해도 안 되면 부분 결과로 종료.
MAX_SUPERVISOR_RETRIES = 1


def route_after_critic(state: AgentState) -> str:
    """critic 결과로 라우팅.

    Returns:
        "end" | "supervisor"
    """
    verdict = (state.get("critic_verdict") or {}).get("verdict", "RETRY")
    if (state.get("critic_verdict") or {}).get("terminal"):
        return "end"
    if verdict == "PASS":
        return "end"
    # 무한 루프 방지: critic 이 RETRY 낸 횟수 기준
    retry_count = state.get("critic_retries", 0)
    if retry_count >= MAX_SUPERVISOR_RETRIES:
        logger.warning("critic: max retries (%d) reached, forcing end", MAX_SUPERVISOR_RETRIES)
        return "end"
    return "supervisor"
