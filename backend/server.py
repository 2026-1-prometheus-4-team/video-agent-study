"""
FastAPI 서버 - Supervisor Agent + 세션 기반 대화

세션 흐름:
  1. POST /upload        → 영상 업로드, 서버 경로 반환
  2. POST /session       → 세션 생성 (video_paths 넘기면 분석 파이프라인 자동 시작)
  3. WS   /ws/chat/{id}  → 스트리밍 대화 (계획 승인 interrupt 포함)
  4. GET  /session/{id}  → 세션 정보 조회
  5. DELETE /session/{id} → 세션 종료

WebSocket 프로토콜:
  client → server:
    {"type": "chat", "message": "숏츠로 잘라줘"}     (legacy: {"message": "..."} 도 허용)
    {"type": "resume", "approved": true}              (script_approval 승인)
    {"type": "resume", "approved": false, "feedback": "BGM 빼줘"}  (계획 수정 요청)
    {"type": "resume", "reply": "두번째꺼", "selected": [1]}       (clarify 답변)
    {"type": "cancel"}                                (진행 중 턴 중지)
  server → client:
    {"type": "message",   "node": "...", "content": "..."}
    {"type": "tool_call", "node": "...", "tool_name": "...", "args": {...}}
    {"type": "interrupt", "payload": {...}}           ← resume 응답 대기. payload.type:
        "script_approval": {plan, questions, instructions}
        "clarify":         {question, candidates:[{start_ms,end_ms,label,score}],
                            options:[...], instructions}
    {"type": "phase",     "phase": "...", "state": "running|done", "label": "...", "detail": "..."}
    {"type": "video_context", "video_context": {...}}
    {"type": "final",     "output_path": "...", "output_url": "/files/outputs/...",
                          "video_context": {...}, "critic": {...}}
    {"type": "info",      "content": "..."}           (cancel 접수 / 큐잉 안내 등)
    {"type": "ping"}                                  (침묵 하트비트)
    {"type": "done"}                                  (턴 종료 — 세션은 계속 살아있음)
    {"type": "error",     "detail": "..."}

  상태 규칙:
    - interrupt 상태는 그래프 체크포인트에 보존됨 — 접속이 끊겨도 재접속하면
      서버가 interrupt 를 다시 보내주고, resume 을 그대로 이어받는다.
    - interrupt 대기 중 chat 은 거부되지 않고 kind 에 맞는 resume 으로 해석된다
      (script_approval: 승인 표현 → approved / 그 외 → feedback, clarify: reply).
    - 턴 실행 중 chat 은 최대 3개까지 큐잉 후 완료되는 대로 자동 실행.
    - 턴 실행 중 cancel 은 즉시 처리 (수신 루프가 실행과 분리돼 있음).
    - 새 결과물이 없는 turn 은 final 생략 (버전 중복 방지).
    - interrupt 로 멈춘 turn 은 done 없이 대기. 그 외엔 done 전송 (오류 포함).

Swagger UI: http://localhost:8000/docs
"""

import json
import logging
import re
import threading
import time
import uuid
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from agent import config as agent_config
from agent.graph import build_graph
from agent.state import VideoContext
from db import SessionRepo, dispose_db, init_db

logger = logging.getLogger("server")


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """앱 부팅 시 DB 스키마 확보, 종료 시 커넥션 해제."""
    try:
        await init_db()
    except Exception:
        logger.exception("db init 실패 — 세션 로그 없이 계속 진행")
    yield
    try:
        await dispose_db()
    except Exception:
        logger.exception("db dispose 실패")


app = FastAPI(
    title="Video Edit Agent API",
    description="Supervisor + Sub-Agent 구조의 영상 편집 에이전트 (세션 기반)",
    version="0.4.0",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",  # frontend/motion-editor (video agent studio)
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------------------------------------------------
# 정적 파일 서빙 (편집 결과물 / 입력 영상을 프론트에서 재생)
# -------------------------------------------------------------------

OUTPUTS_DIR = agent_config.PROJECT_ROOT / "outputs"
AUDIO_DIR = agent_config.PROJECT_ROOT / "audio_files"
BGM_DIR = agent_config.PROJECT_ROOT / "bgm_files"

for _dir in (OUTPUTS_DIR, AUDIO_DIR, BGM_DIR, agent_config.VIDEOS_DIR):
    _dir.mkdir(parents=True, exist_ok=True)

app.mount("/files/outputs", StaticFiles(directory=OUTPUTS_DIR), name="outputs")
app.mount("/files/videos", StaticFiles(directory=agent_config.VIDEOS_DIR), name="videos")
app.mount("/files/audio", StaticFiles(directory=AUDIO_DIR), name="audio")
app.mount("/files/bgm", StaticFiles(directory=BGM_DIR), name="bgm")

_FILE_URL_BASES = [
    (OUTPUTS_DIR, "/files/outputs"),
    (agent_config.VIDEOS_DIR, "/files/videos"),
    (AUDIO_DIR, "/files/audio"),
    (BGM_DIR, "/files/bgm"),
]


def _to_file_url(path_str: str) -> Optional[str]:
    """서버 파일 경로 → 프론트에서 접근 가능한 /files/* URL. 매핑 불가 시 None.

    supervisor 가 텍스트로 뱉는 경로(FINAL_OUTPUT: ...)는 형식이 제각각이라
    따옴표/백틱 제거 → 상대/절대 해석 → 최후엔 파일명으로 탐색까지 시도한다.
    """
    if not path_str:
        return None
    cleaned = path_str.strip().strip("`'\"*").strip()
    if not cleaned:
        return None
    p = Path(cleaned)
    if not p.is_absolute():
        p = (agent_config.PROJECT_ROOT / p).resolve()
    for base, prefix in _FILE_URL_BASES:
        try:
            rel = p.relative_to(base.resolve())
            return f"{prefix}/{rel.as_posix()}"
        except ValueError:
            continue
    # 매핑 실패 → 파일명만으로 서빙 디렉터리에서 탐색 (경로 형식이 어긋난 경우 회수)
    name = Path(cleaned).name
    if name:
        for base, prefix in _FILE_URL_BASES:
            candidate = base / name
            if candidate.exists():
                return f"{prefix}/{name}"
    return None


# -------------------------------------------------------------------
# 세션 저장소 (in-memory, 프로덕션에선 Redis 등으로 교체)
# -------------------------------------------------------------------

class Session:
    def __init__(
        self,
        session_id: str,
        video_context: Optional[VideoContext],
        video_paths: Optional[list[str]] = None,
    ):
        self.session_id = session_id
        self.video_context = video_context
        self.video_paths = video_paths or []
        self.checkpointer = MemorySaver()
        self.graph = build_graph(checkpointer=self.checkpointer)
        self.created_at = time.time()
        # 그래프 실행 직렬화 (WS+WS / WS+REST 동시 접근 시 checkpointer 경합 방지)
        self.run_lock = asyncio.Lock()
        # run_lock 은 await 로만 잡히므로 "task 생성 ~ 락 획득" 사이에 다른
        # 접속이 통과하는 창이 있다. busy 는 turn 시작 시 *동기적으로* 세워서
        # 그 창을 막는다 (같은 thread_id 에 그래프 2개가 붙는 것 = 체크포인트 손상).
        self.busy = False
        # 같은 결과를 turn 마다 반복 전송하지 않기 위한 dedupe
        self.last_final_sent = ""
        # 현재 turn 중지 요청 이벤트. `cancel` WS 메시지 도착 시 set.
        # 다음 chunk 경계에서 relay 루프가 즉시 종료. 진행 중 tool 은 자연 완료.
        self.turn_stop_event: Optional[threading.Event] = None
        # 실행 중 도착해 대기 중인 사용자 메시지. 세션에 두어야 접속이 끊겨도
        # 살아남고 재접속 후 이어서 실행된다.
        self.queued_chats: list[str] = []
        # 세션 시작 시 DB 에서 로드된 장기 기억 / 이전 세션 요약. graph_input 에 주입.
        self.user_memories: list[dict] = []
        self.conversation_summary: Optional[str] = None
        self.summarized_up_to: int = 0

    async def load_memory(self) -> None:
        """DB 에서 user_memories + 이 세션의 (재접속이면) summary 복원."""
        try:
            self.user_memories = await SessionRepo.list_memories(
                user_id="default_user", limit=20
            )
        except Exception:
            self.user_memories = []
        try:
            summary, up_to = await SessionRepo.get_summary(self.session_id)
            self.conversation_summary = summary
            self.summarized_up_to = up_to
        except Exception:
            pass

    @property
    def config(self) -> dict:
        return {"configurable": {"thread_id": self.session_id}}

    def pending_interrupt(self) -> Optional[dict]:
        """체크포인트에 남아 있는 미해결 interrupt payload. 없으면 None.

        interrupt 상태는 그래프 체크포인트에 살아 있으므로 WS 재접속 후에도
        여기서 복원해 승인(resume)을 이어갈 수 있다.
        """
        try:
            snapshot = self.graph.get_state(self.config)
        except Exception:
            return None
        for task in getattr(snapshot, "tasks", ()) or ():
            for intr in getattr(task, "interrupts", ()) or ():
                value = getattr(intr, "value", None)
                if value is not None:
                    return value
        return None


sessions: dict[str, Session] = {}


def _new_session_id() -> str:
    """충돌 없는 세션 id (uuid4 12자리 + 충돌 시 재생성)."""
    while True:
        sid = uuid.uuid4().hex[:12]
        if sid not in sessions:
            return sid


# -------------------------------------------------------------------
# Request / Response 스키마
# -------------------------------------------------------------------

class SceneSchema(BaseModel):
    start: float = Field(..., examples=[0.0])
    end: float = Field(..., examples=[10.0])
    description: str = Field(..., examples=["인트로 장면"])


class TranscriptSchema(BaseModel):
    start: float = Field(..., examples=[0.0])
    end: float = Field(..., examples=[5.0])
    text: str = Field(..., examples=["안녕하세요"])


class VideoContextSchema(BaseModel):
    file_path: str = Field(..., examples=["/videos/sample.mp4"])
    duration: float = Field(..., examples=[120.0])
    scenes: list[SceneSchema] = Field(default_factory=list)
    transcript: list[TranscriptSchema] = Field(default_factory=list)


class CreateSessionRequest(BaseModel):
    video_context: Optional[VideoContextSchema] = None
    video_paths: Optional[list[str]] = Field(
        default=None,
        description="서버 기준 영상 경로 (POST /upload 응답의 path). 넘기면 첫 대화에서 분석 파이프라인이 자동 실행됨.",
        examples=[["videos/sample.mp4"]],
    )

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"video_paths": ["videos/sample.mp4"]},
                {
                    "video_context": {
                        "file_path": "/videos/sample.mp4",
                        "duration": 120.0,
                        "scenes": [{"start": 0.0, "end": 10.0, "description": "인트로"}],
                        "transcript": [{"start": 0.0, "end": 5.0, "text": "안녕하세요"}],
                    }
                },
            ]
        }
    }


