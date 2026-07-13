"""SQLAlchemy async engine · session maker.

DATABASE_URL 은 env 우선. 없으면 로컬 docker-compose 기본값 (postgres:5433).
"""

from __future__ import annotations

import logging
import os

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

logger = logging.getLogger(__name__)

DEFAULT_DB_URL = (
    "postgresql+asyncpg://video_agent:video_agent_dev@localhost:5433/video_agent"
)
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DB_URL)

# create_async_engine 는 lazy — 첫 쿼리 시 실제 커넥션.
_engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_recycle=300,
    pool_size=5,
    max_overflow=5,
)

_SessionMaker = async_sessionmaker(_engine, expire_on_commit=False)


def get_session() -> AsyncSession:
    """새 AsyncSession 생성. 호출자가 async-with 로 관리."""
    return _SessionMaker()


async def init_db() -> None:
    """부팅 시 실행. 테이블이 없으면 create_all 로 만들고, 있으면 idempotent
    ALTER 로 새 컬럼을 추가한다 (개발 편의). 프로덕션에선 alembic 사용.
    """
    from . import models  # noqa: F401  # metadata 등록

    from sqlalchemy import text

    from .models import Base

    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # 기존 sessions 테이블에 새 컬럼 idempotent 추가 (postgres 9.6+).
        await conn.execute(
            text(
                "ALTER TABLE sessions "
                "ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) NOT NULL DEFAULT 'default_user'"
            )
        )
        await conn.execute(
            text("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS summary TEXT")
        )
        await conn.execute(
            text(
                "ALTER TABLE sessions "
                "ADD COLUMN IF NOT EXISTS summary_message_count INTEGER NOT NULL DEFAULT 0"
            )
        )
        await conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions(user_id)")
        )
    logger.info("db: schema ensured (create_all + idempotent alters)")


async def dispose_db() -> None:
    await _engine.dispose()
