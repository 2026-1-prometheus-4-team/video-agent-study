"""
Sub-Agent Spawn (OpenClaw ACP 패턴의 Python/LangGraph 이식)

핵심 격리 룰
1. child 는 fresh context. parent 의 message history 못 봄.
2. child 는 parent 가 명시적으로 박은 `task` string 만 봄.
3. child 의 tool allowlist 는 parent 가 좁힐 수 있음 (widen 불가).
4. spawn 깊이 / 동시 child 수 / child 내부 tool call 횟수 가드.
5. child 결과는 string 으로 parent 에게 tool_result 처럼 반환.

참고:
- OpenClaw `src/agents/acp-spawn.ts` 의 `spawnAcpDirect`
- Claude Agent SDK 의 `AgentDefinition` (description + prompt + tools + model)

설계 메모:
- langgraph-supervisor 의 handoff 는 message history 가 공유돼서 비용 큼.
- 우리는 결정 1 (완전 격리) 채택 -> handoff 대신 *tool 처럼* 호출.
- 각 sub-agent 는 `langchain.agents.create_agent` 로 만든 자기만의 mini ReAct loop.
"""

from __future__ import annotations

import logging
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from langgraph.prebuilt import create_react_agent
from langchain_core.messages import HumanMessage, ToolMessage

from agent import config
from agent.errors import is_transient_error
from agent.llm import make_llm
from agent.prompt_builder import build_sub_agent_system_prompt
from agent.state import VideoContext
from agent.tools import tool_groups

logger = logging.getLogger(__name__)

# 일시 장애 재시도 — 총 3회 시도, 2s / 4s 백오프.
# 파이프라인 전체 재실행(최대 3회 × 전체 step)보다 훨씬 싼 복구 지점이다.
TRANSIENT_RETRY_ATTEMPTS = 3
TRANSIENT_RETRY_BASE_SEC = 2.0


# =============================================================
# Envelope (parent -> child 가 넘기는 모든 정보)
# =============================================================

@dataclass
class SubAgentEnvelope:
    """parent 가 child 에게 *명시적으로* 박아 보내는 모든 정보.

    Sub-agent 가 parent 의 message history 를 못 보므로,
    필요한 정보는 *반드시* 이 envelope 안에 다 들어가야 한다.
    """

    role: str
    """edit_expert | audio_expert | text_expert | effect_expert | research_expert"""

    task: str
    """child 가 해야 할 작업의 자연어 설명.
    *반드시* 입력/출력 경로, 타임스탬프, 이전 step 산출물 등을 명시적으로 박을 것.
    """

    inherited_tool_allowlist: Optional[list[str]] = None
    """parent 가 좁힌 allowlist (tool name 기준).
    None 이면 role 의 기본 tool group 전체 사용.
    """

    inherited_tool_denylist: list[str] = field(default_factory=list)
    """deny 되면 어떤 경우에도 호출 불가."""

    video_context: Optional[VideoContext] = None
    """영상 분석 결과 (child 도 분석 결과는 공유)."""

    model_override: Optional[str] = None
    """sub-agent 의 LLM 을 다른 모델로 강제할 때."""

    spawn_depth: int = 0
    """recursion 가드. parent.depth + 1."""

    parent_session_id: Optional[str] = None
    """추적용. spawnedBy 와 같은 역할."""


# =============================================================
# Result (child -> parent)
# =============================================================

@dataclass
class SubAgentResult:
    """child 가 parent 에게 돌려주는 표준 결과 형식."""

    role: str
    status: str       # "ok" | "error" | "needs_user"
    summary: str      # 한 줄 요약 (Supervisor 가 다음 결정에 쓰는 핵심)
    output_paths: list[str] = field(default_factory=list)  # 산출 파일 경로들
    detail: str = ""  # 긴 설명 (디버깅용)
    error: Optional[str] = None
    duration_sec: float = 0.0

    def as_tool_result_text(self) -> str:
        """parent LLM 의 tool_result 메시지에 박을 형식."""
        lines = [
            f"[{self.role}] status={self.status} ({self.duration_sec:.1f}s)",
            f"summary: {self.summary}",
        ]
        if self.output_paths:
            lines.append("outputs:")
            for p in self.output_paths:
                lines.append(f"  - {p}")
        if self.detail:
            lines.append("detail: " + self.detail)
        if self.error:
            lines.append("ERROR: " + self.error)
        return "\n".join(lines)