class CreateSessionResponse(BaseModel):
    session_id: str
    video_context: Optional[VideoContextSchema] = None
    video_paths: list[str] = Field(default_factory=list)


class UploadResponse(BaseModel):
    path: str = Field(..., description="세션 생성 시 video_paths 로 넘길 서버 기준 경로")
    url: str = Field(..., description="프론트에서 바로 재생 가능한 정적 URL")
    size: int


class ChatRequest(BaseModel):
    session_id: str = Field(..., examples=["session-id-here"])
    message: str = Field(..., examples=["3초에서 7초 구간 잘라줘"])


class AgentStep(BaseModel):
    node: str
    content: str = ""
    tool_calls: list[dict] = Field(default_factory=list)


class ChatResponse(BaseModel):
    answer: str
    steps: list[AgentStep]


# -------------------------------------------------------------------
# 유틸리티
# -------------------------------------------------------------------

def _extract_text(content) -> str:
    """AI message content 에서 텍스트만 추출.

    Gemini 는 content 를 list[dict] 로 반환할 수 있음:
      [{"type": "text", "text": "...", "extras": {...}}]
    """
    if not content:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif isinstance(block, str):
                parts.append(block)
        return " ".join(parts)
    return str(content)


def _jsonable(obj):
    """WebSocket 전송 전 JSON 직렬화 보장 (dataclass / Path 등은 str 로)."""
    return json.loads(json.dumps(obj, default=str, ensure_ascii=False))


def _build_graph_input(session: Session, user_message: str) -> dict:
    """유저 턴 → 그래프 초기 입력. None 값은 상태를 덮어쓰지 않도록 제외.

    memory · summary 는 이 함수 호출 전 async 로 미리 로드해서 session 에
    캐시해둔다 (`session.attach_memory`). checkpointer 가 있으므로 두 번째
    turn 부터는 이미 state 에 있음.
    """
    graph_input: dict = {
        "messages": [{"role": "user", "content": user_message}],
        "user_request": user_message,
        "execution_trace": [],
        "script_revision": 0,
        "spawn_depth": 0,
        "session_id": session.session_id,
        # 세션 누적 방지: critic RETRY 카운트는 턴 단위 개념 — 리셋 안 하면
        # 긴 세션에서 3회 누적 후 모든 턴이 즉시 강제 종료된다.
        "critic_retries": 0,
        # 이전 턴의 미소비 clarify 잔여물이 새 턴 라우팅을 오염시키지 않게.
        "pending_question": None,
        "clarify_answer": None,
        "clarify_history": [],
    }
    if session.video_paths:
        graph_input["video_paths"] = session.video_paths
    if session.video_context:
        graph_input["video_context"] = session.video_context
    # 세션 시작 시 로드된 memories · summary 를 state 에 주입.
    if getattr(session, "user_memories", None):
        graph_input["user_memories"] = session.user_memories
    if getattr(session, "conversation_summary", None):
        graph_input["conversation_summary"] = session.conversation_summary
    if getattr(session, "summarized_up_to", 0):
        graph_input["summarized_up_to"] = session.summarized_up_to
    return graph_input


# -------------------------------------------------------------------
# 업로드 엔드포인트
# -------------------------------------------------------------------

_SAFE_NAME_RE = re.compile(r"[^0-9A-Za-z가-힣._-]+")

# 업로드 가드: 영상 확장자만, 최대 2GB (디스크 고갈 방지)
ALLOWED_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024


@app.post("/upload", response_model=UploadResponse)
async def upload_video(file: UploadFile = File(...)):
    """영상 파일을 업로드한다. 반환된 path 를 POST /session 의 video_paths 로 사용."""
    raw_name = Path(file.filename or "upload.mp4").name
    safe_name = _SAFE_NAME_RE.sub("_", raw_name) or "upload.mp4"

    suffix_check = Path(safe_name).suffix.lower()
    if suffix_check not in ALLOWED_VIDEO_EXTS:
        raise HTTPException(
            status_code=415,
            detail=f"지원하지 않는 파일 형식입니다: {suffix_check or '(확장자 없음)'} — {', '.join(sorted(ALLOWED_VIDEO_EXTS))} 만 가능",
        )

    dest = agent_config.VIDEOS_DIR / safe_name
    stem, suffix = dest.stem, dest.suffix
    counter = 1
    while dest.exists():
        dest = agent_config.VIDEOS_DIR / f"{stem}_{counter}{suffix}"
        counter += 1

    size = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="파일이 2GB 를 초과합니다")
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    except Exception as exc:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"업로드 실패: {exc}")

    rel_path = f"videos/{dest.name}"
    return UploadResponse(path=rel_path, url=f"/files/videos/{dest.name}", size=size)


# -------------------------------------------------------------------
# 세션 관리 엔드포인트
# -------------------------------------------------------------------

