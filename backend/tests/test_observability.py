"""에이전트 실행이 터미널 로그로 보여야 한다.

개발 중 "지금 어느 노드에서 어떤 툴을 돌리는 중인지, 어디서 터졌는지" 를 로그만
보고 알 수 있어야 한다. 특히 이 코드베이스의 툴은 실패를 예외가 아니라
"ERROR: ..." 문자열로 돌려주는 규약이라, 그대로 두면 실패가 INFO 로 묻힌다.
"""

from __future__ import annotations

import logging
from typing import TypedDict

from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph

from agent.observability import AgentTracer, _short


@tool
def echo_tool(text: str) -> str:
    """테스트용 툴."""
    return f"받음: {text}"


@tool
def failing_tool(path: str) -> str:
    """실패를 문자열로 돌려주는 이 코드베이스의 규약."""
    return f"ERROR: 파일을 찾을 수 없음: {path}"


def test_tool_call_is_logged(caplog):
    with caplog.at_level(logging.INFO, logger="agent.trace"):
        echo_tool.invoke({"text": "안녕"}, config={"callbacks": [AgentTracer("sess01")]})

    messages = [r.getMessage() for r in caplog.records]
    assert any("tool echo_tool" in m and "안녕" in m for m in messages), "툴 인자가 보여야 한다"
    assert any("echo_tool" in m and "받음" in m for m in messages), "툴 결과가 보여야 한다"
    assert all("[sess01]" in m for m in messages), "어느 세션의 실행인지 표시돼야 한다"


def test_error_string_return_is_logged_as_error(caplog):
    """예외가 아니라 ERROR 문자열로 실패해도 ERROR 레벨로 올라와야 한다."""
    with caplog.at_level(logging.INFO, logger="agent.trace"):
        failing_tool.invoke(
            {"path": "videos/없는파일.mp4"}, config={"callbacks": [AgentTracer("sess01")]}
        )

    levels = {r.levelno for r in caplog.records if "failing_tool" in r.getMessage()}
    assert logging.ERROR in levels, "실패가 INFO 로 묻히면 로그를 봐도 못 찾는다"


def test_node_boundaries_and_failure_are_logged(caplog):
    class S(TypedDict):
        n: int

    def analysis(state):
        return {"n": state["n"] + 1}

    def script(state):
        raise RuntimeError("플랜 생성 실패")

    graph = StateGraph(S)
    graph.add_node("analysis", analysis)
    graph.add_node("script", script)
    graph.add_edge(START, "analysis")
    graph.add_edge("analysis", "script")
    graph.add_edge("script", END)
    app = graph.compile()

    with caplog.at_level(logging.INFO, logger="agent.trace"):
        try:
            app.invoke({"n": 0}, config={"callbacks": [AgentTracer("sess01")]})
        except RuntimeError:
            pass

    messages = [r.getMessage() for r in caplog.records]
    assert any("node analysis 시작" in m for m in messages)
    assert any("analysis 완료" in m for m in messages)
    assert any("script 실패" in m and "RuntimeError" in m for m in messages), (
        "어느 노드에서 터졌는지 로그만 보고 알 수 있어야 한다"
    )


def test_long_payload_is_truncated():
    assert _short("가" * 500).endswith("...")
    assert len(_short("가" * 500)) <= 203


def test_newlines_are_folded():
    """여러 줄 결과가 로그를 도배하지 않도록 한 줄로 접는다."""
    assert "\n" not in _short("첫 줄\n둘째 줄\n셋째 줄")
