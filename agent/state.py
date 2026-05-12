<<<<<<< HEAD
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
=======
"""
도메인 타입 정의

VideoContext, Scene, Transcript 등 비디오 편집에 필요한 데이터 스키마.
create_supervisor / create_react_agent 가 내부 state 를 관리하므로
AgentState 는 더 이상 직접 정의하지 않음.
"""

from typing import Optional
from typing_extensions import TypedDict


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
>>>>>>> main