@app.post("/session", response_model=CreateSessionResponse)
async def create_session(request: CreateSessionRequest):
    """새 편집 세션을 생성한다.

    video_paths 를 넘기면 첫 대화에서 분석(analysis) 파이프라인이 자동 실행되고,
    video_context 를 직접 넘기면 분석을 건너뛰고 그 컨텍스트를 사용한다.
    """
    session_id = _new_session_id()

    video_ctx: Optional[VideoContext] = None
    if request.video_context:
        video_ctx = request.video_context.model_dump()

    session = Session(
        session_id=session_id,
        video_context=video_ctx,
        video_paths=request.video_paths,
    )
    sessions[session_id] = session

    # DB 세션 로그 (비블로킹 — 실패해도 세션 자체는 성립)
    await SessionRepo.ensure_session(
        session_id,
        video_paths=list(request.video_paths or []),
        meta={"has_video_context": video_ctx is not None},
    )
    # 사용자 장기 기억 로드 (세션 간 이월). summary 는 새 세션이라 없음.
    await session.load_memory()

    return CreateSessionResponse(
        session_id=session_id,
        video_context=request.video_context,
        video_paths=request.video_paths or [],
    )


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """세션 정보를 조회한다. 그래프가 실행된 적 있으면 최종 상태 요약 포함."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")

    session = sessions[session_id]
    info = {
        "session_id": session_id,
        "video_context": session.video_context,
        "video_paths": session.video_paths,
    }

    try:
        snapshot = session.graph.get_state(session.config)
        values = snapshot.values or {}
        final_path = values.get("final_output_path", "")
        info["final_output_path"] = final_path
        info["final_output_url"] = _to_file_url(final_path)
        # 체크포인트의 video_context 는 analysis_node 가 쓴 *원본* 기준이고,
        # 편집 후 재분석 결과는 session.video_context 에만 반영된다 (_send_final).
        # 새로고침 복원 시 체크포인트 값을 쓰면 타임라인이 편집 전으로 되돌아간다.
        video_context = session.video_context or values.get("video_context")
        if isinstance(video_context, dict) and not video_context.get("transcript"):
            sidecar = _load_transcript_sidecar(session, final_path)
            if sidecar:
                video_context = {**video_context, "transcript": sidecar}
        if video_context:
            info["video_context"] = _jsonable(video_context)
    except Exception:
        pass

    # 미해결 계획 승인(interrupt) — 프론트가 재접속/새로고침 후 승인 UI 복원용
    pending = session.pending_interrupt()
    if pending is not None:
        info["pending_interrupt"] = _jsonable(pending)

    return info


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """세션을 종료한다."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")

    del sessions[session_id]
    return {"status": "deleted", "session_id": session_id}


# -------------------------------------------------------------------
# 채팅 엔드포인트 (세션 기반 연속 대화, blocking)
#   주의: interrupt 승인 게이트는 WS 전용. REST /chat 은 게이트에 걸리면
#   interrupt payload 를 answer 로 반환하고 멈춘다 (간단 테스트용).
# -------------------------------------------------------------------

@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """세션 내에서 에이전트와 대화한다.

    같은 session_id 로 여러 번 호출하면 대화가 이어진다.
    Supervisor 가 적절한 sub-agent 에게 작업을 위임하고 최종 응답을 반환.
    """
    if request.session_id not in sessions:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다. POST /session 으로 먼저 생성하세요.")

    session = sessions[request.session_id]
    if session.busy or session.run_lock.locked():
        raise HTTPException(status_code=409, detail="이미 실행 중인 작업이 있습니다.")
    if session.pending_interrupt() is not None:
        # 새 input 으로 그래프를 다시 돌리면 pending interrupt 가 조용히 버려지고
        # plan 이 재생성된다 (langgraph 1.x). REST 는 resume 불가 → 명시 안내.
        raise HTTPException(
            status_code=409,
            detail="승인 대기 중인 interrupt 가 있습니다. WebSocket(/ws/chat)으로 응답하세요.",
        )

    session.busy = True
    try:
        async with session.run_lock:
            result = await asyncio.to_thread(
                session.graph.invoke,
                _build_graph_input(session, request.message),
                config=session.config,
            )
    finally:
        session.busy = False

    steps = []
    answer = ""

    for msg in result.get("messages", []):
        if not hasattr(msg, "type"):
            continue

        msg_name = getattr(msg, "name", None) or "unknown"

        if msg.type == "ai":
            # content 파싱 (Gemini는 list[dict] 로 올 수 있음)
            text = _extract_text(msg.content)
            if text:
                answer = text

            # tool_calls 가 있으면 step 기록
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                steps.append(AgentStep(
                    node=msg_name,
                    tool_calls=[{"name": tc["name"], "args": tc["args"]} for tc in msg.tool_calls],
                ))

        elif msg.type == "tool":
            steps.append(AgentStep(
                node=msg_name,
                content=msg.content[:300] if msg.content else "",
            ))

    # interrupt 에 걸려 멈춘 경우 안내 (REST 로는 resume 불가)
    if not answer:
        try:
            snapshot = session.graph.get_state(session.config)
            if snapshot.next:
                answer = "계획 승인 대기 중입니다. WebSocket(/ws/chat)으로 접속해 승인을 진행하세요."
        except Exception:
            pass

    return ChatResponse(answer=answer, steps=steps)


# -------------------------------------------------------------------
# 단발성 엔드포인트 (세션 없이 한 번 실행)
# -------------------------------------------------------------------

class EditRequest(BaseModel):
    user_input: str = Field(..., examples=["이 영상의 정보를 알려줘"])
    video_context: Optional[VideoContextSchema] = None


class EditResponse(BaseModel):
    answer: str
    steps: list[AgentStep]


@app.post("/edit", response_model=EditResponse)
async def edit_video(request: EditRequest):
    """세션 없이 단발성으로 에이전트를 실행한다.

    대화가 이어지지 않음. 간단한 테스트용.
    """
    graph = build_graph()

    result = await asyncio.to_thread(
        graph.invoke,
        {"messages": [{"role": "user", "content": request.user_input}],
         "user_request": request.user_input},
    )

    steps = []
    answer = ""

    for msg in result.get("messages", []):
        if not hasattr(msg, "type"):
            continue

        msg_name = getattr(msg, "name", None) or "unknown"

        if msg.type == "ai":
            text = _extract_text(msg.content)
            if text:
                answer = text
            if hasattr(msg, "tool_calls") and msg.tool_calls:
                steps.append(AgentStep(
                    node=msg_name,
                    tool_calls=[{"name": tc["name"], "args": tc["args"]} for tc in msg.tool_calls],
                ))
        elif msg.type == "tool":
            steps.append(AgentStep(
                node=msg_name,
                content=msg.content[:300] if msg.content else "",
                ))

    return EditResponse(answer=answer, steps=steps)


# -------------------------------------------------------------------
# WebSocket 엔드포인트 (프론트엔드 스트리밍용)
# -------------------------------------------------------------------

# 채팅으로 흘려보내는 메시지 최대 길이 (supervisor 내부 프롬프트/JSON 덤프 억제)
MAX_RELAY_CHARS = 1500


# 프론트 rail 에 그리는 노드 진행 카드용 (label, detail).
# state="running" 시 표시할 텍스트. state="done" 시엔 완료 label 을 별도로 계산.
PHASE_RUNNING_TEXT: dict[str, tuple[str, str]] = {
    "analysis": (
        "영상 분석 중",
        "씬 감지 · Whisper 자막 · Gemini 시각 요약 (최대 60초)",
    ),
    "script": (
        "편집 계획 초안 준비 중",
        "타겟 포맷 · 편집 시나리오 · TTS/BGM 옵션 검토",
    ),
    "supervisor": (
        "전문가 실행 중",
        "승인된 계획대로 sub-agent 를 순차/병렬 spawn",
    ),
    "critic": (
        "결과 검증 중",
        "길이 · 프레임 · 자막 · 시나리오 부합 여부 확인",
    ),
    "reanalysis": (
        "편집본 재분석 중",
        "새 mp4 로 씬 · duration 재추출 (Timeline 실시간 갱신)",
    ),
}

# 어떤 노드가 끝나면 다음에 어떤 노드가 실행되는지. interrupt_gate 는 phase
# 이벤트가 아니라 interrupt 이벤트로 대체하므로 매핑에서 skip.
NEXT_PHASE: dict[str, Optional[str]] = {
    "analysis": "script",
    "script": None,   # 다음은 interrupt_gate → interrupt 이벤트가 대체
    "supervisor": "critic",
    "critic": None,
}


