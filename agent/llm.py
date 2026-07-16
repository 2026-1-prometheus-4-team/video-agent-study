"""
LLM 인스턴스 팩토리

역할별로 다른 모델을 쓸 수 있게 분리.
- supervisor / script / critic : Pro 모델 (reasoning, plan, 검증)
- sub-agent                    : Flash 모델 (tool 실행, 빠르고 저렴)

모델 교체 / 온도 조정 / cached_content 주입은 여기 한 곳만 만지면 됨.
"""

from __future__ import annotations

from typing import Optional

from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI

from agent import config

load_dotenv()


def make_llm(
    role: str = "supervisor",
    *,
    cached_content: Optional[str] = None,
    temperature: Optional[float] = None,
) -> ChatGoogleGenerativeAI:
    """역할별 ChatGoogleGenerativeAI 인스턴스 생성.

    Args:
        role: "supervisor" | "script" | "critic" | "sub_agent" 중 하나.
        cached_content: Gemini explicit CachedContent name (없으면 implicit caching).
        temperature: 명시적으로 override 하고 싶을 때.

    Note:
        Gemini 3+ 는 temperature 미지정 시 1.0 으로 강제됨.
        결정성 필요한 노드는 config 의 TEMPERATURE_* 사용.
    """
    role_map = {
        "supervisor": (config.MODEL_SUPERVISOR, config.TEMPERATURE_SUPERVISOR),
        "script":     (config.MODEL_SCRIPT,     config.TEMPERATURE_SCRIPT),
        "critic":     (config.MODEL_CRITIC,     config.TEMPERATURE_CRITIC),
        "sub_agent":  (config.MODEL_SUB_AGENT,  config.TEMPERATURE_SUB_AGENT),
    }
    if role not in role_map:
        raise ValueError(f"Unknown LLM role: {role}. Use one of {list(role_map)}.")

    model_name, default_temp = role_map[role]
    kwargs: dict = {
        "model": model_name,
        "temperature": temperature if temperature is not None else default_temp,
        # 일시적 서버 오류(503, RemoteProtocolError 등) 자동 재시도.
        # 서버가 응답 없이 끊는 경우가 있어 파이프라인 안정성을 위해 필수.
        "max_retries": 5,
        "timeout": 120,
    }
    if cached_content:
        kwargs["cached_content"] = cached_content

    # 역할별 API 키 분리 (무료 티어 쿼터가 키(프로젝트) 단위라 팀원 키로 분산 가능)
    # .env 에 GOOGLE_API_KEY_SUPERVISOR / _SCRIPT / _CRITIC / _SUB_AGENT 가 있으면
    # 해당 역할은 그 키를 사용, 없으면 기본 GOOGLE_API_KEY.
    import os
    role_key = os.getenv(f"GOOGLE_API_KEY_{role.upper()}")
    if role_key:
        kwargs["google_api_key"] = role_key

    return ChatGoogleGenerativeAI(**kwargs)


# 하위 호환: 기존 코드에서 `from agent.llm import llm` 으로 쓰는 곳 유지.
# 새 코드는 make_llm(role=...) 사용 권장.
llm = make_llm("supervisor")
