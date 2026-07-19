"""Gemini explicit context caching 매니저.

문제: script/critic 노드의 system prompt 는 SOUL+AGENTS+TOOLS+분석JSON 으로
매 턴 ~15k~20k 토큰이 반복된다 (스크린샷 promptTokenCount 20850). CACHE_BOUNDARY
마커는 주석일 뿐 실제 캐싱을 안 한다 — implicit 캐싱도 히트 안 나고 있었다
(usageMetadata 에 cachedContentTokenCount 부재).

해법: 안정 prefix(system_instruction)를 Gemini CachedContent 로 한 번 만들어 두고
(client.caches.create), 이후 호출은 cached_content 이름만 참조해 동적 부분만 보낸다.
캐시된 토큰은 ~75% 할인. 세션 내 여러 턴/재생성이 같은 prefix 를 재사용한다.

안전 원칙:
- 캐시 생성/조회 실패(쿼터, 최소 토큰 미달, API 오류)는 조용히 None -> 호출자는
  기존 inline 프롬프트로 폴백. 파이프라인은 절대 안 깨진다.
- 프로세스 내 레지스트리로 (model, prefix-hash) 재사용. TTL 만료 시 재생성.
- API 키는 make_llm 과 동일 규칙 (역할 키 or GOOGLE_API_KEY).
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from typing import Optional

from agent import config

logger = logging.getLogger(__name__)

# (model, system_instruction 해시) -> {"name": cache_name, "expires_at": epoch}
_REGISTRY: dict[tuple[str, str], dict] = {}
_LOCK = threading.Lock()

# 만료 여유 (초). TTL 끝나기 직전 캐시를 쓰면 invoke 가 실패하므로 미리 폐기.
_EXPIRY_MARGIN = 120


def _enabled() -> bool:
    return os.getenv("GEMINI_EXPLICIT_CACHE", "1") != "0"


def _estimate_tokens(text: str) -> int:
    """대략적 토큰 수 (한/영 혼합 ~3자/토큰). 최소 토큰 게이트용 근사치."""
    return len(text) // 3


def _api_key(role: str) -> Optional[str]:
    return os.getenv(f"GOOGLE_API_KEY_{role.upper()}") or os.getenv("GOOGLE_API_KEY")


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def get_or_create(system_instruction: str, model: str, role: str = "script") -> Optional[str]:
    """system_instruction 을 담은 CachedContent 이름 반환. 실패 시 None.

    같은 (model, prefix) 는 TTL 동안 재사용. 최소 토큰 미달이면 캐싱 안 함
    (implicit 캐싱에 맡기고 None).
    """
    if not _enabled() or not system_instruction:
        return None
    if _estimate_tokens(system_instruction) < config.EXPLICIT_CACHE_MIN_TOKENS:
        return None

    key = (model, _hash(system_instruction))
    now = time.time()
    with _LOCK:
        entry = _REGISTRY.get(key)
        if entry and entry["expires_at"] - _EXPIRY_MARGIN > now:
            return entry["name"]

    api_key = _api_key(role)
    if not api_key:
        return None

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        ttl = config.EXPLICIT_CACHE_TTL_SECONDS
        cache = client.caches.create(
            model=model,
            config=types.CreateCachedContentConfig(
                display_name="video-agent-prefix",
                system_instruction=system_instruction,
                ttl=f"{ttl}s",
            ),
        )
        name = getattr(cache, "name", None)
        if not name:
            return None
        with _LOCK:
            _REGISTRY[key] = {"name": name, "expires_at": now + ttl}
        logger.info("gemini_cache: created %s (model=%s, ~%d tok)",
                    name, model, _estimate_tokens(system_instruction))
        return name
    except Exception:
        # 최소 토큰 미달 / 쿼터 / 미지원 모델 등 — 조용히 폴백
        logger.warning("gemini_cache: create 실패 -> inline 폴백", exc_info=True)
        return None


def invalidate(cache_name: str) -> None:
    """invoke 가 이 캐시로 실패(만료/무효)했을 때 레지스트리에서 제거."""
    with _LOCK:
        for key, entry in list(_REGISTRY.items()):
            if entry.get("name") == cache_name:
                del _REGISTRY[key]