async def _emit_phase(
    ws: WebSocket,
    phase: str,
    state: str,
    label: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    payload: dict[str, Any] = {"type": "phase", "phase": phase, "state": state}
    if label is not None:
        payload["label"] = label
    if detail is not None:
        payload["detail"] = detail
    await ws.send_json(payload)


def _node_progress_text(node_name: str, state: dict) -> Optional[str]:
    """analysis / script / critic 처럼 messages 를 안 채우는 노드가 끝났을 때
    프론트 chat rail 에 흘릴 진행 메시지를 합성.

    Interrupt 이전 20~60초 침묵을 없애기 위한 UX 안전망. 노드 완료 시점의
    state 스냅샷에서 유의미한 요약을 뽑아 붙인다.
    """
    if node_name == "analysis":
        vc = state.get("video_context") or {}
        scenes = vc.get("scenes") or []
        transcript = vc.get("transcript") or []
        duration = vc.get("duration") or 0
        return (
            f"영상 분석 완료 · {int(duration)}초 · "
            f"{len(scenes)}씬 · {len(transcript)}개 자막 세그먼트"
        )
    if node_name == "script":
        plan = state.get("script_plan") or {}
        steps = plan.get("steps") or []
        target = plan.get("target_format") or "video"
        return f"편집 계획 초안 준비 완료 · {target} · {len(steps)}개 step"
    if node_name == "critic":
        verdict = state.get("critic_verdict") or {}
        v = verdict.get("verdict") or "OK"
        return f"결과 검증 완료 · {v}"
    if node_name == "supervisor":
        trace = state.get("execution_trace") or []
        ok = sum(1 for t in trace if t.get("status") == "ok")
        err = sum(1 for t in trace if t.get("status") == "error")
        return (
            f"전문가 실행 완료 · {ok}개 step 성공"
            + (f" · {err}개 실패" if err else "")
        )
    if node_name == "summary":
        return "대화 요약 저장"
    return None


async def _emit_and_log(
    websocket: WebSocket, session_id: str, payload: dict, log_kwargs: Optional[dict] = None
) -> None:
    """WS 로 이벤트 보내고 DB 에도 append. DB 실패는 삼킨다 (repo 내부에서 처리)."""
    await websocket.send_json(payload)
    if log_kwargs is not None:
        await SessionRepo.log_event(session_id, **log_kwargs)


async def _relay_stream(websocket: WebSocket, session: Session, stream_input) -> bool:
    """graph.stream 을 별도 스레드에서 돌리며 chunk 를 실시간 전송.

    interrupt 발생 시 {"type": "interrupt"} 를 보내고 True 반환. 정상 종료면 False.
    클라이언트가 중간에 끊기면 producer 에 stop 신호를 보내 push 를 멈춘다
    (진행 중인 그래프 turn 자체는 중단 불가 — 완료 후 스레드 종료).

    Phase 관리:
    - running_phase 단일 slot. 새 phase 시작 시 이전 것 자동 done.
    - Chunk 없는 침묵이 5초 넘으면 하트비트로 현재 phase label 갱신 (초 표시).
    """
    from langgraph.types import Command

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    # 정지 이벤트는 turn 시작 시점(_start_turn)에 이미 세션에 붙어 있다.
    # 여기서 새로 만들면 "chat 전송 ~ relay 진입" 사이의 cancel 이 유실된다.
    stop = session.turn_stop_event or threading.Event()
    session.turn_stop_event = stop
    if stop.is_set():
        # 시작 전에 이미 취소됨 — 그래프를 아예 돌리지 않는다.
        session.turn_stop_event = None
        await websocket.send_json({
            "type": "info", "content": "시작 전에 중지돼서 이번 요청은 실행하지 않았어.",
        })
        return {"interrupted": False, "cancelled": True, "errored": False}

    # ── 진입 phase 결정 (실제 그래프 흐름 반영) ──
    # video_context 있으면 analysis skip → script 부터. resume 이면 supervisor.
    # session.video_context 는 session 생성 시 값이라 stale 할 수 있음 →
    # 체크포인트에서 실제 state 를 봄.
    has_video_context = session.video_context is not None
    try:
        _snap = session.graph.get_state(session.config)
        if _snap and (_snap.values or {}).get("video_context"):
            has_video_context = True
    except Exception:
        pass
    if isinstance(stream_input, Command):
        # resume 값에 따라 실제 다음 노드가 다르다 — 계획 거부(approved=false)면
        # script 가 재생성되는데 "전문가 실행 중" 카드를 띄우면 오표시.
        resume_val = getattr(stream_input, "resume", None)
        rejected_plan = (
            isinstance(resume_val, dict)
            and resume_val.get("approved") is False
            and resume_val.get("reply") is None
        )
        initial_phase = "script" if rejected_plan else "supervisor"
    elif has_video_context:
        initial_phase = "script"
    else:
        initial_phase = "analysis"

    # running_phase 단일 slot. 새 phase 시작 시 이전 것 auto-close.
    running_phase: dict[str, Any] = {"name": None, "started": time.monotonic()}

    async def _start_phase(name: str) -> None:
        # 이전 running phase 자동 close.
        if running_phase["name"] and running_phase["name"] != name:
            await _emit_phase(websocket, running_phase["name"], "done")
        if name in PHASE_RUNNING_TEXT:
            lbl, dtl = PHASE_RUNNING_TEXT[name]
        else:
            lbl, dtl = ("에이전트 실행 중", f"{name} 노드")
        await _emit_phase(websocket, name, "running", lbl, dtl)
        await SessionRepo.log_event(
            session.session_id,
            kind="phase",
            node=name,
            content=lbl,
            detail=dtl,
            extra={"state": "running"},
        )
        running_phase["name"] = name
        running_phase["started"] = time.monotonic()

    async def _finish_phase(name: str, done_label: Optional[str] = None) -> None:
        if running_phase["name"] == name:
            running_phase["name"] = None
        await _emit_phase(websocket, name, "done", label=done_label)
        await SessionRepo.log_event(
            session.session_id,
            kind="phase",
            node=name,
            content=done_label or (PHASE_RUNNING_TEXT.get(name, ("완료", ""))[0]),
            extra={"state": "done"},
        )

    async def _close_any_running() -> None:
        if running_phase["name"]:
            await _emit_phase(websocket, running_phase["name"], "done")
            running_phase["name"] = None

    await _start_phase(initial_phase)

    # 그래프 스레드가 실제로 stream 을 빠져나왔는지 신호. cancel/끊김으로 relay 를
    # 먼저 접더라도 이 이벤트가 서기 전엔 다음 turn 을 시작하면 안 된다 —
    # 버려진 run 이 나중에 쓰는 체크포인트가 "최신"이 돼 새 turn 을 오염시킨다.
    producer_done = threading.Event()

    def _producer():
        try:
            for chunk in session.graph.stream(
                stream_input,
                config=session.config,
                stream_mode="updates",
            ):
                if stop.is_set():
                    break
                loop.call_soon_threadsafe(queue.put_nowait, ("chunk", chunk))
        except Exception as exc:
            if not stop.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, ("error", str(exc)))
        finally:
            producer_done.set()
            if not stop.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, ("end", None))

    threading.Thread(target=_producer, daemon=True).start()

    interrupted = False
    cancelled = False
    errored = False
    HEARTBEAT_SEC = 6.0
    try:
        while True:
            # 침묵 heartbeat — 실행 살아있음 표시 + 현재 phase label 갱신.
            try:
                kind, item = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SEC)
            except asyncio.TimeoutError:
                # cancel 체크 (heartbeat 주기 안에 cancel WS 도착했으면 즉시 종료)
                if stop.is_set():
                    cancelled = True
                    break
                if running_phase["name"]:
                    elapsed = int(time.monotonic() - running_phase["started"])
                    base_lbl = PHASE_RUNNING_TEXT.get(
                        running_phase["name"], ("실행 중", "")
                    )[0]
                    await _emit_phase(
                        websocket,
                        running_phase["name"],
                        "running",
                        label=f"{base_lbl} · {elapsed}s 경과",
                        detail=PHASE_RUNNING_TEXT.get(
                            running_phase["name"], ("", "")
                        )[1],
                    )
                else:
                    # running phase 없는 순간에도 프론트 watchdog 이 오해하지 않게
                    # 가벼운 ping. handleEvent 에서 unknown type 은 no-op.
                    await websocket.send_json({"type": "ping"})
                continue

            # 이벤트 도착 직후에도 cancel 체크 (사용자 중지 우선).
            if stop.is_set():
                cancelled = True
                break

            if kind == "end":
                await _close_any_running()
                break

            if kind == "error":
                errored = True
                await _close_any_running()
                await websocket.send_json({"type": "error", "detail": item})
                await SessionRepo.log_event(
                    session.session_id,
                    kind="error",
                    detail=str(item),
                )
                await SessionRepo.set_session_status(session.session_id, "error")
                break

            chunk = item
            # interrupt: 계획 승인 게이트 (agent/graph.py interrupt_gate)
            if "__interrupt__" in chunk:
                await _close_any_running()
                interrupts = chunk["__interrupt__"]
                payload = interrupts[0].value if interrupts else {}
                jsonable_payload = _jsonable(payload)
                await websocket.send_json({"type": "interrupt", "payload": jsonable_payload})
                # interrupts 테이블 + messages 테이블 둘 다 로그
                plan_dict = (
                    jsonable_payload.get("plan")
                    if isinstance(jsonable_payload, dict)
                    else None
                ) or {}
                questions = (
                    jsonable_payload.get("questions")
                    if isinstance(jsonable_payload, dict)
                    else None
                ) or []
                kind = (
                    jsonable_payload.get("type")
                    if isinstance(jsonable_payload, dict)
                    else None
                ) or "script_approval"
                await SessionRepo.log_interrupt(
                    session.session_id,
                    plan=plan_dict,
                    questions=questions,
                    kind=kind,
                    payload=jsonable_payload if isinstance(jsonable_payload, dict) else None,
                )
                await SessionRepo.log_event(
                    session.session_id,
                    kind="interrupt",
                    extra={"payload": jsonable_payload},
                )
                await SessionRepo.set_session_status(
                    session.session_id, "awaiting-interrupt"
                )
                interrupted = True
                continue

            for node_name, state in chunk.items():
                if not isinstance(state, dict):
                    continue

                # 방금 완료된 노드의 phase 카드를 done 으로 마감 + 다음 예상
                # 노드가 있으면 그 phase 카드를 running 으로 즉시 열어준다.
                # 사용자 rail 이 항상 살아있는 카드 하나 이상을 갖도록.
                progress = _node_progress_text(node_name, state)
                # 노드가 완료 chunk 를 뱉었다 = 그 노드가 방금 끝났다.
                # PHASE_RUNNING_TEXT 에 있는 노드만 phase 카드로 표시.
                if node_name in PHASE_RUNNING_TEXT:
                    await _finish_phase(node_name, done_label=progress)

                # analysis 노드 완료 즉시 video_context 를 프론트에 흘려서
                # Timeline 이 씬/자막 데이터를 실시간으로 채우게 함.
                # (final 이벤트 기다리지 않고 바로 반영)
                if node_name == "analysis":
                    vc = state.get("video_context")
                    if vc:
                        vc_payload = _jsonable(vc)
                        await websocket.send_json({
                            "type": "video_context",
                            "video_context": vc_payload,
                        })
                        # 세션 python attr 도 갱신 (initial_phase 판정용)
                        if isinstance(vc, dict):
                            session.video_context = vc
                        await SessionRepo.log_event(
                            session.session_id,
                            kind="video_context",
                            node="analysis",
                            extra={"scenes": len(vc.get("scenes") or []),
                                   "transcript": len(vc.get("transcript") or []),
                                   "duration": vc.get("duration")},
                        )
                # 다음 phase 시작 결정:
                # - critic 이 RETRY 면 supervisor 재실행 → supervisor phase 열기
                # - 그 외엔 NEXT_PHASE 매핑
                if node_name == "critic":
                    verdict = (state.get("critic_verdict") or {}).get("verdict")
                    if verdict == "RETRY":
                        await _start_phase("supervisor")
                elif node_name == "supervisor" and state.get("pending_question"):
                    # supervisor 가 사용자 질문(clarify)으로 멈춘 경우 —
                    # 다음은 critic 이 아니라 clarify interrupt 이벤트.
                    pass
                else:
                    nxt = NEXT_PHASE.get(node_name)
                    if nxt and nxt in PHASE_RUNNING_TEXT:
                        await _start_phase(nxt)

                if "messages" not in state:
                    continue

                for msg in state["messages"]:
                    content = _extract_text(getattr(msg, "content", None))
                    # ask_user 정지 신호는 내부 프로토콜 — 사용자에게 노출 X
                    # (곧이어 clarify interrupt 카드가 뜬다)
                    if content and content.strip() == "AWAITING_USER":
                        continue
                    if content:
                        if len(content) > MAX_RELAY_CHARS:
                            content = content[:MAX_RELAY_CHARS] + "\n… (이하 생략)"
                        await websocket.send_json({
                            "type": "message",
                            "node": node_name,
                            "content": content,
                        })
                        await SessionRepo.log_event(
                            session.session_id,
                            kind="agent_message",
                            node=node_name,
                            content=content,
                        )

                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            args = _jsonable(tc["args"])
                            await websocket.send_json({
                                "type": "tool_call",
                                "node": node_name,
                                "tool_name": tc["name"],
                                "args": args,
                            })
                            await SessionRepo.log_event(
                                session.session_id,
                                kind="tool_call",
                                node=node_name,
                                tool_name=tc["name"],
                                args=args if isinstance(args, dict) else {"value": args},
                            )
    except (WebSocketDisconnect, RuntimeError):
        # 클라이언트 끊김 — push 중단 신호 후 상위로 전파 (그래프 상태는 체크포인트에 보존)
        stop.set()
        raise
    finally:
        session.turn_stop_event = None
        # 그래프 스레드가 stream 을 완전히 빠져나올 때까지 대기. cancel/끊김으로
        # 여기 먼저 도달해도 마찬가지 — 락은 호출자(_run_turn)가 이 await 이후에
        # 놓으므로, 버려진 run 과 다음 run 이 같은 thread_id 에서 겹치지 않는다.
        # 진행 중이던 tool 이 끝나야 풀리므로 최대 수 분까지 걸릴 수 있다.
        await asyncio.to_thread(producer_done.wait)

    # cancel 처리 마감. running phase 정리 + 사용자 안내.
    if cancelled:
        await _close_any_running()
        await websocket.send_json({
            "type": "info",
            "content": "작업 중지 요청 수신 — 진행 중이던 도구 작업은 자연 완료 후 종료됐어. 새 지시를 내려도 돼.",
        })
        await SessionRepo.log_event(
            session.session_id,
            kind="cancel",
            content="사용자 중지 요청",
        )
        await SessionRepo.set_session_status(session.session_id, "cancelled")

    return {"interrupted": interrupted, "cancelled": cancelled, "errored": errored}


