"""세션 리포지토리 — server.py 이벤트 지점에서 호출.

모든 write 는 실패 시 예외를 삼키고 로그만 남긴다 (스트리밍이 DB 장애로
멈추면 안 됨). 실 프로덕션에선 별도 큐 + 재시도 워커로 옮기는 게 정답.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, update

from .engine import get_session
from .models import Artifact, Interrupt, Message, Session, UserMemory

logger = logging.getLogger(__name__)


def _safe_json(v: Any) -> Any:
    """JSONB 저장 전에 non-serializable 을 str 로 강등."""
    try:
        import json

        json.dumps(v)
        return v
    except (TypeError, ValueError):
        return {"__non_json__": repr(v)}


class SessionRepo:
    """전역 static 헬퍼처럼 쓸 수 있게 classmethod 위주로.

    필요 시 request-scoped 로 확장 가능 (지금은 매 write 마다 새 AsyncSession).
    """

    @classmethod
    async def ensure_session(
        cls, session_id: str, video_paths: list[str], meta: Optional[dict] = None
    ) -> None:
        try:
            async with get_session() as db:
                existing = await db.get(Session, session_id)
                if existing:
                    existing.video_paths = list(video_paths)
                    if meta:
                        existing.meta = {**(existing.meta or {}), **meta}
                else:
                    db.add(
                        Session(
                            id=session_id,
                            video_paths=list(video_paths),
                            status="streaming",
                            meta=meta or {},
                        )
                    )
                await db.commit()
        except Exception:
            logger.exception("db.ensure_session failed (session_id=%s)", session_id)

    @classmethod
    async def set_session_status(cls, session_id: str, status: str) -> None:
        try:
            async with get_session() as db:
                await db.execute(
                    update(Session).where(Session.id == session_id).values(status=status)
                )
                await db.commit()
        except Exception:
            logger.exception("db.set_session_status failed (session_id=%s)", session_id)

    @classmethod
    async def log_event(
        cls,
        session_id: str,
        kind: str,
        *,
        node: Optional[str] = None,
        content: Optional[str] = None,
        tool_name: Optional[str] = None,
        args: Optional[dict] = None,
        result: Any = None,
        ok: Optional[bool] = None,
        detail: Optional[str] = None,
        extra: Optional[dict] = None,
    ) -> None:
        """모든 WS 이벤트 (send_json 직전) 를 여기로 흘려서 append-only 로그."""
        try:
            async with get_session() as db:
                # result 가 dict/list 가 아니면 dict 로 감싼다 (JSONB 필드는 obj 요구).
                result_json: Optional[dict]
                if result is None:
                    result_json = None
                elif isinstance(result, (dict, list)):
                    result_json = {"value": result} if isinstance(result, list) else result
                else:
                    result_json = {"value": _safe_json(result)}
                db.add(
                    Message(
                        session_id=session_id,
                        kind=kind,
                        node=node,
                        content=content,
                        tool_name=tool_name,
                        args=_safe_json(args) if args else None,
                        result=result_json,
                        ok=ok,
                        detail=detail,
                        extra=_safe_json(extra) if extra else None,
                    )
                )
                await db.commit()
        except Exception:
            logger.exception(
                "db.log_event failed (session_id=%s, kind=%s)", session_id, kind
            )

    @classmethod
    async def log_interrupt(
        cls,
        session_id: str,
        plan: dict,
        questions: list[str],
    ) -> Optional[int]:
        try:
            async with get_session() as db:
                obj = Interrupt(
                    session_id=session_id,
                    plan=_safe_json(plan),
                    questions=list(questions or []),
                )
                db.add(obj)
                await db.commit()
                await db.refresh(obj)
                return obj.id
        except Exception:
            logger.exception("db.log_interrupt failed (session_id=%s)", session_id)
            return None

    @classmethod
    async def resolve_interrupt(
        cls,
        session_id: str,
        *,
        approved: bool,
        feedback: Optional[str] = None,
    ) -> None:
        """가장 최근 미해결 interrupt 를 approved/feedback 으로 마감."""
        try:
            async with get_session() as db:
                stmt = (
                    select(Interrupt)
                    .where(
                        Interrupt.session_id == session_id,
                        Interrupt.resolved_at.is_(None),
                    )
                    .order_by(Interrupt.id.desc())
                    .limit(1)
                )
                obj = (await db.execute(stmt)).scalar_one_or_none()
                if obj:
                    obj.approved = approved
                    obj.feedback = feedback
                    obj.resolved_at = datetime.now(timezone.utc)
                    await db.commit()
        except Exception:
            logger.exception("db.resolve_interrupt failed (session_id=%s)", session_id)

    # ────────────────────────────────────────────
    # Summary (rolling conversation summary)
    # ────────────────────────────────────────────

    @classmethod
    async def get_summary(cls, session_id: str) -> tuple[Optional[str], int]:
        """(summary_text, summarized_message_count) 반환. 없으면 (None, 0)."""
        try:
            async with get_session() as db:
                row = await db.get(Session, session_id)
                if row is None:
                    return (None, 0)
                return (row.summary, row.summary_message_count or 0)
        except Exception:
            logger.exception("db.get_summary failed (session_id=%s)", session_id)
            return (None, 0)

    @classmethod
    async def update_summary(
        cls, session_id: str, summary: str, message_count: int
    ) -> None:
        try:
            async with get_session() as db:
                await db.execute(
                    update(Session)
                    .where(Session.id == session_id)
                    .values(summary=summary, summary_message_count=message_count)
                )
                await db.commit()
        except Exception:
            logger.exception("db.update_summary failed (session_id=%s)", session_id)

    # ────────────────────────────────────────────
    # User Memories (세션 간 이월)
    # ────────────────────────────────────────────

    @classmethod
    async def list_memories(
        cls, user_id: str = "default_user", limit: int = 20
    ) -> list[dict]:
        """weight * recency 기준 상위 memories. supervisor 프롬프트 주입용."""
        try:
            async with get_session() as db:
                stmt = (
                    select(UserMemory)
                    .where(UserMemory.user_id == user_id)
                    .order_by(UserMemory.weight.desc(), UserMemory.updated_at.desc())
                    .limit(limit)
                )
                rows = (await db.execute(stmt)).scalars().all()
                return [
                    {
                        "id": r.id,
                        "kind": r.kind,
                        "content": r.content,
                        "weight": r.weight,
                        "created_at": r.created_at.isoformat() if r.created_at else None,
                    }
                    for r in rows
                ]
        except Exception:
            logger.exception("db.list_memories failed (user=%s)", user_id)
            return []

    @classmethod
    async def add_memory(
        cls,
        user_id: str,
        kind: str,
        content: str,
        weight: float = 1.0,
        extra: Optional[dict] = None,
    ) -> Optional[int]:
        try:
            async with get_session() as db:
                # 같은 kind + content 있으면 weight 올리고 last_used 갱신.
                stmt = select(UserMemory).where(
                    UserMemory.user_id == user_id,
                    UserMemory.kind == kind,
                    UserMemory.content == content,
                )
                existing = (await db.execute(stmt)).scalar_one_or_none()
                if existing:
                    existing.weight = min(existing.weight + 0.3, 5.0)
                    existing.last_used_at = datetime.now(timezone.utc)
                    await db.commit()
                    return existing.id
                obj = UserMemory(
                    user_id=user_id,
                    kind=kind,
                    content=content,
                    weight=weight,
                    last_used_at=datetime.now(timezone.utc),
                    extra=_safe_json(extra) if extra else None,
                )
                db.add(obj)
                await db.commit()
                await db.refresh(obj)
                return obj.id
        except Exception:
            logger.exception(
                "db.add_memory failed (user=%s, kind=%s)", user_id, kind
            )
            return None

    @classmethod
    async def delete_memory(cls, memory_id: int, user_id: str = "default_user") -> bool:
        try:
            async with get_session() as db:
                obj = await db.get(UserMemory, memory_id)
                if obj is None or obj.user_id != user_id:
                    return False
                await db.delete(obj)
                await db.commit()
                return True
        except Exception:
            logger.exception("db.delete_memory failed (id=%s)", memory_id)
            return False

    @classmethod
    async def touch_memory(cls, memory_id: int) -> None:
        """memory 가 프롬프트에 실제 주입될 때 recency 갱신."""
        try:
            async with get_session() as db:
                await db.execute(
                    update(UserMemory)
                    .where(UserMemory.id == memory_id)
                    .values(last_used_at=datetime.now(timezone.utc))
                )
                await db.commit()
        except Exception:
            logger.exception("db.touch_memory failed (id=%s)", memory_id)

    @classmethod
    async def log_artifact(
        cls,
        session_id: str,
        *,
        output_path: str,
        output_url: Optional[str] = None,
        duration: Optional[float] = None,
        critic: Optional[dict] = None,
        video_context: Optional[dict] = None,
        spec: Optional[dict] = None,
    ) -> None:
        try:
            async with get_session() as db:
                db.add(
                    Artifact(
                        session_id=session_id,
                        output_path=output_path,
                        output_url=output_url,
                        duration=duration,
                        critic=_safe_json(critic) if critic else None,
                        video_context=_safe_json(video_context) if video_context else None,
                        spec=_safe_json(spec) if spec else None,
                    )
                )
                await db.commit()
        except Exception:
            logger.exception("db.log_artifact failed (session_id=%s)", session_id)
