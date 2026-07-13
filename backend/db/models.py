"""세션 로그 DB 스키마.

원칙:
- `sessions`   : 한 파이프라인 실행 단위 (WS 세션과 1:1). 상태 · 입력 영상.
- `messages`   : append-only 이벤트 로그. WS 로 흘려보낸 모든 것.
- `artifacts`  : final 산출물 스냅샷 (경로 · 길이 · scenes · transcript · critic).
- `interrupts` : script_approval 이벤트 원본 payload + 사용자 응답.

Supabase 로 이관 시 그대로 alembic revision 옮기면 됨. Column 은 postgres
JSONB / TEXT / TIMESTAMPTZ 만 써서 dialect 특화 X.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    # 인증 붙기 전 default. 이후 유저 로그인 붙으면 채움.
    user_id: Mapped[str] = mapped_column(
        String(64), nullable=False, default="default_user", index=True
    )
    video_paths: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="idle"
    )  # idle | streaming | awaiting-interrupt | completed | error
    # rolling summary — summary_node 가 주기적으로 채운다. 재접속 시 restore.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_message_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    meta: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    interrupts: Mapped[list["Interrupt"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )


class UserMemory(Base):
    """세션 간 이월되는 사용자 장기 기억.

    kind:
      - preference : 편집 선호 ("자막은 항상 위쪽")
      - style     : 스타일 방향성 ("Wes Anderson 느낌", "미니멀")
      - fact      : 사실 (프로젝트명 · 목표 · 채널 컨텍스트)
      - example   : 예시 (좋은 결과물 링크 · 참고 영상)

    weight: 프롬프트 주입 우선순위. remember 툴이 새로 쓰면 1.0 시작, 자주 참조되면 상승.
    last_used_at: 최근 사용 시각. 오래된 memory 는 자동 fade-out 가능.
    """

    __tablename__ = "user_memories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(
        String(64), nullable=False, default="default_user", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    weight: Mapped[float] = mapped_column(
        # 새 memory 는 1.0, 자주 참조되면 증가.
        # (Postgres FLOAT 는 DOUBLE PRECISION)
        # SA 는 Mapped[float] 을 자동으로 Float 매핑.
        Float, nullable=False, default=1.0
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    extra: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
    # kind: user | agent_message | tool_call | tool_result | phase | interrupt | final | info | error
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    node: Mapped[str | None] = mapped_column(String(64), nullable=True)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    tool_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    args: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    extra: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    session: Mapped["Session"] = relationship(back_populates="messages")


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    output_path: Mapped[str] = mapped_column(Text, nullable=False)
    output_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    critic: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    video_context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 향후 motion editor 스펙 (JSON) 도 여기 저장 예정.
    spec: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    session: Mapped["Session"] = relationship(back_populates="artifacts")


class Interrupt(Base):
    __tablename__ = "interrupts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    plan: Mapped[dict] = mapped_column(JSONB, nullable=False)
    questions: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # 사용자 응답 도착 시 update.
    approved: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    feedback: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    session: Mapped["Session"] = relationship(back_populates="interrupts")
