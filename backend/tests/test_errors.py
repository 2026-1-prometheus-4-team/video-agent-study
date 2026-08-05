"""LLM 오류 분류 테스트.

504 DEADLINE_EXCEEDED 가 어느 분류에도 안 걸려서 supervisor 전체가 3회
재실행되던 회귀를 막는다.
"""

from __future__ import annotations

import pytest

from agent.errors import (
    is_quota_error,
    is_terminal_error,
    is_transient_error,
    user_message_for,
)

# 실제 프로덕션에서 사용자에게 노출됐던 문자열.
REAL_504 = (
    "ServerError: 504 DEADLINE_EXCEEDED. {'error': {'code': 504, 'message': "
    "'The request timed out. Please try again.', 'status': 'DEADLINE_EXCEEDED'}}"
)


@pytest.mark.parametrize("text", [
    REAL_504,
    "ServerError: 503 Service Unavailable",
    "500 Internal Server Error",
    "The model is overloaded. Please try again later.",
    "httpx.RemoteProtocolError: Server disconnected without sending a response",
    "ReadTimeout: timed out",
])
def test_transient_errors_are_detected(text):
    assert is_transient_error(text)
    assert is_terminal_error(text), "일시 장애는 파이프라인 전체 재실행 대상이 아니다"


@pytest.mark.parametrize("text", [
    "ResourceExhausted: 429 quota exceeded",
    "Your credits are depleted",
])
def test_quota_errors_are_not_transient(text):
    assert is_quota_error(text)
    assert not is_transient_error(text), "쿼터는 재시도해도 결과가 같다"
    assert is_terminal_error(text)


@pytest.mark.parametrize("text", [
    "ValueError: clip duration 1500ms exceeds source",
    "FileNotFoundError: videos/missing_500.mp4",
    "ValidationError: field required",
])
def test_ordinary_errors_stay_retryable(text):
    """맨 숫자 매칭으로 무관한 오류를 일시 장애로 오분류하지 않는다."""
    assert not is_transient_error(text)
    assert not is_quota_error(text)
    assert not is_terminal_error(text)


def test_user_message_differs_by_cause():
    quota_msg = user_message_for("429 quota exceeded")
    transient_msg = user_message_for(REAL_504)
    other_msg = user_message_for("ValueError: bad path")

    assert "크레딧" in quota_msg
    assert "일시적" in transient_msg
    assert quota_msg != transient_msg != other_msg


def test_accepts_exception_objects():
    assert is_transient_error(RuntimeError(REAL_504))
    assert "일시적" in user_message_for(RuntimeError(REAL_504))
