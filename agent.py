"""
1회차 스터디 예제 - LangGraph ReAct 에이전트 실전 구조
VideoContext, 에러 핸들링, 스트리밍 포함
"""

import json
import logging
from typing import Annotated, TypedDict, Optional
from dotenv import load_dotenv

load_dotenv()

from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI

# -------------------------------------------------------------------
# 로깅 설정
# -------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger(__name__)


# -------------------------------------------------------------------
# VideoContext 스키마
# 나중에 Whisper, PySceneDetect 결과 여기에 채워짐
# -------------------------------------------------------------------

class Scene(TypedDict):
    start: float
    end: float
    description: str


class Transcript(TypedDict):
    start: float
    end: float
    text: str


class VideoContext(TypedDict):
    file_path: str
    duration: float
    scenes: list[Scene]
    transcript: list[Transcript]


# -------------------------------------------------------------------
# State 정의
# -------------------------------------------------------------------

class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    video_context: Optional[VideoContext]
    edit_history: list[str]


# -------------------------------------------------------------------
# Tool 정의
# -------------------------------------------------------------------

@tool
def search_scene(query: str) -> str:
    """장면 검색 Tool - 나중에 VideoContext.scenes 에서 실제 검색으로 교체"""
    logger.info(f"search_scene 호출 - query: {query}")
    return json.dumps({
        "query": query,
        "result": [
            {"start": 10.0, "end": 25.0, "description": f"'{query}' 관련 장면 더미"}
        ]
    }, ensure_ascii=False)


@tool
def calculate_timestamp(expression: str) -> str:
    """타임스탬프 계산 Tool - 나중에 실제 영상 시간 계산으로 교체"""
    logger.info(f"calculate_timestamp 호출 - expression: {expression}")
    try:
        result = eval(expression)
        return json.dumps({"expression": expression, "result": result})
    except Exception as e:
        raise ValueError(f"타임스탬프 계산 실패 : {str(e)}")


@tool
def get_video_info(file_path: str) -> str:
    """영상 정보 조회 Tool - 나중에 FFmpeg 메타데이터 추출로 교체"""
    logger.info(f"get_video_info 호출 - file_path: {file_path}")
    return json.dumps({
        "file_path": file_path,
        "duration": 120.0,
        "resolution": "1920x1080",
        "fps": 30
    })


tools = [search_scene, calculate_timestamp, get_video_info]
tool_map = {t.name: t for t in tools}


# -------------------------------------------------------------------
# LLM 설정
# -------------------------------------------------------------------

llm = ChatGoogleGenerativeAI(model="gemini-3.0-flash")
llm_with_tools = llm.bind_tools(tools)


# -------------------------------------------------------------------
# Node 정의
# -------------------------------------------------------------------

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


# -------------------------------------------------------------------
# Edge 조건
# -------------------------------------------------------------------

def should_continue(state: AgentState) -> str:
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tool"
    return END


# -------------------------------------------------------------------
# Graph 조립
# -------------------------------------------------------------------

def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tool", tool_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue, {"tool": "tool", END: END})
    graph.add_edge("tool", "agent")
    return graph.compile()


# -------------------------------------------------------------------
# 스트리밍 실행
# -------------------------------------------------------------------

def run_agent_stream(user_input: str, video_context: Optional[VideoContext] = None):
    graph = build_graph()

    initial_state: AgentState = {
        "messages": [HumanMessage(content=user_input)],
        "video_context": video_context,
        "edit_history": []
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


if __name__ == "__main__":
    run_agent_stream("sample.mp4 영상 정보 조회하고 10 + 25 계산해줘")
