"""Gemini explicit cache 매니저 테스트 (오프라인, google.genai mock)."""

import time

import pytest


@pytest.fixture(autouse=True)
def _clear_registry():
    from agent import gemini_cache
    gemini_cache._REGISTRY.clear()
    yield
    gemini_cache._REGISTRY.clear()


def _long_prefix() -> str:
    # config.EXPLICIT_CACHE_MIN_TOKENS(2048) * 3자 이상 → 캐시 게이트 통과
    return "안정 prefix 내용 " * 3000


class TestGate:
    def test_short_prefix_skips_cache(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.setenv("GOOGLE_API_KEY", "k")
        assert gemini_cache.get_or_create("짧은 프롬프트", "gemini-2.5-flash") is None

    def test_disabled_returns_none(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.setenv("GEMINI_EXPLICIT_CACHE", "0")
        monkeypatch.setenv("GOOGLE_API_KEY", "k")
        assert gemini_cache.get_or_create(_long_prefix(), "gemini-2.5-flash") is None

    def test_no_api_key_returns_none(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
        monkeypatch.delenv("GOOGLE_API_KEY_SCRIPT", raising=False)
        assert gemini_cache.get_or_create(_long_prefix(), "gemini-2.5-flash") is None


class TestCreateAndReuse:
    def _patch_client(self, monkeypatch, calls):
        from google import genai

        class _Cache:
            name = "cachedContents/abc123"

        class _Caches:
            def create(self, **kw):
                calls.append(kw)
                return _Cache()

        class _Client:
            def __init__(self, **kw):
                self.caches = _Caches()

        monkeypatch.setattr(genai, "Client", _Client)

    def test_creates_then_reuses(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.setenv("GOOGLE_API_KEY", "k")
        calls: list = []
        self._patch_client(monkeypatch, calls)

        prefix = _long_prefix()
        n1 = gemini_cache.get_or_create(prefix, "gemini-2.5-flash", role="script")
        n2 = gemini_cache.get_or_create(prefix, "gemini-2.5-flash", role="script")
        assert n1 == "cachedContents/abc123" == n2
        # 같은 prefix -> create 는 한 번만 (재사용)
        assert len(calls) == 1
        # system_instruction 이 캐시에 담겼는지
        assert calls[0]["config"].system_instruction == prefix

    def test_different_prefix_creates_again(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.setenv("GOOGLE_API_KEY", "k")
        calls: list = []
        self._patch_client(monkeypatch, calls)
        gemini_cache.get_or_create(_long_prefix() + "A", "gemini-2.5-flash")
        gemini_cache.get_or_create(_long_prefix() + "B", "gemini-2.5-flash")
        assert len(calls) == 2

    def test_create_failure_returns_none(self, monkeypatch):
        from agent import gemini_cache
        from google import genai
        monkeypatch.setenv("GOOGLE_API_KEY", "k")

        class _Client:
            def __init__(self, **kw):
                raise RuntimeError("quota")

        monkeypatch.setattr(genai, "Client", _Client)
        assert gemini_cache.get_or_create(_long_prefix(), "gemini-2.5-flash") is None

    def test_invalidate_forces_recreate(self, monkeypatch):
        from agent import gemini_cache
        monkeypatch.setenv("GOOGLE_API_KEY", "k")
        calls: list = []
        self._patch_client(monkeypatch, calls)
        prefix = _long_prefix()
        name = gemini_cache.get_or_create(prefix, "gemini-2.5-flash")
        gemini_cache.invalidate(name)
        gemini_cache.get_or_create(prefix, "gemini-2.5-flash")
        assert len(calls) == 2  # invalidate 후 재생성


class TestSystemUserInvoke:
    def test_falls_back_to_inline_when_no_cache(self, monkeypatch):
        """캐시 None 이면 SystemMessage+HumanMessage 통째 invoke."""
        import agent.llm as llm_mod
        from agent import gemini_cache

        monkeypatch.setattr(gemini_cache, "get_or_create", lambda *a, **k: None)

        captured: dict = {}

        class _FakeLLM:
            def invoke(self, msgs):
                captured["msgs"] = msgs
                return type("M", (), {"content": "ok"})()

        monkeypatch.setattr(llm_mod, "make_llm", lambda *a, **k: _FakeLLM())
        out = llm_mod.system_user_invoke("script", "SYS", "USER")
        assert out.content == "ok"
        # 폴백 경로 = system + user 둘 다
        assert len(captured["msgs"]) == 2

    def test_uses_cache_when_available(self, monkeypatch):
        """캐시 있으면 HumanMessage 만 (system 은 캐시에)."""
        import agent.llm as llm_mod
        from agent import gemini_cache

        monkeypatch.setattr(gemini_cache, "get_or_create",
                            lambda *a, **k: "cachedContents/x")
        seen: dict = {}

        class _FakeLLM:
            def invoke(self, msgs):
                seen["msgs"] = msgs
                return type("M", (), {"content": "cached"})()

        def _make(role, **kw):
            seen["cached_content"] = kw.get("cached_content")
            return _FakeLLM()

        monkeypatch.setattr(llm_mod, "make_llm", _make)
        out = llm_mod.system_user_invoke("script", "SYS", "USER")
        assert out.content == "cached"
        assert seen["cached_content"] == "cachedContents/x"
        assert len(seen["msgs"]) == 1  # user 만
