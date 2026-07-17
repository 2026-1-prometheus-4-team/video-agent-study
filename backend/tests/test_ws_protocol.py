"""WS 프로토콜 헬퍼 테스트 — interrupt 대기 중 자유 채팅의 resume 변환."""

import pytest


@pytest.fixture(scope="module")
def server_mod():
    import server
    return server


class TestReplyToResume:
    def test_clarify_passes_reply_verbatim(self, server_mod):
        out = server_mod._reply_to_resume({"type": "clarify"}, "두번째 말고 세번째꺼")
        assert out == {"reply": "두번째 말고 세번째꺼"}

    def test_script_approval_assent(self, server_mod):
        for text in ["좋아", "응", "네", "이대로 진행해줘", "ok", "ㄱㄱ", "진행", "yes!"]:
            out = server_mod._reply_to_resume({"type": "script_approval"}, text)
            assert out == {"approved": True}, text

    def test_script_approval_compound_assent(self, server_mod):
        """'네 그렇게 해줘' 류 복합 승인도 승인으로 (재계획 유발 방지)."""
        for text in ["네 그렇게 해줘", "응 진행해줘", "그래 좋아", "오케이 고고",
                     "네, 진행해주세요", "좋아 그대로 해"]:
            out = server_mod._reply_to_resume({"type": "script_approval"}, text)
            assert out == {"approved": True}, text

    def test_script_approval_feedback(self, server_mod):
        """승인 토큰으로 시작해도 추가 요구가 붙으면 feedback (오승인 방지)."""
        for text in ["BGM 빼줘", "좋아 근데 자막은 노란색으로", "아니 다시",
                     "네 근데 30초로 줄여줘", "진행하되 BGM 은 빼고"]:
            out = server_mod._reply_to_resume({"type": "script_approval"}, text)
            assert out["approved"] is False and out["feedback"] == text, text

    def test_unknown_kind_defaults_to_script_approval(self, server_mod):
        out = server_mod._reply_to_resume(None, "자막 넣어줘")
        assert out["approved"] is False


class TestResumeFromPayload:
    def test_approved(self, server_mod):
        assert server_mod._resume_from_payload({"approved": True}) == {"approved": True}

    def test_rejected_with_feedback(self, server_mod):
        out = server_mod._resume_from_payload({"approved": False, "feedback": "수정"})
        assert out == {"approved": False, "feedback": "수정"}

    def test_clarify_reply_selected(self, server_mod):
        out = server_mod._resume_from_payload({"reply": "이거", "selected": [0, 2]})
        assert out == {"reply": "이거", "selected": [0, 2]}

    def test_selected_filters_non_numeric(self, server_mod):
        out = server_mod._resume_from_payload({"reply": "x", "selected": [1, "bad", 2.0]})
        assert out["selected"] == [1, 2]

    def test_empty_defaults_to_approved(self, server_mod):
        assert server_mod._resume_from_payload({}) == {"approved": True}