# =============================================================
# Tool allowlist 적용
# =============================================================

def _resolve_tools(role: str, envelope: SubAgentEnvelope) -> list:
    """role 의 기본 tool group + envelope 의 allow/deny 를 합성."""
    group_key = config.ROLE_TO_TOOL_GROUP.get(role)
    if group_key is None:
        raise ValueError(f"Unknown role: {role}. Known: {list(config.ROLE_TO_TOOL_GROUP)}")

    base_tools = tool_groups.get(group_key, [])

    # allowlist 가 명시되면 그 안의 tool 만
    if envelope.inherited_tool_allowlist is not None:
        allowed = set(envelope.inherited_tool_allowlist)
        base_tools = [t for t in base_tools if t.name in allowed]

    # denylist 는 항상 적용
    if envelope.inherited_tool_denylist:
        denied = set(envelope.inherited_tool_denylist)
        base_tools = [t for t in base_tools if t.name not in denied]

    return base_tools


# =============================================================
# Spawn 본체
# =============================================================

def spawn_sub_agent(envelope: SubAgentEnvelope) -> SubAgentResult:
    """isolated sub-agent 실행.

    parent 의 LangGraph 노드에서 호출. 동기 함수 (LangGraph 노드는 sync 가능).
    스트리밍이 필요하면 추후 async 버전 추가.
    """
    started = time.monotonic()
    role = envelope.role

    # ── 1. Guardrail 체크 ──
    limits = config.SUB_AGENT_LIMITS

    if envelope.spawn_depth > limits.max_spawn_depth:
        return SubAgentResult(
            role=role,
            status="error",
            summary=f"spawn depth exceeded ({envelope.spawn_depth} > {limits.max_spawn_depth})",
            error="spawn_depth_exceeded",
            duration_sec=time.monotonic() - started,
        )

    # ── 2. Tool 해석 (격리된 allowlist) ──
    try:
        tools = _resolve_tools(role, envelope)
    except ValueError as e:
        return SubAgentResult(
            role=role, status="error", summary=str(e),
            error="unknown_role", duration_sec=time.monotonic() - started,
        )

    if not tools:
        logger.warning("sub-agent %s has no tools after allowlist filter", role)

    # ── 3. System prompt 조립 (격리 컨텍스트) ──
    system_prompt = build_sub_agent_system_prompt(
        role=role,
        video_context=envelope.video_context,
        parent_task_summary=envelope.task,
    )

    # ── 4. LLM 인스턴스 ──
    sub_llm = make_llm(
        "sub_agent",
        temperature=None,  # config default 사용
    )
    if envelope.model_override:
        # ad-hoc override 가 필요하면 새 인스턴스
        from langchain_google_genai import ChatGoogleGenerativeAI
        sub_llm = ChatGoogleGenerativeAI(
            model=envelope.model_override,
            temperature=config.TEMPERATURE_SUB_AGENT,
        )

    # ── 5. Mini ReAct agent 생성 (격리됨) ──
    child_agent = create_react_agent(
        model=sub_llm,
        tools=tools,
        prompt=system_prompt,
    )

    # ── 6. Invoke (child 에게는 envelope.task 만이 유일한 input) ──
    invoke_input = {"messages": [HumanMessage(content=envelope.task)]}

    # 서버측 일시 장애(504 DEADLINE_EXCEEDED, 503 등)는 여기서 흡수한다.
    # 이 재시도가 없으면 supervisor 가 step 실패로 보고 파이프라인 전체를
    # 재실행해서, 같은 타임아웃을 훨씬 비싼 단위로 반복하게 된다.
    result_state = None
    for attempt in range(1, TRANSIENT_RETRY_ATTEMPTS + 1):
        try:
            result_state = child_agent.invoke(
                invoke_input,
                config={"recursion_limit": limits.max_tool_calls_per_spawn * 2},
            )
            break
        except Exception as e:
            retriable = is_transient_error(e) and attempt < TRANSIENT_RETRY_ATTEMPTS
            if not retriable:
                logger.exception("sub-agent %s invoke failed", role)
                return SubAgentResult(
                    role=role,
                    status="error",
                    summary=f"{type(e).__name__}: {e}",
                    error=str(e),
                    duration_sec=time.monotonic() - started,
                )
            delay = TRANSIENT_RETRY_BASE_SEC * attempt
            logger.warning(
                "sub-agent %s transient failure (%d/%d), %.1fs 후 재시도: %s",
                role, attempt, TRANSIENT_RETRY_ATTEMPTS, delay, e,
            )
            time.sleep(delay)

    # ── 7. 결과 추출 ──
    return _extract_result(role, result_state, started)


