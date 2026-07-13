"""사용자 장기 기억 툴.

Agent 가 대화에서 발견한 선호 · 스타일 · 프로젝트 문맥을 세션 간 이월시키기
위한 도구. 지금은 단일 사용자 (default_user) 이지만 auth 붙으면 user_id 로
확장 가능.

호출 규칙 (supervisor 프롬프트에 명시):
- 사용자가 "항상", "매번", "앞으로도" 같은 표현으로 선호 표명 시 `remember_preference`
- 프로젝트 · 채널 · 시리즈 이름 등 반복 참조될 문맥은 kind="fact"
- 오래됐거나 잘못 저장된 memory 는 `forget_memory` 로 제거

**Sync wrapper**: LangGraph @tool 데코레이터는 sync 함수도 async 도 지원.
DB 접근이 async 라 여기선 `asyncio.run` 으로 감싸지 말고 asyncio.get_event_loop
활용. 하지만 supervisor 는 이미 async 루프 안이니 asyncio.run 시 nested loop
에러. 대신 sync 접근용 SessionRepo wrapper 를 짧게 씀.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from langchain_core.tools import tool

from db import SessionRepo

logger = logging.getLogger(__name__)


_KIND_LITERALS = Literal["preference", "style", "fact", "example"]


def _run_async(coro):
    """이미 event loop 안 (LangGraph supervisor) 이면 그 loop 에서 실행,
    아니면 새 loop 만들어서 실행. asyncio.run 만 쓰면 nested loop 에러.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    # 이미 running loop → 새 스레드에서 별도 loop 로 실행
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


@tool
def remember_preference(
    kind: _KIND_LITERALS,
    content: str,
) -> str:
    """사용자의 장기 기억을 저장한다. 세션이 바뀌어도 이월된다.

    Args:
        kind: preference (편집 선호) / style (스타일 방향성) / fact (사실 · 프로젝트 문맥) / example (참고 예시)
        content: 저장할 자연어 문장. 짧게 · 구체적으로. 예: "자막은 항상 화면 상단"

    Returns:
        저장 결과 요약 문자열.
    """
    if not content or len(content.strip()) < 4:
        return "memory 저장 실패: content 가 너무 짧음"
    mid = _run_async(
        SessionRepo.add_memory(
            user_id="default_user",
            kind=kind,
            content=content.strip(),
        )
    )
    if mid is None:
        return "memory 저장 실패: DB 오류"
    return f"[memory#{mid}] {kind} · {content.strip()}"


@tool
def forget_memory(memory_id: int) -> str:
    """저장된 사용자 기억을 삭제한다.

    Args:
        memory_id: `remember_preference` 로 저장 시 반환된 id (예: memory#42 의 42).
    """
    ok = _run_async(SessionRepo.delete_memory(memory_id))
    return f"memory#{memory_id} 삭제 완료" if ok else f"memory#{memory_id} 삭제 실패 (없거나 권한 X)"


MEMORY_TOOLS = [remember_preference, forget_memory]
