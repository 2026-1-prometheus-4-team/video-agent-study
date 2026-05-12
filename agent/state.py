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
