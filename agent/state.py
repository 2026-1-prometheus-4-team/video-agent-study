"""
공용 State 스키마
이 파일은 가급적 건드리지 말 것 (모든 모듈이 import 함)
"""

from typing import Annotated, Optional
from typing_extensions import TypedDict

from langgraph.graph.message import add_messages


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


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    video_context: Optional[VideoContext]
    edit_history: list[str]
