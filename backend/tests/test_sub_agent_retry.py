"""Sub-agent 는 서버측 일시 장애를 자기 선에서 흡수해야 한다.

이 재시도가 없으면 504 하나가 step 실패로 올라가고, supervisor 가 파이프라인
전체를 최대 3회 재실행하며 같은 타임아웃을 훨씬 비싼 단위로 반복한다.
"""

from __future__ import annotations

from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

import agent.sub_agent as sub_agent_module
from agent.sub_agent import SubAgentEnvelope, spawn_sub_agent

TRANSIENT = (
    "ServerError: 504 DEADLINE_EXCEEDED. {'error': {'code': 504, 'message': "
    "'The request timed out. Please try again.', 'status': 'DEADLINE_EXCEEDED'}}"
)

SUCCESS_STATE = {
    "messages": [
        ToolMessage(
            content='{"status": "success", "output": "videos/clips/cut_0.mp4"}',
            name="cut_video",
            tool_call_id="call-1",
        ),
        AIMessage(content="done: videos/clips/cut_0.mp4"),
    ]
}


class _FlakyAgent:
    """앞의 `failures` 회는 주어진 오류로 실패하고 그 다음 성공."""

    def __init__(self, failures: int, error: str):
        self.calls = 0
        self._failures = failures
        self._error = error

    def invoke(self, *_args, **_kwargs):
        self.calls += 1
        if self.calls <= self._failures:
            raise RuntimeError(self._error)
        return SUCCESS_STATE


class _SequencedAgent:
    def __init__(self, states):
        self.calls = 0
        self.inputs = []
        self._states = states

    def invoke(self, invoke_input, **_kwargs):
        self.inputs.append(invoke_input)
        index = min(self.calls, len(self._states) - 1)
        self.calls += 1
        return self._states[index]


def _spawn_with(agent_stub):
    envelope = SubAgentEnvelope(role="edit_expert", task="cut 0-5s")
    with patch.object(sub_agent_module, "create_react_agent", return_value=agent_stub), \
         patch.object(sub_agent_module.time, "sleep"):  # 백오프 대기 건너뜀
        return spawn_sub_agent(envelope)


def test_transient_failure_is_retried_until_success():
    stub = _FlakyAgent(failures=2, error=TRANSIENT)

    result = _spawn_with(stub)

    assert stub.calls == 3, "504 는 백오프 후 재시도돼야 한다"
    assert result.status == "ok"
    assert "videos/clips/cut_0.mp4" in result.output_paths


def test_transient_failure_gives_up_after_attempt_budget():
    stub = _FlakyAgent(failures=99, error=TRANSIENT)

    result = _spawn_with(stub)

    assert stub.calls == sub_agent_module.TRANSIENT_RETRY_ATTEMPTS
    assert result.status == "error"
    assert "DEADLINE_EXCEEDED" in result.error


def test_ordinary_failure_is_not_retried():
    """코드/인자 오류는 재시도해도 같은 결과 — 즉시 보고해야 한다."""
    stub = _FlakyAgent(failures=99, error="ValueError: unknown output path")

    result = _spawn_with(stub)

    assert stub.calls == 1
    assert result.status == "error"


def test_missing_tool_call_is_forced_and_then_succeeds():
    no_tool_state = {"messages": [AIMessage(content="I will create the BGM.")]}
    stub = _SequencedAgent([no_tool_state, SUCCESS_STATE])

    result = _spawn_with(stub)

    assert stub.calls == 2
    assert result.status == "ok"
    retry_messages = stub.inputs[1]["messages"]
    assert isinstance(retry_messages[-1], HumanMessage)
    assert "did not call a tool" in retry_messages[-1].content


def test_missing_tool_call_stops_after_retry_budget():
    no_tool_state = {"messages": [AIMessage(content="I cannot do that.")]}
    stub = _SequencedAgent([no_tool_state])

    result = _spawn_with(stub)

    assert stub.calls == 1 + sub_agent_module.NO_TOOL_RETRY_ATTEMPTS
    assert result.status == "error"
    assert result.error == "no_tool_call"


def test_existing_tool_call_is_never_retried():
    stub = _SequencedAgent([SUCCESS_STATE])

    result = _spawn_with(stub)

    assert stub.calls == 1
    assert result.status == "ok"
