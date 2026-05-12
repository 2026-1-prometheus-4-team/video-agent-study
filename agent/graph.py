"""
LangGraph Supervisor + Sub-Agent 구조 (성민)

아키텍처:
    Supervisor (라우팅 + 파일 관리)
      -> Edit Agent    : cut, trim, merge, speed ...
      -> Audio Agent   : tts, stt, bgm, denoise ...
      -> Text Agent    : subtitle, caption, overlay ...
      -> Effect Agent  : fade, zoom, blur, transition ...
      -> Analysis Agent: scene detect, video info ...
      -> Research Agent: web search, trend ...

각 Sub-Agent 는 create_agent 로 생성 (내부 ReAct 루프 내장).
Supervisor 는 create_supervisor 로 생성 (handoff tool 자동 생성).
"""

import json
import logging
from typing import Optional

from langchain.agents import create_agent
from langgraph_supervisor import create_supervisor
from langgraph.checkpoint.memory import MemorySaver

from agent.llm import llm
from agent.tools import tool_groups
from agent.state import VideoContext

logger = logging.getLogger(__name__)


# =============================================================
# Supervisor prompt
# =============================================================

SUPERVISOR_PROMPT = """\
너는 영상 편집 에이전트 팀의 Supervisor 다.
사용자의 요청을 분석해서 적절한 전문가에게 작업을 위임하라.

팀 구성:
- edit_expert    : 영상 자르기, 붙이기, 속도 조절, 크롭 등 구조 편집
- audio_expert   : 음성 합성(TTS), 음성 인식(STT), BGM, 노이즈 제거
- text_expert    : 자막, 타이틀, 캡션, 텍스트 오버레이
- effect_expert  : 페이드, 줌, 블러, 색보정, 트랜지션
- analysis_expert: 장면 감지, 얼굴 인식, 영상 메타 정보 조회
- research_expert: 웹 검색, 트렌드 분석, 레퍼런스 수집

원칙:
1. 복합 요청은 의존 관계를 파악해서 순서대로 위임하라.
2. 독립적인 작업은 가능하면 병렬로 위임하라.
3. 불명확한 요청은 사용자에게 되물어라.
4. 위임 전 어떤 전문가에게 왜 보내는지 한 줄 설명하라.
"""


# =============================================================
# Sub-Agent 생성 (video_context 주입 가능)
# =============================================================

def _build_context_prefix(video_context: Optional[VideoContext]) -> str:
    """sub-agent system_prompt 앞에 붙일 영상 컨텍스트 문자열."""
    if not video_context:
        return ""
    return (
        f"현재 편집 중인 영상 정보:\n"
        f"- 파일: {video_context['file_path']}\n"
        f"- 길이: {video_context['duration']}초\n"
        f"- 장면 수: {len(video_context.get('scenes', []))}개\n"
        f"- 자막 수: {len(video_context.get('transcript', []))}개\n\n"
    )


def _create_agents(video_context: Optional[VideoContext] = None):
    """video_context 를 포함한 sub-agent 6개를 생성해서 반환."""
    ctx = _build_context_prefix(video_context)

    edit_agent = create_agent(
        model=llm,
        tools=tool_groups["edit"],
        name="edit_expert",
        system_prompt=(
            f"{ctx}"
            "너는 영상 구조 편집 전문가다. "
            "cut, trim, split, merge, speed, reverse, crop, resize 를 담당한다. "
            "tool 호출 시 정확한 타임스탬프(초 단위)를 사용하라."
        ),
    )

    audio_agent = create_agent(
        model=llm,
        tools=tool_groups["audio"],
        name="audio_expert",
        system_prompt=(
            f"{ctx}"
            "너는 오디오 전문가다. "
            "tts, stt(자막 추출), bgm, denoise, volume, voice clone 을 담당한다. "
            "음성 합성 시 자연스러운 한국어를 우선하라."
        ),
    )

    text_agent = create_agent(
        model=llm,
        tools=tool_groups["text"],
        name="text_expert",
        system_prompt=(
            f"{ctx}"
            "너는 텍스트/자막 전문가다. "
            "subtitle, title, caption, overlay 를 담당한다. "
            "가독성과 타이밍을 최우선으로 고려하라."
        ),
    )

    effect_agent = create_agent(
        model=llm,
        tools=tool_groups["effect"],
        name="effect_expert",
        system_prompt=(
            f"{ctx}"
            "너는 시각 이펙트 전문가다. "
            "fade, zoom, blur, color grade, transition 을 담당한다. "
            "효과가 영상 흐름을 방해하지 않도록 자연스럽게 적용하라."
        ),
    )

    analysis_agent = create_agent(
        model=llm,
        tools=tool_groups["analysis"],
        name="analysis_expert",
        system_prompt=(
            f"{ctx}"
            "너는 영상 분석 전문가다. "
            "scene detect, face detect, object track, video info 를 담당한다. "
            "분석 결과는 타임스탬프와 함께 구조화해서 반환하라."
        ),
    )

    research_agent = create_agent(
        model=llm,
        tools=tool_groups["research"],
        name="research_expert",
        system_prompt=(
            f"{ctx}"
            "너는 리서치 전문가다. "
            "web search, trend 분석, reference 검색을 담당한다. "
            "영상 편집에 도움이 되는 트렌드와 레퍼런스를 찾아 요약하라."
        ),
    )

    return [edit_agent, audio_agent, text_agent, effect_agent, analysis_agent, research_agent]


# =============================================================
# Graph 빌드
# =============================================================

def build_graph(video_context: Optional[VideoContext] = None, checkpointer=None):
    """Supervisor graph 를 빌드해서 반환한다.

    Args:
        video_context: 현재 편집 중인 영상 정보.
                       supervisor + 모든 sub-agent 에게 주입됨.
        checkpointer: LangGraph checkpointer (세션 대화 유지용).
                      None 이면 단발성 실행.
    """
    agents = _create_agents(video_context)

    prompt = SUPERVISOR_PROMPT
    if video_context:
        context_str = json.dumps(video_context, ensure_ascii=False, indent=2)
        prompt += f"\n현재 편집 중인 영상 정보:\n```json\n{context_str}\n```\n"

    workflow = create_supervisor(
        agents=agents,
        model=llm,
        prompt=prompt,
        output_mode="full_history",
    )

    return workflow.compile(checkpointer=checkpointer)


# =============================================================
# 실행 헬퍼
# =============================================================

def run_agent(user_input: str, video_context: Optional[VideoContext] = None):
    """단발성 실행 (테스트용)."""
    app = build_graph(video_context)

    result = app.invoke({
        "messages": [{"role": "user", "content": user_input}]
    })

    return result


def run_agent_stream(user_input: str, video_context: Optional[VideoContext] = None):
    """스트리밍 실행 (각 agent 단계별 출력)."""
    app = build_graph(video_context)

    print(f"\n[입력] {user_input}")
    print("-" * 60)

    for chunk in app.stream(
        {"messages": [{"role": "user", "content": user_input}]},
        stream_mode="updates",
    ):
        for node_name, state in chunk.items():
            print(f"\n>> [{node_name}]")
            if "messages" in state:
                for msg in state["messages"]:
                    if hasattr(msg, "content") and msg.content:
                        content = msg.content if isinstance(msg.content, str) else str(msg.content)
                        print(f"   {content[:200]}")
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            print(f"   -> tool: {tc['name']}({tc['args']})")

    print("\n" + "-" * 60)
