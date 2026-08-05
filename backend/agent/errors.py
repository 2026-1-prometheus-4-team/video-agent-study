"""LLM 호출 실패 분류.

supervisor / critic / sub_agent 세 곳이 각자 문자열 매칭으로 오류를 분류하고
있었고, 그 목록이 서로 달라서 같은 오류가 노드마다 다르게 처리됐다.
특히 504 DEADLINE_EXCEEDED 는 어느 목록에도 없어서 "정상 실패" 로 분류되어
supervisor 전체가 최대 3회 재실행됐다 (같은 타임아웃을 3번 반복).

분류 기준:
- quota    : 재시도해도 결과가 같다. 즉시 종료하고 키/결제를 안내.
- transient: 서버측 일시 장애. 짧은 재시도는 의미가 있지만, 전체 파이프라인
             재실행은 낭비다. 재시도 후에도 실패하면 계획을 보존한 채 종료.
- 그 외    : 코드/인자 문제일 수 있으므로 기존 RETRY 경로를 유지.
"""

from __future__ import annotations

_QUOTA_KEYS = (
    "resource_exhausted",
    "429",
    "quota",
    "credits are depleted",
)

# 연결이 끊기거나 서버가 제때 응답하지 못한 경우. 모두 재시도 가치가 있다.
# 상태 코드는 반드시 문맥과 함께 매칭한다 — 맨 숫자("500")로 매칭하면
# "duration 1500ms" 같은 무관한 오류 문자열까지 일시 장애로 오분류된다.
_TRANSIENT_KEYS = (
    # 연결 계열
    "remoteprotocolerror",
    "server disconnected",
    "readtimeout",
    "connecttimeout",
    "connectionerror",
    "connection reset",
    # 서버 계열 — 기존 목록에 빠져 있어 무한 RETRY 를 유발하던 값들
    "deadline_exceeded",
    "deadline exceeded",
    "504 deadline",
    "503 service",
    "500 internal",
    "unavailable",
    "overloaded",
    "internal server error",
)


def _lower(error: BaseException | str) -> str:
    if isinstance(error, BaseException):
        return f"{type(error).__name__}: {error}".lower()
    return str(error).lower()


def is_quota_error(error: BaseException | str) -> bool:
    """쿼터/크레딧 소진 — 재시도 무의미."""
    lowered = _lower(error)
    return any(key in lowered for key in _QUOTA_KEYS)


def is_transient_error(error: BaseException | str) -> bool:
    """일시적 서버/연결 장애 — 짧은 재시도는 의미 있음.

    quota 는 transient 가 아니다 (429 가 두 목록에 모두 걸리지 않도록 우선 배제).
    """
    if is_quota_error(error):
        return False
    lowered = _lower(error)
    return any(key in lowered for key in _TRANSIENT_KEYS)


def user_message_for(error: BaseException | str, *, stage: str = "실행") -> str:
    """사용자에게 보여줄 한국어 안내. 원인별로 다음 행동이 다르다."""
    text = f"{type(error).__name__}: {error}" if isinstance(error, BaseException) else str(error)

    if is_quota_error(error):
        return (
            "Gemini API 쿼터/크레딧이 소진돼서 중단했어. .env 의 "
            "GOOGLE_API_KEY_SUPERVISOR (또는 GOOGLE_API_KEY) 를 크레딧이 남은 키로 "
            "교체하거나 결제를 충전한 뒤 다시 요청해줘."
        )
    if is_transient_error(error):
        return (
            f"Gemini 서버가 일시적으로 응답하지 못해서 {stage}을 멈췄어 "
            "(자동 재시도도 실패). 승인된 계획은 그대로 남아 있으니 잠시 후 "
            "같은 요청을 다시 보내면 이어서 진행돼."
        )
    return f"{stage} 중 오류가 발생했어: {text[:200]} — 다시 시도해줘."


def is_terminal_error(error: BaseException | str) -> bool:
    """전체 파이프라인 재실행이 무의미한 오류인지.

    quota 는 결과가 바뀌지 않고, transient 는 이미 호출 지점에서 재시도를
    마친 뒤이므로 둘 다 supervisor 전체 재실행 대상이 아니다.
    """
    return is_quota_error(error) or is_transient_error(error)
