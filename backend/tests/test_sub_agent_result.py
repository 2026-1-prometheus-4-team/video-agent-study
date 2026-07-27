"""Sub-agent execution results must be grounded in actual tool calls."""

from __future__ import annotations

import time

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from agent.sub_agent import _extract_result


def test_task_path_without_tool_call_is_not_success():
    state = {
        "messages": [
            HumanMessage(content="cut and save to videos/clips/cut_0.mp4"),
            AIMessage(content="output: videos/clips/cut_0.mp4"),
        ],
    }

    result = _extract_result("edit_expert", state, time.monotonic())

    assert result.status == "error"
    assert result.error == "no_tool_call"
    assert result.output_paths == []


def test_tool_error_is_propagated():
    state = {
        "messages": [
            HumanMessage(content="cut video"),
            ToolMessage(
                content="ERROR: ffmpeg failed",
                name="cut_video",
                tool_call_id="call-1",
            ),
            AIMessage(content="ERROR: ffmpeg failed"),
        ],
    }

    result = _extract_result("edit_expert", state, time.monotonic())

    assert result.status == "error"
    assert "ffmpeg failed" in result.error


def test_success_paths_exclude_unexecuted_human_task_paths():
    state = {
        "messages": [
            HumanMessage(content="input videos/source.mp4 output videos/wrong.mp4"),
            ToolMessage(
                content="C:/project/backend/videos/final.mp4",
                name="cut_video",
                tool_call_id="call-2",
            ),
            AIMessage(content="output: videos/final.mp4"),
        ],
    }

    result = _extract_result("edit_expert", state, time.monotonic())

    assert result.status == "ok"
    assert "videos/source.mp4" not in result.output_paths
    assert "videos/wrong.mp4" not in result.output_paths
    assert any(path.endswith("final.mp4") for path in result.output_paths)
