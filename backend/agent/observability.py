"""에이전트 실행 추적 로깅.

개발 중에 터미널만 보고도 "지금 어느 노드에서 어떤 툴을 무슨 인자로 돌리는 중이고,
얼마나 걸렸고, 어디서 터졌는지" 를 알 수 있게 한다. 기존에는 각 툴이 각자 원하는
만큼만 logger 를 찍어서, 실패했을 때 파이프라인 어느 지점인지 역추적해야 했다.

두 조각으로 되어 있다:

- setup_logging()  : 포맷/레벨/시끄러운 서드파티 억제를 한 곳에서 정한다.
- AgentTracer      : LangChain 콜백. 노드/LLM/툴 경계를 전부 받아 한 줄씩 찍는다.
                     create_react_agent 의 ToolNode 가 콜백을 전파하므로 툴을 하나씩
                     고칠 필요가 없다. 다만 서브에이전트는 config 를 새로 만들어
                     invoke 하므로 거기서도 명시적으로 붙여줘야 한다 (sub_agent.py).

환경변수:
  AGENT_LOG_LEVEL   기본 INFO. DEBUG 로 올리면 서드파티 로그까지 보인다.
  AGENT_LOG_ARGS    툴 인자/결과를 몇 글자까지 찍을지. 기본 200, 0 이면 생략.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger("agent.trace")

# 파이프라인의 뼈대 노드. 이 이름들만 노드 경계로 찍는다 — LangGraph 는 내부
# 채널·분기까지 chain 이벤트로 흘리기 때문에 전부 찍으면 로그가 읽히지 않는다.
_QUIET_THIRD_PARTY = (
    "httpx",
    "httpcore",
    "urllib3",
    "openai",
    "google",
    "google_genai",
    "google.genai",
    "asyncio",
    "matplotlib",
    "PIL",
)


def _arg_limit() -> int:
    try:
        return max(0, int(os.getenv("AGENT_LOG_ARGS", "200")))
    except ValueError:
        return 200


def _short(value: Any, limit: int | None = None) -> str:
    """로그 한 줄에 들어갈 만큼 줄인 표현. 개행은 공백으로 접는다."""
    limit = _arg_limit() if limit is None else limit
    if limit == 0:
        return ""
    if isinstance(value, (dict, list)):
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(value)
    else:
        text = str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else f"{text[:limit]}..."


def setup_logging(level: str | None = None) -> None:
    """루트 로거 구성. import 시점이 아니라 프로세스 시작 시 한 번 호출한다.

    uvicorn 이 자기 핸들러를 먼저 붙이므로 force=True 로 덮어쓴다 — 안 그러면
    같은 줄이 두 번 찍히거나 포맷이 섞인다.
    """
    resolved = (level or os.getenv("AGENT_LOG_LEVEL") or "INFO").upper()
    logging.basicConfig(
        level=resolved,
        format="%(asctime)s %(levelname)-7s %(name)-22s %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
    if resolved != "DEBUG":
        for name in _QUIET_THIRD_PARTY:
            logging.getLogger(name).setLevel(logging.WARNING)
    # uvicorn 액세스 로그(GET /health 6초마다)가 에이전트 로그를 밀어내지 않게.
    if os.getenv("AGENT_LOG_ACCESS", "").lower() not in {"1", "true", "yes"}:
        logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


class AgentTracer(BaseCallbackHandler):
    """노드 / LLM / 툴 경계를 로그로 흘리는 콜백.

    run_id 로 시작~종료를 짝지어 소요 시간을 낸다. 콜백은 그래프 실행 스레드와
    툴 스레드에서 함께 불릴 수 있으므로 시작 시각 저장은 락으로 감싼다.

    label 은 로그 줄의 주체 표시다 (세션 id 앞 6자, 서브에이전트면 역할).
    """

    def __init__(self, label: str = "-") -> None:
        self.label = label
        self._started: dict[UUID, tuple[str, float]] = {}
        self._lock = threading.Lock()

    # ── 내부 ──

    def _open(self, run_id: UUID, name: str) -> None:
        with self._lock:
            self._started[run_id] = (name, time.monotonic())

    def _close(self, run_id: UUID) -> tuple[str, float]:
        with self._lock:
            name, started = self._started.pop(run_id, ("?", time.monotonic()))
        return name, time.monotonic() - started

    def _line(self, mark: str, message: str) -> str:
        return f"[{self.label}] {mark} {message}"

    # ── 노드 ──

    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        node = (metadata or {}).get("langgraph_node")
        if not node:
            return
        # 노드 하나가 내부 runnable 로 한 번 더 감싸져 실행되면 같은 이름의 chain
        # 이벤트가 부모/자식으로 두 번 온다. 바깥쪽만 찍는다.
        name = f"node:{node}"
        with self._lock:
            if parent_run_id is not None and self._started.get(parent_run_id, ("", 0))[0] == name:
                return
        self._open(run_id, name)
        logger.info(self._line(">>", f"node {node} 시작"))

    def on_chain_end(
        self, outputs: dict[str, Any], *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        with self._lock:
            tracked = run_id in self._started
        if not tracked:
            return
        name, elapsed = self._close(run_id)
        if not name.startswith("node:"):
            return
        logger.info(self._line("<<", f"{name[5:]} 완료 {elapsed:.2f}s"))

    def on_chain_error(
        self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        with self._lock:
            tracked = run_id in self._started
        if not tracked:
            return
        name, elapsed = self._close(run_id)
        logger.error(
            self._line("!!", f"{name} 실패 {elapsed:.2f}s - {type(error).__name__}: {error}"),
            exc_info=error,
        )

    # ── LLM ──

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        model = (metadata or {}).get("ls_model_name") or (serialized or {}).get("name") or "llm"
        turns = sum(len(batch) for batch in messages)
        self._open(run_id, f"llm:{model}")
        logger.debug(self._line("..", f"llm {model} 호출 (메시지 {turns}개)"))

    def on_llm_end(
        self, response: Any, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        with self._lock:
            tracked = run_id in self._started
        if not tracked:
            return
        name, elapsed = self._close(run_id)
        usage = {}
        try:
            usage = (response.llm_output or {}).get("token_usage") or {}
        except AttributeError:
            pass
        tokens = ""
        if usage:
            tokens = (
                f" tokens in={usage.get('prompt_tokens', '?')}"
                f" out={usage.get('completion_tokens', '?')}"
            )
        logger.info(self._line("--", f"{name} 응답 {elapsed:.2f}s{tokens}"))

    def on_llm_error(
        self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        name, elapsed = self._close(run_id)
        logger.error(
            self._line("!!", f"{name} 실패 {elapsed:.2f}s - {type(error).__name__}: {error}"),
            exc_info=error,
        )

    # ── 툴 ──

    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        inputs: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        name = (serialized or {}).get("name") or "tool"
        self._open(run_id, f"tool:{name}")
        args = _short(inputs if inputs is not None else input_str)
        logger.info(self._line("->", f"tool {name}({args})" if args else f"tool {name}"))

    def on_tool_end(
        self, output: Any, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        name, elapsed = self._close(run_id)
        text = _short(getattr(output, "content", output))
        # 툴은 예외 대신 "ERROR: ..." 문자열을 돌려주는 규약이라 콜백은 성공으로
        # 본다. 그대로 INFO 로 흘리면 실패가 로그에서 묻히므로 여기서 승격한다.
        level = logging.ERROR if text.lstrip().upper().startswith("ERROR") else logging.INFO
        mark = "!!" if level == logging.ERROR else "<-"
        logger.log(level, self._line(mark, f"{name} {elapsed:.2f}s {text}".rstrip()))

    def on_tool_error(
        self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any
    ) -> None:
        name, elapsed = self._close(run_id)
        logger.error(
            self._line("!!", f"{name} 예외 {elapsed:.2f}s - {type(error).__name__}: {error}"),
            exc_info=error,
        )


def tracer(label: str) -> AgentTracer:
    return AgentTracer(label)