def _read_transcript_sidecar(sidecar: Path) -> list[dict]:
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception:
        return []

    cues = data.get("cues")
    if isinstance(cues, list) and cues:
        return [
            {
                "start": float(c.get("start", 0)),
                "end": float(c.get("end", 0)),
                "text": str(c.get("text", "")),
            }
            for c in cues
            if isinstance(c, dict)
        ]

    segments = data.get("segments")
    if isinstance(segments, list) and segments:
        return [
            {
                "start": float(s.get("start", 0)),
                "end": float(s.get("end", 0)),
                "text": str(s.get("text", "")),
            }
            for s in segments
            if isinstance(s, dict)
        ]
    return []


def _load_transcript_sidecar(
    session: Session,
    final_path: str = "",
) -> list[dict]:
    """transcribe(add_auto_subtitle)가 남긴 videos/subtitles/*.json 세그먼트 회수.

    그래프 state 의 video_context.transcript 는 sub-agent 내부에서만 채워지고
    상위 state 로 반영되지 않는다. 프론트가 자막을 텍스트 요소로 쓸 수 있게
    사이드카 파일에서 회수한다.

    후보 선정 규칙 (오염 방지):
      - 이 세션 입력 파일과 stem 이 같은 사이드카 (업로드 파일명은 중복 시
        _1 suffix 가 붙으므로 stem == 같은 소스 보장), 또는
      - 이 세션 시작 이후 생성된 사이드카 (컷 결과물을 전사한 경우 stem 이
        달라지므로 mtime 으로 커버)
    중 가장 최신 파일 하나.
    """
    subtitles_dir = agent_config.VIDEOS_DIR / "subtitles"
    if not subtitles_dir.is_dir():
        return []

    # 최종 산출물이 있으면 그 stem의 큐/전사만 먼저 본다. 세션 입력 원본의
    # 오래된 JSON을 최종 타임라인으로 오인하는 것을 막는다.
    if final_path:
        cleaned_final = final_path.strip().strip("`'\"*").strip()
        final_candidate = Path(cleaned_final)
        final_stem = final_candidate.stem
        for exact in (
            subtitles_dir / f"{final_stem}.cues.json",
            subtitles_dir / f"{final_stem}.json",
        ):
            if exact.exists():
                transcript = _read_transcript_sidecar(exact)
                if transcript:
                    return transcript

        # 자막 번인 전 결과라도 cut/merge origin이 있으면 원본 Whisper를 결과
        # 시간축으로 재구성할 수 있다. 최종 영상을 다시 전사하지 않는다.
        if not final_candidate.is_absolute():
            final_candidate = agent_config.PROJECT_ROOT / final_candidate
        try:
            from agent.tools.subtitle import _transcript_from_origin

            transcript = _transcript_from_origin(str(final_candidate.resolve()))
            if transcript:
                return transcript
        except Exception:
            logger.warning("final transcript origin reconstruction failed", exc_info=True)

        # 최종 stem과 origin 모두 없으면 입력 원본 JSON을 임의로 고르지 않는다.
        return []

    input_stems = {Path(vp).stem for vp in session.video_paths}
    candidates: list[tuple[float, Path]] = []
    for sidecar in subtitles_dir.glob("*.json"):
        try:
            mtime = sidecar.stat().st_mtime
        except OSError:
            continue
        # <stem>.cues.json 의 Path.stem 은 "<stem>.cues" 라 input_stems 매칭이
        # 안 된다 -> .cues 접미를 벗겨서 비교.
        base_stem = sidecar.stem
        if base_stem.endswith(".cues"):
            base_stem = base_stem[: -len(".cues")]
        if base_stem in input_stems or mtime >= session.created_at:
            candidates.append((mtime, sidecar))

    for _, sidecar in sorted(candidates, reverse=True):
        transcript = _read_transcript_sidecar(sidecar)
        if transcript:
            return transcript
    return []


