"""summary_node — rolling conversation summarization.

Context management production 패턴:
1. 매 turn 마다 messages 가 누적 (add_messages reducer)
2. 임계값 (message 수 or token estimate) 넘으면 이 노드가 old messages 를 자연어
   요약으로 압축하고 `conversation_summary` 필드에 저장
3. 다음 supervisor invoke 때 old messages 는 프롬프트에 빠지고 summary 만 참조
4. summary 는 DB `sessions.summary` 로 append-only 로 저장 → 재접속 시 복원

간단화 결정:
- Anthropic 스타일 semantic 요약 (사용자 목표 · 결정 사항 · 결과물) 만 유지.
  세부 tool 인자 · JSON 덤프는 제외 (핵심 결정만).
- 요약은 항상 마지막 요약을 base 로 delta 만 압축 (누적 확장).
- 임계값은 message 수 기준: SUMMARIZE_AFTER_MESSAGES 넘으면 트리거.
- token estimate 는 message content char/4 로 근사.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from agent.llm import make_llm
from agent.state import AgentState

logger = logging.getLogger(__name__)


# 20 개 넘으면 요약 트리거. 조금 널널하게 잡음 (분석·plan·supervisor·critic 이
# 매 turn ~10 개 정도 message 생성하니 2 turn 뒤에 요약).
SUMMARIZE_AFTER_MESSAGES = 20

# 요약 후 raw 로 유지할 마지막 N 개. 최근 대화는 그대로 두고 그 이전만 압축.
KEEP_RECENT_MESSAGES = 8

# 대략적 token 근사 (chars/4). GPT/Gemini 계열 모두에 근사치.
def _estimate_tokens(text: str) -> int:
    return len(text) // 4


def _messages_to_transcript(messages: list) -> str:
    """LLM 에 던질 압축용 text 로 messages 를 flatten."""
    lines: list[str] = []
    for m in messages:
        role = getattr(m, "type", "unknown")
        content = getattr(m, "content", "")
        if isinstance(content, list):
            # multipart (text + image) — text 만 뽑음
            content = " ".join(
                (p.get("text", "") if isinstance(p, dict) else str(p)) for p in content
            )
        content = str(content).strip()
        if not content:
            continue
        # 200 자 이상은 잘라서 요약 부담 감소 (자세한 내용은 이미 tool_result 에 남음)
        if len(content) > 400:
            content = content[:400] + " …(truncated)"
        lines.append(f"[{role}] {content}")
    return "\n".join(lines)


def should_summarize(state: AgentState) -> bool:
    """조건: messages 가 임계 이상이고, 지난 summary 이후 새 message 충분히 쌓임."""
    messages = state.get("messages") or []
    summarized_up_to = state.get("summarized_up_to") or 0
    new_since_last = len(messages) - summarized_up_to
    return new_since_last >= SUMMARIZE_AFTER_MESSAGES


def summary_node(state: AgentState) -> dict[str, Any]:
    """messages 앞부분 (이번 요약 대상) 을 LLM 으로 압축.

    누적 summary 를 유지 (예전 summary + 새 delta). 최근 N 개는 raw 유지.
    """
    messages = state.get("messages") or []
    summarized_up_to = state.get("summarized_up_to") or 0
    previous_summary = state.get("conversation_summary") or ""

    total = len(messages)
    if total - summarized_up_to < SUMMARIZE_AFTER_MESSAGES:
        # 하드 게이트 — should_summarize 가 True 여도 재확인.
        return {}

    # 이번에 요약할 구간: [summarized_up_to, total - KEEP_RECENT_MESSAGES)
    target_end = max(summarized_up_to, total - KEEP_RECENT_MESSAGES)
    if target_end <= summarized_up_to:
        return {}
    to_compress = messages[summarized_up_to:target_end]
    if not to_compress:
        return {}

    started = time.monotonic()
    transcript = _messages_to_transcript(to_compress)

    sys_text = (
        "당신은 영상 편집 에이전트의 대화 이력을 압축하는 요약자다.\n"
        "핵심 정보만 남기고 세부 tool 인자 · JSON 덤프 · 반복 요청은 버려라.\n\n"
        "다음 항목을 짧게 (한국어, 총 200~400자) 구조화된 markdown 으로 요약:\n"
        "- **사용자 요청**: 지금까지 사용자가 요구한 편집 방향\n"
        "- **결정 사항**: 승인된 plan · 스타일 · 포맷 · 자막 · BGM 등\n"
        "- **결과물**: 지금까지 만들어진 산출 경로 (짧게 이름만)\n"
        "- **이슈**: retry · 오류 · 사용자 불만이 있었으면 요약\n"
        "이전 요약이 있으면 그 위에 delta 만 추가해서 누적.\n"
    )
    user_text = (
        f"[이전 요약 (있으면 이 위에 누적)]\n{previous_summary or '(none)'}\n\n"
        f"[이번 압축 대상 대화 로그]\n{transcript}\n\n"
        "위 정보를 종합해서 새 요약을 만들어라. 순수 마크다운만 출력."
    )

    try:
        from agent.llm import system_user_invoke
        result = system_user_invoke("summary", sys_text, user_text)
        new_summary = (result.content or "").strip() if hasattr(result, "content") else ""
    except Exception:
        logger.exception("summary_node: LLM 실패 → 기존 summary 유지")
        return {}

    duration = time.monotonic() - started
    logger.info(
        "summary_node: compressed %d msgs (up to %d) in %.2fs, %d chars",
        len(to_compress), target_end, duration, len(new_summary),
    )

    if not new_summary:
        return {}

    return {
        "conversation_summary": new_summary,
        "summarized_up_to": target_end,
    }