def _extract_result(role: str, state: dict, started: float) -> SubAgentResult:
    """create_agent invoke 결과 dict 에서 SubAgentResult 추출.

    create_agent 는 다음을 반환:
    - state["messages"][-1]: 마지막 AIMessage (요약 텍스트)
    - 중간 tool 호출은 messages 리스트에 ToolMessage 로 들어있음

    output 파일 경로는 ToolMessage 의 content 에서 휴리스틱으로 추출.
    """
    messages = state.get("messages", [])
    if not messages:
        return SubAgentResult(
            role=role,
            status="error",
            summary="no output messages",
            error="empty_state",
            duration_sec=time.monotonic() - started,
        )

    tool_messages = [message for message in messages if isinstance(message, ToolMessage)]
    if not tool_messages:
        return SubAgentResult(
            role=role,
            status="error",
            summary="sub-agent returned without calling a tool",
            error="no_tool_call",
            duration_sec=time.monotonic() - started,
        )

    for message in tool_messages:
        content = getattr(message, "content", "")
        if isinstance(content, list):
            content = " ".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        text = str(content).strip()
        is_error = text.startswith("ERROR")
        if not is_error:
            try:
                parsed = json.loads(text)
                is_error = (
                    isinstance(parsed, dict)
                    and (
                        parsed.get("status") in {"error", "failed"}
                        or bool(parsed.get("error"))
                    )
                )
            except (json.JSONDecodeError, TypeError):
                pass
        if is_error:
            return SubAgentResult(
                role=role,
                status="error",
                summary=text[:300],
                error=text[:1000],
                duration_sec=time.monotonic() - started,
            )

    last_msg = messages[-1]
    summary = getattr(last_msg, "content", "") or ""
    if isinstance(summary, list):
        # gemini 가 가끔 list of dict 로 줌
        summary = " ".join(
            (part.get("text", "") if isinstance(part, dict) else str(part))
            for part in summary
        )
    summary = str(summary)[:1000]

    tool_errors, output_paths = _inspect_tool_results(messages)
    if not output_paths and not tool_errors:
        # 구조화 JSON 에서 출력 경로를 못 찾았고 에러도 없으면, 평문 메시지에서
        # 경로 후보를 휴리스틱으로 추출한다 (일부 tool 은 평문 경로만 반환).
        # 에러가 있을 땐 fallback 하지 않는다 — 에러 문구에서 경로를 추론하지 않기 위해.
        output_paths = _extract_paths_from_messages(messages)
    # 유효한 산출물이 나왔으면 성공으로 본다. sub-agent 가 ReAct 루프에서 도중에
    # 실패한 tool 호출(중복/탐색성)을 껴도, 목표 파일을 만들었으면 그 step 은 완료다.
    # (예: merge_video 성공 후 다른 호출이 에러 → 예전엔 step 전체가 error → 편집 미완료)
    status = "error" if (tool_errors and not output_paths) else "ok"
    error = "; ".join(tool_errors)[:1000] if tool_errors else None

    return SubAgentResult(
        role=role,
        status=status,
        summary=summary[:300],
        output_paths=output_paths,
        detail=summary if len(summary) > 300 else "",
        error=error,
        duration_sec=time.monotonic() - started,
    )