def _reanalyze_output_sync(final_path: str) -> Optional[dict]:
    """편집본을 다시 분석해서 정확한 duration + scenes 로 video_context 구성.

    Gemini vision + pyscenedetect 기반 analyze_video 를 그대로 재사용.
    실패 시 None (호출자는 기존 video_context 로 fallback).

    이 함수는 blocking (~20~60s). asyncio.to_thread 로 감싸서 사용할 것.
    """
    try:
        import json as _json
        from pathlib import Path

        from agent import config as _cfg
        from agent.tools.video_analysis import analyze_video

        # 편집 툴 기본 출력은 outputs/ 라서 videos/ 로만 제한하면 표준 컷/머지
        # 결과가 전부 재분석에서 빠진다 → 프로젝트 루트 하위(videos/, outputs/)
        # 전체 허용. analyze_video 는 절대경로도 받도록 확장됨.
        p = Path(final_path.strip().strip("`'\"*").strip())
        if not p.is_absolute():
            candidate = (_cfg.PROJECT_ROOT / p).resolve()
        else:
            candidate = p.resolve()
        try:
            candidate.relative_to(_cfg.PROJECT_ROOT.resolve())
        except ValueError:
            logger.warning("reanalysis: %s is outside PROJECT_ROOT", candidate)
            return None
        if not candidate.exists():
            logger.warning("reanalysis: file not found %s", candidate)
            return None

        try:
            analyze_arg = str(candidate.relative_to(_cfg.VIDEOS_DIR.resolve()))
        except ValueError:
            analyze_arg = str(candidate)

        logger.info("reanalysis: %s (via analyze_video)", analyze_arg)
        raw = analyze_video.invoke({
            "video_path": analyze_arg,
            # 최종 편집본의 자막은 원본 Whisper + origin 타임라인으로 이미
            # 구성된다. 재분석에서 다시 전사하면 비용이 들고 TTS까지 섞인다.
            "use_transcript": False,
        })
        data = _json.loads(raw)
        if "error" in data:
            logger.warning("reanalysis: analyze_video 오류 - %s", data["error"])
            return None

        scenes = [
            {
                "start": seg["start_ms"] / 1000,
                "end": seg["end_ms"] / 1000,
                "description": seg.get("description", ""),
            }
            for seg in data.get("segments", [])
        ]
        return {
            "file_path": analyze_arg,
            "duration": data.get("duration", 0.0),
            "scenes": scenes,
            "transcript": [],  # 아래 _send_final 에서 사이드카로 보강
        }
    except Exception:
        logger.exception("reanalysis: unexpected failure")
        return None


async def _send_final(websocket: WebSocket, session: Session):
    """그래프 최종 상태에서 결과물 경로 / 컨텍스트를 뽑아 전송.

    이번 turn 에 새 결과물이 없으면 (직전과 동일 경로 / 빈 경로) final 을
    생략한다 — 같은 mp4 를 가리키는 버전 필이 turn 마다 늘어나는 것 방지.
    """
    try:
        snapshot = session.graph.get_state(session.config)
        values = snapshot.values or {}
    except Exception:
        values = {}

    final_path = values.get("final_output_path", "") or ""
    if not final_path or final_path == session.last_final_sent:
        return
    session.last_final_sent = final_path

    video_context = values.get("video_context")
    critic = values.get("critic_verdict")

    # ── 편집본 자동 재분석 ──
    # final_path 는 편집 결과 (원본 아님) 이므로 그래프 state 의 video_context
    # (원본 기준 duration · scenes) 을 그대로 프론트에 보내면 Timeline 이 어긋난다.
    # 여기서 편집본을 다시 analyze_video 로 돌려 정확한 duration/scenes 얻고
    # 자막은 사이드카에서 보강한다. 재분석 진행 중엔 phase 카드로 사용자 안내.
    await _emit_phase(
        websocket,
        "reanalysis",
        "running",
        PHASE_RUNNING_TEXT["reanalysis"][0],
        PHASE_RUNNING_TEXT["reanalysis"][1],
    )
    await SessionRepo.log_event(
        session.session_id,
        kind="phase",
        node="reanalysis",
        content=PHASE_RUNNING_TEXT["reanalysis"][0],
        detail=PHASE_RUNNING_TEXT["reanalysis"][1],
        extra={"state": "running"},
    )
    try:
        reanalyzed = await asyncio.to_thread(_reanalyze_output_sync, final_path)
    except Exception:
        logger.exception("reanalysis: to_thread failed")
        reanalyzed = None

    if reanalyzed:
        # 사이드카 자막이 있으면 보강 (transcribe/add_auto_subtitle 산출물).
        if not reanalyzed.get("transcript"):
            sidecar = _load_transcript_sidecar(session, final_path)
            if sidecar:
                reanalyzed["transcript"] = sidecar
        video_context = reanalyzed
        # 프론트 Timeline 이 즉시 새 데이터로 재구성하도록 video_context 이벤트
        # 별도 emit (final 이벤트 앞).
        await websocket.send_json({
            "type": "video_context",
            "video_context": _jsonable(video_context),
        })
        await SessionRepo.log_event(
            session.session_id,
            kind="video_context",
            node="reanalysis",
            extra={
                "scenes": len(video_context.get("scenes") or []),
                "duration": video_context.get("duration"),
            },
        )
        # 세션 python attr 도 갱신 (다음 turn 의 initial_phase 판정용)
        session.video_context = video_context
    else:
        # 재분석 실패 → 기존 video_context 유지 + 사이드카 자막 보강
        if isinstance(video_context, dict) and not video_context.get("transcript"):
            sidecar = _load_transcript_sidecar(session, final_path)
            if sidecar:
                video_context = {**video_context, "transcript": sidecar}

    await _emit_phase(
        websocket,
        "reanalysis",
        "done",
        label=(
            f"편집본 재분석 완료 · {len((video_context or {}).get('scenes') or [])}씬"
            if reanalyzed
            else "편집본 재분석 실패 (기존 데이터 유지)"
        ),
    )
    await SessionRepo.log_event(
        session.session_id,
        kind="phase",
        node="reanalysis",
        extra={"state": "done", "ok": reanalyzed is not None},
    )

    output_url = _to_file_url(final_path)
    vc_json = _jsonable(video_context) if video_context else None
    critic_json = _jsonable(critic) if critic else None
    await websocket.send_json({
        "type": "final",
        "output_path": final_path,
        "output_url": output_url,
        "video_context": vc_json,
        "critic": critic_json,
    })
    # DB 저장: artifacts + messages(final)
    await SessionRepo.log_artifact(
        session.session_id,
        output_path=final_path,
        output_url=output_url,
        duration=(vc_json or {}).get("duration") if isinstance(vc_json, dict) else None,
        critic=critic_json if isinstance(critic_json, dict) else None,
        video_context=vc_json if isinstance(vc_json, dict) else None,
    )
    await SessionRepo.log_event(
        session.session_id,
        kind="final",
        content=final_path,
        extra={"output_url": output_url},
    )
    await SessionRepo.set_session_status(session.session_id, "completed")


