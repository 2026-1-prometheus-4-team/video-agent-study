"""
LangGraph 그래프 정의 (성민)

ReAct 루프
    agent -> (tool_calls 있으면) tool -> agent -> ... -> END
"""

import json
import logging
from typing import Optional

from langgraph.graph import StateGraph, END
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage

from agent.state import AgentState, VideoContext
from agent.llm import llm
from agent.tools import tools, tool_map

logger = logging.getLogger(__name__)

llm_with_tools = llm.bind_tools(tools)


def agent_node(state: AgentState) -> AgentState:
    messages = state["messages"]

    if state.get("video_context"):
        context_str = json.dumps(state["video_context"], ensure_ascii=False)
        system_prompt = f"현재 편집 중인 영상 정보:\n{context_str}"
        messages = [HumanMessage(content=system_prompt)] + messages

    logger.info("agent_node 실행 - LLM 판단 중")
    response = llm_with_tools.invoke(messages)
    return {"messages": [response]}


def tool_node(state: AgentState) -> AgentState:
    last_message = state["messages"][-1]
    tool_results = []
    edit_history = state.get("edit_history", [])

    for tool_call in last_message.tool_calls:
        tool_name = tool_call["name"]
        tool_args = tool_call["args"]

        logger.info(f"tool_node 실행 - {tool_name}({tool_args})")

        try:
            result = tool_map[tool_name].invoke(tool_args)
            edit_history.append(f"{tool_name} : 성공")
            tool_results.append(
                ToolMessage(content=str(result), tool_call_id=tool_call["id"])
            )
        except Exception as e:
            error_msg = f"{tool_name} 실행 실패 : {str(e)}"
            logger.error(error_msg)
            edit_history.append(f"{tool_name} : 실패 - {str(e)}")
            tool_results.append(
                ToolMessage(content=error_msg, tool_call_id=tool_call["id"])
            )

    return {"messages": tool_results, "edit_history": edit_history}


def should_continue(state: AgentState) -> str:
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tool"
    return END


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tool", tool_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tool": "tool", END: END})
    graph.add_edge("tool", "agent")
    return graph.compile()


def run_agent_stream(user_input: str, video_context: Optional[VideoContext] = None):
    graph = build_graph()

    initial_state: AgentState = {
        "messages": [HumanMessage(content=user_input)],
        "video_context": video_context,
        "edit_history": [],
    }

    print(f"\n[입력] {user_input}")
    print("-" * 60)

    for step in graph.stream(initial_state):
        for node_name, state in step.items():
            print(f"\n>> {node_name}")

            for message in state["messages"]:
                if isinstance(message, AIMessage):
                    if message.content:
                        print(f"   AI : {message.content}")
                    if hasattr(message, "tool_calls") and message.tool_calls:
                        for tc in message.tool_calls:
                            print(f"   Tool 선택 : {tc['name']}")
                            print(f"   Args      : {tc['args']}")
                elif isinstance(message, ToolMessage):
                    print(f"   Tool 결과 : {message.content}")

            if state.get("edit_history"):
                print(f"   편집 기록 : {state['edit_history']}")

    print("\n" + "-" * 60)
