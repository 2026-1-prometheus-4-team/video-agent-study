"""진행 카드(phase)가 실제로 실행되는 단계만 표시해야 한다.

실제 증상: ENABLE_TREND_RESEARCH 가 꺼져 있어 research_prepass 는 즉시
return 하는데도, 카드는 analysis 가 끝나는 순간 열려 다음 단계(기획)가 끝날
때까지 살아있었다. 사용자 화면에는 아무 일도 하지 않는 단계가
"트렌드 리서치 중 · 60s 경과" 로 떠 있었다.
"""

from __future__ import annotations

import importlib


def _reload_server(monkeypatch, *, enabled: bool):
    monkeypatch.setenv("ENABLE_TREND_RESEARCH", "true" if enabled else "false")
    import server

    return importlib.reload(server)


def test_research_card_is_skipped_when_disabled(monkeypatch):
    server = _reload_server(monkeypatch, enabled=False)

    assert server.TREND_RESEARCH_ENABLED is False
    assert server.NEXT_PHASE["analysis"] == "script", (
        "리서치가 꺼져 있으면 분석 다음은 기획이어야 한다"
    )


def test_research_card_is_shown_when_enabled(monkeypatch):
    server = _reload_server(monkeypatch, enabled=True)

    assert server.TREND_RESEARCH_ENABLED is True
    assert server.NEXT_PHASE["analysis"] == "research_prepass"


def test_flag_parsing_is_forgiving(monkeypatch):
    for raw, expected in (("TRUE", True), (" true ", True), ("1", False), ("", False)):
        monkeypatch.setenv("ENABLE_TREND_RESEARCH", raw)
        import server

        reloaded = importlib.reload(server)
        assert reloaded.TREND_RESEARCH_ENABLED is expected, raw


def test_remaining_phase_order_is_unchanged(monkeypatch):
    """리서치 외 단계 순서는 건드리지 않는다."""
    server = _reload_server(monkeypatch, enabled=False)

    assert server.NEXT_PHASE["research_prepass"] == "script"
    assert server.NEXT_PHASE["script"] is None
    assert server.NEXT_PHASE["supervisor"] == "critic"
    assert server.NEXT_PHASE["critic"] is None
