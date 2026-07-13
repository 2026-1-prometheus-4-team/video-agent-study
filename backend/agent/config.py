"""
프로젝트 전역 설정

모델 alias / 캐시 정책 / sub-agent 제한 / workspace 경로.
하드코딩 대신 여기 한 곳에 모음. 팀원이 손볼 곳도 명확해짐.

OpenClaw 의 `system-prompt-cache-boundary.ts` + Claude Agent SDK 의
ClaudeAgentOptions 를 참고한 구조.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()


# =============================================================
# 경로
# =============================================================

PROJECT_ROOT: Path = Path(__file__).resolve().parent.parent
AGENT_DIR: Path = PROJECT_ROOT / "agent"
WORKSPACE_DIR: Path = AGENT_DIR / "workspace"
SUB_AGENT_DIR: Path = AGENT_DIR / "sub_agents"
ASSETS_DIR: Path = PROJECT_ROOT / "assets"
VIDEOS_DIR: Path = PROJECT_ROOT / "videos"


# =============================================================
# 모델 — gemini-2.5-flash 통일
#   비용 · 지연 · 품질 밸런스가 지금 파이프라인에 가장 좋음.
#   pro 계열은 안 씀 (요청당 비용 · 대기 시간이 커서 supervisor ReAct 루프에
#   맞지 않음). 특정 노드에서 필요 시 .env 로 개별 override 가능.
# =============================================================

MODEL_SUPERVISOR: str = os.getenv("MODEL_SUPERVISOR", "gemini-2.5-flash")
MODEL_SCRIPT: str = os.getenv("MODEL_SCRIPT", "gemini-2.5-flash")
MODEL_CRITIC: str = os.getenv("MODEL_CRITIC", "gemini-2.5-flash")
MODEL_SUB_AGENT: str = os.getenv("MODEL_SUB_AGENT", "gemini-2.5-flash")

# routing / plan 생성 등 결정성 필요한 노드는 명시적으로 낮추기.
TEMPERATURE_SUPERVISOR: float = 0.3
TEMPERATURE_SCRIPT: float = 0.4
TEMPERATURE_CRITIC: float = 0.2
TEMPERATURE_SUB_AGENT: float = 0.5


# =============================================================
# 캐시 정책
# =============================================================

# 시스템 프롬프트 stable / dynamic 구분 마커.
# OpenClaw 의 `<!-- OPENCLAW_CACHE_BOUNDARY -->` 와 동일한 발상.
# 위쪽: identity + governance + tools + analysis (캐시 히트 노림)
# 아래쪽: 세션 메모리 + 사용자 피드백 (매번 변함, 캐시 안 됨)
CACHE_BOUNDARY: str = "\n<!-- VIDEO_AGENT_CACHE_BOUNDARY -->\n"

# Gemini explicit cache 최소 토큰. 이보다 작으면 implicit caching 만 활용.
EXPLICIT_CACHE_MIN_TOKENS: int = 32_000

# Explicit cache TTL (seconds). 1 시간이 일반적.
EXPLICIT_CACHE_TTL_SECONDS: int = 3600


# =============================================================
# Sub-Agent 격리 정책 (OpenClaw ACP 패턴)
# =============================================================

@dataclass
class SubAgentLimits:
    """parent -> child spawn 시 적용되는 guardrail."""

    max_spawn_depth: int = 2
    """recursion 폭주 방지. parent 가 child 를, child 가 grandchild 를 부르는 깊이 제한."""

    max_children_per_agent: int = 5
    """동시 spawn 수 제한. 병렬 위임 비용 폭주 방지."""

    max_tool_calls_per_spawn: int = 12
    """child 안에서 도는 ReAct loop 최대 turn. infinite loop 가드."""

    inherit_allowlist_strict: bool = True
    """True 면 child 의 tool list 는 (parent allowlist) ∩ (child 자신의 group). False 면 union."""


SUB_AGENT_LIMITS = SubAgentLimits()


# =============================================================
# Sub-Agent 역할 -> tool group 매핑
# =============================================================

ROLE_TO_TOOL_GROUP: dict[str, str] = {
    "edit_expert": "edit",
    "audio_expert": "audio",
    "text_expert": "text",
    "effect_expert": "effect",
    "research_expert": "research",
}

# 사진의 5 agent. analysis 는 사전 preprocess 로 사용 (script 노드 진입 전).


# =============================================================
# Interrupt 정책
# =============================================================

@dataclass
class InterruptPolicy:
    """human-in-the-loop 게이트가 작동하는 위치."""

    gate_after_script: bool = True
    """script 6단계 계획 생성 후 사용자 승인 받기."""

    gate_before_destructive: bool = False
    """파일 덮어쓰기 등 위험 작업 직전 승인. (추후 활성화)"""


INTERRUPT_POLICY = InterruptPolicy()