def _existing_output_path(value: object) -> Optional[str]:
    """Return the reported path only when the file actually exists."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    path = Path(raw)
    candidates = [path] if path.is_absolute() else [
        config.PROJECT_ROOT / path,
        config.VIDEOS_DIR / path,
        config.VIDEOS_DIR / Path(*path.parts[1:])
        if path.parts and path.parts[0].lower() == "videos"
        else config.VIDEOS_DIR / path,
    ]
    return raw if any(candidate.exists() for candidate in candidates) else None


def _inspect_tool_results(messages: list) -> tuple[list[str], list[str]]:
    """Read structured ToolMessage JSON; never infer outputs from error prose."""
    from langchain_core.messages import ToolMessage

    errors: list[str] = []
    outputs: list[str] = []
    for message in messages:
        if not isinstance(message, ToolMessage):
            continue
        content = getattr(message, "content", "")
        if isinstance(content, list):
            content = " ".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        text = str(content).strip()
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            # Some framework/tool errors are plain text rather than JSON.
            lowered = text.lower()
            if text.startswith("ERROR") or "status=error" in lowered:
                errors.append(text[:300])
            continue
        if not isinstance(payload, dict):
            continue
        status = str(payload.get("status", "")).lower()
        error_value = payload.get("error")
        if status in {"error", "fail", "failed"} or (
            error_value and status != "success"
        ):
            detail_parts = [str(error_value or status)]
            if payload.get("status_code") is not None:
                detail_parts.append(f"status_code={payload['status_code']}")
            if payload.get("response"):
                detail_parts.append(f"response={str(payload['response'])[:700]}")
            errors.append("; ".join(detail_parts)[:1000])
            continue
        for key in ("output", "manifest"):
            existing = _existing_output_path(payload.get(key))
            if existing and existing not in outputs:
                outputs.append(existing)
    return errors, outputs


def _extract_paths_from_messages(messages: list) -> list[str]:
    """messages 리스트에서 생성된 파일 경로 후보를 추출.

    완벽하지 않은 휴리스틱이지만, sub-agent 가 통상 결과 경로를
    응답 / tool_result 에 텍스트로 박기 때문에 대부분 잡힘.
    """
    import re
    pattern = re.compile(r'[\w./\-]+\.(?:mp4|mov|wav|mp3|aac|srt|vtt|png|jpg|json)\b', re.I)
    seen: list[str] = []
    for m in messages:
        if isinstance(m, HumanMessage):
            continue
        content = getattr(m, "content", None)
        if isinstance(content, str):
            for p in pattern.findall(content):
                if p not in seen:
                    seen.append(p)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text", "")
                    for p in pattern.findall(text):
                        if p not in seen:
                            seen.append(p)
    return seen


# =============================================================
# Supervisor 가 LLM tool 로 부를 수 있는 래퍼
# =============================================================

def make_spawn_tools(
    *,
    video_context: Optional[VideoContext] = None,
    parent_depth: int = 0,
    parent_session_id: Optional[str] = None,
) -> list:
    """5 개 sub-agent 를 *langchain tool* 로 wrapping 해서 반환.

    Supervisor 가 `spawn_edit_expert(task=...)` 같은 식으로 호출.
    각 wrapper 가 SubAgentEnvelope 만들어 spawn_sub_agent 부른다.

    Args:
        video_context: 모든 child 가 공유할 분석 결과.
        parent_depth: 현재 spawn 깊이 (graph entry 에서 0).
        parent_session_id: 추적용.
    """
    from langchain_core.tools import tool

    def _make_tool(role: str):
        # closure 로 각 역할 캡처
        @tool(role.replace("_expert", ""))  # tool name: edit / audio / text / effect / research
        def _spawn(task: str) -> str:
            """위임 도구. 자세한 task description 을 자연어로 넘기면 해당 전문가가 격리 컨텍스트에서 처리.

            Args:
                task: 전문가에게 줄 작업 설명. 파일 경로, 타임스탬프, 이전 산출물 등 필요한 정보 *전부* 박을 것.
                도구 선택은 child 전문가가 수행한다. Supervisor가 allowlist를
                추측해 넘기면 여러 도구가 필요한 작업에서 후속 도구가 사라질 수 있다.
            """
            envelope = SubAgentEnvelope(
                role=role,
                task=task,
                # Supervisor LLM이 임의로 tool group을 축소하지 못하게 한다.
                # 역할별 격리는 ROLE_TO_TOOL_GROUP 자체로 이미 보장된다.
                inherited_tool_allowlist=None,
                video_context=video_context,
                spawn_depth=parent_depth + 1,
                parent_session_id=parent_session_id,
            )
            result = spawn_sub_agent(envelope)
            return result.as_tool_result_text()

        # tool name 명확히 (LangChain 의 @tool 은 함수명을 name 으로 씀)
        _spawn.name = role.replace("_expert", "")
        return _spawn

    return [_make_tool(role) for role in config.ROLE_TO_TOOL_GROUP.keys()]