async def _run_turn(websocket: WebSocket, session: Session, stream_input) -> None:
    """한 번의 그래프 실행 세그먼트. interrupt 로 멈추면 클라이언트의 다음
    메시지(resume)가 top-level 루프에서 이어받는다 — 접속이 끊겨도 interrupt
    상태는 체크포인트에 남아 재접속 후 복원/승인 가능.

    이 함수 안에서 발생하는 예외는 (연결 끊김 제외) 전부 error 이벤트로
    변환하고 done 까지 보낸다 — 어떤 턴 오류도 WS/세션을 죽이면 안 된다.
    """
    try:
        # 락은 _relay_stream (그래프 스레드 종료 대기 포함) + _send_final +
        # summary persist 전체를 감싼다. _send_final 은 20~60초 재분석을
        # 돌리는데, 그동안 락이 풀려 있으면 REST /chat 이나 두 번째 접속이
        # 같은 thread_id 에 그래프를 하나 더 붙일 수 있다.
        async with session.run_lock:
            outcome = await _relay_stream(websocket, session, stream_input)
            if outcome["interrupted"]:
                return
            # 중지/오류로 끝난 turn 은 결과물 확정 단계를 건너뛴다 —
            # 중단된 실행의 부분 산출물을 최종본으로 승격시키면 안 된다.
            if outcome["cancelled"] or outcome["errored"]:
                await websocket.send_json({"type": "done"})
                return
            await _send_final(websocket, session)
            # rolling summary 가 이번 turn 에 갱신됐으면 DB persist (재접속 후 복원용).
            try:
                snapshot = session.graph.get_state(session.config)
                values = snapshot.values or {}
                new_summary = values.get("conversation_summary")
                up_to = values.get("summarized_up_to") or 0
                if new_summary and new_summary != session.conversation_summary:
                    await SessionRepo.update_summary(
                        session.session_id, new_summary, up_to
                    )
                    session.conversation_summary = new_summary
                    session.summarized_up_to = up_to
                    await websocket.send_json({
                        "type": "message",
                        "node": "orchestrator",
                        "content": f"[대화 요약 업데이트] {len(new_summary)}자",
                    })
            except Exception:
                logger.exception("summary persist failed")
    except (WebSocketDisconnect, RuntimeError):
        raise
    except Exception as exc:
        logger.exception("turn failed")
        try:
            await websocket.send_json({
                "type": "error",
                "detail": f"턴 처리 중 오류: {type(exc).__name__}: {exc}",
            })
            await SessionRepo.log_event(
                session.session_id, kind="error", detail=str(exc)
            )
            await SessionRepo.set_session_status(session.session_id, "error")
        except Exception:
            raise WebSocketDisconnect() from exc
    await websocket.send_json({"type": "done"})


# 자유 채팅이 interrupt 응답으로 들어왔을 때의 승인 표현 휴리스틱.
# 확신 없는 문장은 전부 feedback 으로 — 오승인(잘못된 plan 실행)이 더 위험하다.
# 승인 토큰만으로 이뤄진 문장만 통과 ("좋아 근데 자막은 노랗게" 는 feedback).
# 주의: 정규식 alternation 은 왼쪽 우선 매치라 *긴 표현을 먼저* 둬야 한다.
# ("진행" 이 앞에 있으면 "진행해주세요" 가 "진행" 만 먹고 나머지에서 실패)
_ASSENT_TOKEN = (
    r"(?:진행해주세요|진행해줘|진행하자|진행시켜|진행해|진행"
    r"|승인할게|승인|해주세요|해줘|하자|해"
    r"|시작해줘|시작해|시작"
    r"|이대로|그대로|그렇게|그래요|그래+"
    r"|좋아요|좋아+|좋지|맞습니다|맞아요|맞아+"
    r"|오케이|오키|굿|콜|고고|가즈아|가자"
    r"|응+|어+|네+|넵|예스|예|ㄱ+"
    r"|okay|ok|yes|yep|yeah|go|lgtm|approved|approve|proceed|sure)"
)
_ASSENT_RE = re.compile(
    # "네 그렇게 해줘", "응 진행해줘" 처럼 승인 토큰이 이어지는 형태까지 허용
    rf"^{_ASSENT_TOKEN}(?:[\s,.!?~ㅋㅎ]+{_ASSENT_TOKEN})*[\s.!?~ㅋㅎ]*$",
    re.I,
)


def _reply_to_resume(pending_payload: Optional[dict], message: str) -> dict:
    """interrupt 대기 중 도착한 자유 채팅을 kind 에 맞는 resume 값으로 변환.

    - clarify: 원문 그대로 reply 로 전달 (해석은 supervisor LLM 몫)
    - script_approval: 명백한 승인 표현이면 approved, 그 외엔 feedback
    """
    kind = (pending_payload or {}).get("type") or "script_approval"
    text = (message or "").strip()
    if kind == "clarify":
        return {"reply": text}
    if _ASSENT_RE.match(text):
        return {"approved": True}
    return {"approved": False, "feedback": text}


def _resume_from_payload(payload: dict) -> dict:
    """{type:"resume"} WS 메시지 → Command(resume=...) 값.

    지원 필드: approved(bool), feedback(str), reply(str), selected(list[int]).
    clarify 카드 응답은 reply/selected 만 올 수도 있다.
    """
    resume: dict = {}
    if "approved" in payload:
        resume["approved"] = bool(payload.get("approved"))
        if not resume["approved"]:
            resume["feedback"] = payload.get("feedback", "") or ""
    if payload.get("reply") is not None:
        resume["reply"] = str(payload.get("reply"))
    if isinstance(payload.get("selected"), list):
        resume["selected"] = [
            int(i) for i in payload["selected"] if isinstance(i, (int, float))
        ]
    if not resume:
        resume = {"approved": True}
    return resume


