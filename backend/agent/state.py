"""
도메인 타입 정의 + LangGraph State

VideoContext, Scene, Transcript = 비디오 메타.
AgentState = 그래프 전체에서 전달되는 상태.

LangGraph 1.x 에서 State 는 dict-like TypedDict. 노드는 부분 dict 를 반환해서
state 를 patch 한다.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional
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


class ExecutionStep(TypedDict, total=False):
    """script_plan 의 한 step 이 실행된 결과."""
    step_id: int
    expert: str
    action: str
    status: str            # "ok" | "error" | "skipped"
    summary: str
    output_paths: list[str]
    duration_sec: float
    started_at: float


class ScriptPlan(TypedDict, total=False):
    """script_node 의 산출물 (사용자가 승인한 plan)."""
    target_format: str
    target_aspect_ratio: str
    target_duration_sec: Optional[float]
    steps: list[dict]
    tts_choice: Optional[dict]
    subtitle_style: Optional[dict]
    bgm_choice: Optional[dict]
    color_grade: Optional[str]
    questions: list[str]


class CriticVerdict(TypedDict, total=False):
    verdict: str  # "PASS" | "RETRY"
    issues: list[str]
    retry_from_step_id: Optional[int]
    message_to_user: str


class CandidateSegment(TypedDict, total=False):
    """clarify 질문에 첨부되는 후보 구간. 프론트가 클릭 -> 해당 시점 재생."""
    start_ms: int
    end_ms: int
    label: str
    score: Optional[float]


class PendingQuestion(TypedDict, total=False):
    """supervisor 가 실행 중 사용자에게 묻는 질문 (ask_user 툴 산출)."""
    question: str
    candidates: list[CandidateSegment]
    options: list[str]
    context: str
    """왜 묻는지 한 줄 (예: '가족 검색 신뢰도가 낮아 후보 확인 필요')."""


class AgentState(TypedDict, total=False):
    """그래프 전체 상태.

    LangGraph 1.x: 모든 노드가 이 dict 를 보고 partial dict 반환해서 patch.
    `messages` 는 reducer (add_messages) 로 누적 병합.
    """

    # ── 입력 ──
    user_request: str
    """사용자의 자연어 요청 원문."""

    video_paths: list[str]
    """원본 영상 경로들 (analysis 입력)."""

    # ── 메시지 (LangGraph 표준) ──
    messages: Annotated[list, add_messages]

    # ── 사전 분석 ──
    video_context: Optional[VideoContext]
    """analysis_node 가 채움. 이후 모든 노드의 stable prefix 일부."""

    # ── Script ──
    script_plan: Optional[ScriptPlan]
    """script_node 가 만들고 사용자 interrupt 게이트에서 승인됨."""

    script_feedback: Optional[str]
    """사용자가 plan 수정 요청 시 자연어 피드백. script_node 재호출 trigger."""

    script_revision: int
    """script 재생성 횟수. infinite loop 방지용."""

    # ── 실행 ──
    execution_trace: list[ExecutionStep]
    """sub-agent 호출 결과 누적."""

    # ── 실행 중 사용자 확인 (clarify 루프) ──
    pending_question: Optional[PendingQuestion]
    """supervisor 가 ask_user 로 멈춘 경우 질문 페이로드. clarify 노드가 소비."""

    clarify_answer: Optional[dict]
    """clarify interrupt 의 resume 값 {reply?, selected?, approved?}.
    supervisor 재진입 시 프롬프트에 주입 후 소거."""

    clarify_history: list[dict]
    """이번 턴의 Q&A 누적 [{question, answer}]. supervisor 재진입 프롬프트용."""

    # ── 최종 ──
    final_output_path: Optional[str]
    """완성된 영상 경로. critic 이 이걸 검증."""

    critic_verdict: Optional[CriticVerdict]

    critic_retries: int
    """critic 이 RETRY 를 낸 횟수. 무한 supervisor-critic 루프 방지용."""

    # ── 메타 ──
    session_id: str
    spawn_depth: int  # graph 진입 시 0

    # ── 메모리 · 컨텍스트 유지 ──
    conversation_summary: Optional[str]
    """long-term rolling summary. summary_node 가 채우고 이후 message 압축 근거."""

    summarized_up_to: int
    """이미 summary 에 흡수된 messages 수 (message trimming 용). 0 이면 압축 X."""

    user_memories: list[dict]
    """세션 시작 시 DB 에서 로드된 사용자 장기 기억.
    각 항목: {id, kind, content, weight}. supervisor 프롬프트에 주입."""
