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
    {"type": "resume", "approved": true}              (계획 승인)
    {"type": "resume", "approved": false, "feedback": "BGM 빼줘"}  (계획 수정 요청)
  server → client:
    {"type": "message",   "node": "...", "content": "..."}
    {"type": "tool_call", "node": "...", "tool_name": "...", "args": {...}}
    {"type": "interrupt", "payload": {...script_approval...}}   ← resume 응답 대기
    {"type": "final",     "output_path": "...", "output_url": "/files/outputs/...",
                          "video_context": {...}, "critic": {...}}
    {"type": "done"}
    {"type": "error",     "detail": "..."}

Swagger UI: http://localhost:8000/docs
"""

import json
import re
import threading
import uuid
import asyncio
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

from agent import config as agent_config
from agent.graph import build_graph
from agent.state import VideoContext


app = FastAPI(
    title="Video Edit Agent API",
    description="Supervisor + Sub-Agent 구조의 영상 편집 에이전트 (세션 기반)",
    version="0.4.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3456",  # frontend/motion-editor
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
    """서버 파일 경로 → 프론트에서 접근 가능한 /files/* URL. 매핑 불가 시 None."""
    if not path_str:
        return None
    p = Path(path_str)
    if not p.is_absolute():
        p = (agent_config.PROJECT_ROOT / p).resolve()
    for base, prefix in _FILE_URL_BASES:
        try:
            rel = p.relative_to(base.resolve())
            return f"{prefix}/{rel.as_posix()}"
        except ValueError:
            continue
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

    @property
    def config(self) -> dict:
        return {"configurable": {"thread_id": self.session_id}}


sessions: dict[str, Session] = {}


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
    """유저 턴 → 그래프 초기 입력. None 값은 상태를 덮어쓰지 않도록 제외."""
    graph_input: dict = {
        "messages": [{"role": "user", "content": user_message}],
        "user_request": user_message,
        "execution_trace": [],
        "script_revision": 0,
        "spawn_depth": 0,
        "session_id": session.session_id,
    }
    if session.video_paths:
        graph_input["video_paths"] = session.video_paths
    if session.video_context:
        graph_input["video_context"] = session.video_context
    return graph_input


# -------------------------------------------------------------------
# 업로드 엔드포인트
# -------------------------------------------------------------------

_SAFE_NAME_RE = re.compile(r"[^0-9A-Za-z가-힣._-]+")


@app.post("/upload", response_model=UploadResponse)
async def upload_video(file: UploadFile = File(...)):
    """영상 파일을 업로드한다. 반환된 path 를 POST /session 의 video_paths 로 사용."""
    raw_name = Path(file.filename or "upload.mp4").name
    safe_name = _SAFE_NAME_RE.sub("_", raw_name) or "upload.mp4"

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
                out.write(chunk)
                size += len(chunk)
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
    session_id = str(uuid.uuid4())[:8]

    video_ctx: Optional[VideoContext] = None
    if request.video_context:
        video_ctx = request.video_context.model_dump()

    sessions[session_id] = Session(
        session_id=session_id,
        video_context=video_ctx,
        video_paths=request.video_paths,
    )

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
        if values.get("video_context"):
            info["video_context"] = _jsonable(values["video_context"])
    except Exception:
        pass

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

    result = await asyncio.to_thread(
        session.graph.invoke,
        _build_graph_input(session, request.message),
        config=session.config,
    )

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

async def _relay_stream(websocket: WebSocket, session: Session, stream_input) -> bool:
    """graph.stream 을 별도 스레드에서 돌리며 chunk 를 실시간 전송.

    interrupt 발생 시 {"type": "interrupt"} 를 보내고 True 반환
    (호출자가 클라이언트의 resume 을 받아 재시작). 정상 종료면 False.
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def _producer():
        try:
            for chunk in session.graph.stream(
                stream_input,
                config=session.config,
                stream_mode="updates",
            ):
                loop.call_soon_threadsafe(queue.put_nowait, ("chunk", chunk))
        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, ("error", str(exc)))
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, ("end", None))

    threading.Thread(target=_producer, daemon=True).start()

    interrupted = False
    while True:
        kind, item = await queue.get()

        if kind == "end":
            break

        if kind == "error":
            await websocket.send_json({"type": "error", "detail": item})
            break

        chunk = item
        # interrupt: 계획 승인 게이트 (agent/graph.py interrupt_gate)
        if "__interrupt__" in chunk:
            interrupts = chunk["__interrupt__"]
            payload = interrupts[0].value if interrupts else {}
            await websocket.send_json({"type": "interrupt", "payload": _jsonable(payload)})
            interrupted = True
            continue

        for node_name, state in chunk.items():
            if not isinstance(state, dict) or "messages" not in state:
                continue

            for msg in state["messages"]:
                content = _extract_text(getattr(msg, "content", None))
                if content:
                    await websocket.send_json({
                        "type": "message",
                        "node": node_name,
                        "content": content,
                    })

                if hasattr(msg, "tool_calls") and msg.tool_calls:
                    for tc in msg.tool_calls:
                        await websocket.send_json({
                            "type": "tool_call",
                            "node": node_name,
                            "tool_name": tc["name"],
                            "args": _jsonable(tc["args"]),
                        })

    return interrupted


async def _send_final(websocket: WebSocket, session: Session):
    """그래프 최종 상태에서 결과물 경로 / 컨텍스트를 뽑아 전송."""
    try:
        snapshot = session.graph.get_state(session.config)
        values = snapshot.values or {}
    except Exception:
        values = {}

    final_path = values.get("final_output_path", "") or ""
    video_context = values.get("video_context")
    critic = values.get("critic_verdict")

    await websocket.send_json({
        "type": "final",
        "output_path": final_path,
        "output_url": _to_file_url(final_path),
        "video_context": _jsonable(video_context) if video_context else None,
        "critic": _jsonable(critic) if critic else None,
    })


@app.websocket("/ws/chat/{session_id}")
async def chat_stream(websocket: WebSocket, session_id: str):
    """세션 기반 WebSocket 스트리밍. 프로토콜은 파일 상단 docstring 참고."""
    await websocket.accept()

    if session_id not in sessions:
        # accept 후 close 해야 브라우저가 close code 를 읽을 수 있음 (accept 전엔 HTTP 403)
        await websocket.close(code=4004, reason="세션을 찾을 수 없습니다")
        return

    session = sessions[session_id]

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)

            msg_type = payload.get("type", "chat")
            if msg_type == "resume":
                # 대기 중인 interrupt 없이 resume 이 오면 무시
                await websocket.send_json({
                    "type": "error",
                    "detail": "대기 중인 승인 요청이 없습니다.",
                })
                continue

            user_message = payload.get("message", "")
            if not user_message:
                await websocket.send_json({"type": "error", "detail": "message 가 비어 있습니다."})
                continue

            stream_input = _build_graph_input(session, user_message)

            # interrupt 가 발생하면 클라이언트 resume 을 받아 이어서 실행
            while True:
                interrupted = await _relay_stream(websocket, session, stream_input)
                if not interrupted:
                    break

                # 승인 응답 대기 ({"type": "resume", "approved": ..., "feedback": ...})
                while True:
                    raw = await websocket.receive_text()
                    resume_payload = json.loads(raw)
                    if resume_payload.get("type") == "resume" or "approved" in resume_payload:
                        break
                    await websocket.send_json({
                        "type": "error",
                        "detail": "계획 승인 대기 중입니다. resume 메시지를 보내세요.",
                    })

                if resume_payload.get("approved", False):
                    stream_input = Command(resume={"approved": True})
                else:
                    stream_input = Command(resume={
                        "approved": False,
                        "feedback": resume_payload.get("feedback", ""),
                    })

            await _send_final(websocket, session)
            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        pass


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