@app.websocket("/ws/chat/{session_id}")
async def chat_stream(websocket: WebSocket, session_id: str):
    """세션 기반 WebSocket 스트리밍. 프로토콜은 파일 상단 docstring 참고.

    수신 루프와 턴 실행을 분리 실행:
    - 턴 실행 중에도 cancel 이 즉시 먹힌다 (같은 소켓에서).
    - 턴 실행 중 chat 은 큐잉 후 완료되는 대로 자동 실행 (최대 3개).
    - interrupt 대기 중 chat 은 거부하지 않고 kind 에 맞는 resume 으로 변환.
    """
    await websocket.accept()

    if session_id not in sessions:
        # accept 후 close 해야 브라우저가 close code 를 읽을 수 있음 (accept 전엔 HTTP 403)
        await websocket.close(code=4004, reason="세션을 찾을 수 없습니다")
        return

    session = sessions[session_id]

    # 재접속 복원: 미해결 계획 승인이 남아 있으면 다시 보여준다
    pending = session.pending_interrupt()
    if pending is not None:
        await websocket.send_json({"type": "interrupt", "payload": _jsonable(pending)})
    elif session.queued_chats and not session.busy:
        # 이전 접속에서 대기하다 끊긴 요청 — 재접속 시 이어서 알려준다.
        await websocket.send_json({
            "type": "info",
            "content": f"대기 중인 요청 {len(session.queued_chats)}건이 있어. 곧 이어서 실행할게.",
        })

    turn_task: Optional[asyncio.Task] = None
    recv_task: Optional[asyncio.Task] = None
    MAX_QUEUED = 3

    def _turn_running() -> bool:
        return turn_task is not None and not turn_task.done()

    def _start_turn(stream_input) -> None:
        """turn 시작. busy / stop_event 를 *동기적으로* 세워서 락 획득 전 창을 막는다.

        정지 이벤트를 여기서 만들어야 "요청 보내자마자 stop" 이 유실되지 않는다
        (relay 진입 전엔 세션에 이벤트가 없어 cancel 이 '진행 중 없음' 이 됨).
        """
        nonlocal turn_task
        session.busy = True
        session.turn_stop_event = threading.Event()
        turn_task = asyncio.create_task(_run_turn(websocket, session, stream_input))
        turn_task.add_done_callback(lambda _t: setattr(session, "busy", False))

    async def _start_resume(resume_value: dict) -> None:
        # clarify 답변은 승인/거부가 아니다 — approved 를 임의로 True 로 적으면
        # interrupts 테이블이 "전부 승인됨" 으로 오염된다 (컬럼은 nullable).
        approved = resume_value.get("approved")
        answer_text = resume_value.get("feedback") or resume_value.get("reply")
        await SessionRepo.resolve_interrupt(
            session_id,
            approved=bool(approved) if approved is not None else None,
            feedback=answer_text,
        )
        await SessionRepo.log_event(
            session_id,
            kind="resume",
            ok=approved,
            content=answer_text,
            extra={"resume": _jsonable(resume_value)},
        )
        _start_turn(Command(resume=resume_value))

    async def _drain_queue() -> None:
        """대기 중인 요청이 있고 실행 가능하면 다음 하나를 시작.

        interrupt 대기 중엔 보류 (resume 이 먼저), 다른 접속이 실행 중이어도 보류.
        """
        if _turn_running() or session.busy:
            return
        if not session.queued_chats or session.pending_interrupt() is not None:
            return
        next_msg = session.queued_chats.pop(0)
        await websocket.send_json({
            "type": "info",
            "content": f"대기 중이던 요청 시작: {next_msg[:80]}",
        })
        _start_turn(_build_graph_input(session, next_msg))

    try:
        # 이전 접속에서 끊기며 남은 대기 요청 이어받기
        await _drain_queue()
        while True:
            if recv_task is None:
                recv_task = asyncio.create_task(websocket.receive_text())
            wait_set: set = {recv_task}
            if turn_task is not None:
                wait_set.add(turn_task)
            await asyncio.wait(wait_set, return_when=asyncio.FIRST_COMPLETED)

            # ── 1) 턴 종료 처리 ──
            if turn_task is not None and turn_task.done():
                exc = turn_task.exception()
                turn_task = None
                if exc is not None:
                    if isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                        raise exc
                    logger.error("turn task crashed", exc_info=exc)
                # 대기 중이던 채팅 이어서 실행 (interrupt 로 멈춘 상태면 보류 —
                # 다음 수신에서 resume 변환 경로를 탄다)
                await _drain_queue()

            # ── 2) 수신 메시지 처리 ──
            if recv_task is None or not recv_task.done():
                continue
            data = recv_task.result()  # 끊기면 WebSocketDisconnect raise
            recv_task = None

            try:
                payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise ValueError("payload 는 JSON 객체여야 합니다")
            except (json.JSONDecodeError, ValueError) as exc:
                await websocket.send_json({"type": "error", "detail": f"잘못된 메시지 형식: {exc}"})
                continue

            msg_type = payload.get("type", "chat")

            # 사용자 중지 요청 — 실행 중이면 stop_event set. 수신 루프가 턴과
            # 분리돼 있어서 실행 도중에도 즉시 처리된다.
            if msg_type == "cancel":
                # 대기 큐부터 비운다 (실행 중이 아니어도 큐는 남아 있을 수 있음).
                session.queued_chats.clear()
                if session.turn_stop_event is not None:
                    session.turn_stop_event.set()
                    await websocket.send_json({
                        "type": "info",
                        "content": "중지 요청 접수 — 진행 중이던 tool 완료 후 즉시 종료돼",
                    })
                else:
                    await websocket.send_json({
                        "type": "info",
                        "content": "중지할 진행 중 작업이 없어",
                    })
                continue

            if msg_type == "resume":
                # busy 는 동기 플래그 — 다른 접속의 turn 이 락을 잡기 전이어도 잡힌다.
                # 이 가드가 없으면 두 탭이 같은 interrupt 에 각각 resume 을 보내
                # 두 번째 값이 *다음* interrupt 를 잘못 소비한다.
                if session.busy:
                    await websocket.send_json({
                        "type": "error",
                        "detail": "이미 실행 중이에요. 완료 후 응답해줘.",
                    })
                    continue
                # interrupt 는 체크포인트 기준으로 판단 — 재접속 후 resume 도 허용
                if session.pending_interrupt() is None:
                    await websocket.send_json({
                        "type": "error",
                        "detail": "대기 중인 승인 요청이 없습니다.",
                    })
                    continue
                await _start_resume(_resume_from_payload(payload))
                continue

            # 일반 채팅
            user_message = payload.get("message", "")
            if not user_message:
                await websocket.send_json({"type": "error", "detail": "message 가 비어 있습니다."})
                continue

            # 다른 접속(두 번째 WS/REST)이 잡은 실행 — 이 소켓의 턴이 아니면 거부
            if session.busy and not _turn_running():
                await websocket.send_json({
                    "type": "phase", "phase": "pending", "state": "done",
                })
                await websocket.send_json({
                    "type": "error",
                    "detail": "다른 접속에서 작업이 진행 중이에요. 완료 후 다시 요청해줘.",
                })
                continue

            if _turn_running():
                if len(session.queued_chats) >= MAX_QUEUED:
                    await websocket.send_json({
                        "type": "error",
                        "detail": f"대기 요청이 이미 {MAX_QUEUED}개 있어요. 진행 중 작업을 중지하거나 완료를 기다려줘.",
                    })
                    continue
                # 큐 적재 시점에 DB 로그 — 접속이 끊겨도 사용자 발화가 사라지지 않게.
                await SessionRepo.log_event(
                    session_id, kind="user", content=user_message,
                    extra={"queued": True},
                )
                session.queued_chats.append(user_message)
                await websocket.send_json({
                    "type": "info",
                    "content": "현재 작업이 끝나면 이어서 실행할게. (중지하려면 stop)",
                })
                continue

            pending_now = session.pending_interrupt()
            if pending_now is not None:
                # 자유 채팅을 interrupt 응답으로 해석 (승인 / 피드백 / clarify 답변)
                await SessionRepo.log_event(
                    session_id, kind="user", content=user_message
                )
                await _start_resume(_reply_to_resume(pending_now, user_message))
                continue

            # 유저 메시지 DB 로그
            await SessionRepo.log_event(
                session_id, kind="user", content=user_message
            )
            _start_turn(_build_graph_input(session, user_message))

    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        # 연결 종료 — *이 접속이 소유한* turn 만 정지시킨다. 두 번째 탭을 닫았을 때
        # 첫 탭의 실행이 취소되면 안 된다 (turn_stop_event 는 세션 전역 슬롯).
        if _turn_running() and session.turn_stop_event is not None:
            session.turn_stop_event.set()
        if recv_task is not None:
            if not recv_task.done():
                recv_task.cancel()
            elif not recv_task.cancelled():
                recv_task.exception()  # 회수 (미조회 경고 방지)
        if turn_task is not None:
            if turn_task.done():
                if not turn_task.cancelled():
                    turn_task.exception()
            else:
                # WS 는 죽었지만 턴 태스크는 자연 종료됨 (락도 그때 풀림).
                turn_task.add_done_callback(
                    lambda t: t.exception() if not t.cancelled() else None
                )


# -------------------------------------------------------------------
# Health check
# -------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


# -------------------------------------------------------------------
# 실행
# -------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
