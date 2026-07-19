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


class Scene(TypedDict, total=False):
    start: float
    end: float
    description: str
    video: str
    """다중 영상 입력 시 이 장면이 어느 영상 것인지 (예: videos/a.mp4).
    단일 영상이면 생략 — cut step 의 video_path 는 이 값을 그대로 써야 한다."""
    # 감정/내용 메타 — 분석 세그먼트에서 실어온다. 기획 단계의 "감정 비트 선별"
    # (렌치 실패 = 하이라이트, 먹방 = 힐링) 이 이 데이터에 의존한다.
    mood: str
    """calm | energetic | tense | neutral 중 하나 (analyze_video 산출)."""
    people_count: int
    people: list[str]
    actions: list[str]
    transcript: str
    """이 구간의 핵심 대사 요약 (byungkun transcript-integrated analysis)."""


class Transcript(TypedDict):
    start: float
    end: float
    text: str


class VideoContext(TypedDict, total=False):
    file_path: str
    duration: float
    scenes: list[Scene]
    transcript: list[Transcript]
    videos: list[dict]
    """다중 영상 입력 시 [{file_path, duration}, ...]. 단일 영상이면 생략."""


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


class TimelineSection(TypedDict, total=False):
    """기획안의 한 섹션 (Gemini 예시의 [00:00~05] 훅 같은 단위).

    사람이 읽는 기획(concept/timeline)과 기계 실행(steps)을 분리한다:
    timeline 은 사용자가 승인하는 서사, steps 는 그걸 실행하는 도구 호출.
    """
    index: int
    label: str
    """예: '훅', '플렉스 집들이', '대환장 파티 (하이라이트)'."""
    start_ms: int
    end_ms: int
    source_videos: list[str]
    """이 섹션이 쓰는 원본 영상 경로들 (교차편집이면 여러 개)."""
    transition: str
    """이전 섹션에서 넘어오는 전환 (hard_cut | crossfade | ...)."""
    subtitle_text: str
    """이 섹션에 얹을 자막 문구 (authored — 실제 한국어 라인)."""
    narration_text: str
    """이 섹션 나래이션/TTS 문구 (authored)."""
    sfx: str
    """효과음 설명 (예: '한숨 효과음', '띠로리 실패음')."""
    emphasis_note: str
    """왜 이 섹션이 중요한지 / 감정 포인트."""


class ConceptSpec(TypedDict, total=False):
    name: str
    """컨셉 이름 (예: '우당탕탕 복층 오피스텔 현실 이사 1일차')."""
    logline: str
    emotional_contrast: str
    """감정 대비 (예: '기대감 뿜뿜 새집 vs 우당탕탕 현실 이사')."""


class BgmCue(TypedDict, total=False):
    start_ms: int
    end_ms: int
    mood: str
    cue: str
    """왜 이 지점에서 이 음악인지 (예: '렌치 안 맞을 때 정적/개그')."""


class ScriptPlan(TypedDict, total=False):
    """script_node 의 산출물 (사용자가 승인한 plan).

    두 층위: (1) 사람이 읽고 승인하는 기획 — concept/timeline/bgm_progression/
    editing_tips/plan_markdown, (2) 기계가 실행하는 steps.
    """
    mode: str
    """edit | chat — chat 이면 reply 즉답."""
    reply: str

    # ── 기획 (사람이 읽는 층) ──
    concept: Optional[ConceptSpec]
    trend_elements: list[str]
    """리서치에서 뽑은 트렌드 요소 (예: '빠른 호흡 컷', '현실 공감 모먼트')."""
    timeline: list[TimelineSection]
    bgm_progression: list[BgmCue]
    """구간별 BGM 진행. 단일 bgm_choice 를 대체/보강."""
    editing_tips: list[str]
    """배속 / 화면분할 / 자막 폰트 같은 편집 팁."""
    references: list[dict]
    """트렌드 근거 [{title, url}]."""
    plan_markdown: str
    """컨셉+타임라인+스크립트+BGM+팁을 담은 한국어 마크다운 (프론트가 승인 카드에 렌더)."""

    # ── 실행 (기계 층) ──
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

    # ── 트렌드 리서치 (기획 이전 사전조사) ──
    trend_brief: Optional[dict]
    """research_prepass 가 채움. {niche, trend_elements:[..], named_concept,
    pacing_notes, bgm_progression, references:[{title,url}]}.
    script_node 프롬프트에 주입돼 컨셉/BGM/페이싱을 트렌드에 grounding 한다."""

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
