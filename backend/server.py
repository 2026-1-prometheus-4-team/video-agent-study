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

  상태 규칙:
    - interrupt 상태는 그래프 체크포인트에 보존됨 — 접속이 끊겨도 재접속하면
      서버가 interrupt 를 다시 보내주고, resume 을 그대로 이어받는다.
    - 한 세션은 한 번에 하나의 실행만 (동시 chat 은 error 응답).
    - 새 결과물이 없는 turn 은 final 생략 (버전 중복 방지). done 은 항상 전송.

Swagger UI: http://localhost:8000/docs
"""

import json
import re
import threading
import time
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
        "http://localhost:3001",  # frontend/motion-editor (video agent studio)
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
        # 같은 결과를 turn 마다 반복 전송하지 않기 위한 dedupe
        self.last_final_sent = ""

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
        video_context = values.get("video_context")
        if isinstance(video_context, dict) and not video_context.get("transcript"):
            sidecar = _load_transcript_sidecar(session)
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
    if session.run_lock.locked():
        raise HTTPException(status_code=409, detail="이미 실행 중인 작업이 있습니다.")

    async with session.run_lock:
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

# 채팅으로 흘려보내는 메시지 최대 길이 (supervisor 내부 프롬프트/JSON 덤프 억제)
MAX_RELAY_CHARS = 1500


async def _relay_stream(websocket: WebSocket, session: Session, stream_input) -> bool:
    """graph.stream 을 별도 스레드에서 돌리며 chunk 를 실시간 전송.

    interrupt 발생 시 {"type": "interrupt"} 를 보내고 True 반환. 정상 종료면 False.
    클라이언트가 중간에 끊기면 producer 에 stop 신호를 보내 push 를 멈춘다
    (진행 중인 그래프 turn 자체는 중단 불가 — 완료 후 스레드 종료).
    """
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    stop = threading.Event()

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
            if not stop.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, ("end", None))

    threading.Thread(target=_producer, daemon=True).start()

    interrupted = False
    try:
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
                        if len(content) > MAX_RELAY_CHARS:
                            content = content[:MAX_RELAY_CHARS] + "\n… (이하 생략)"
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
    except (WebSocketDisconnect, RuntimeError):
        # 클라이언트 끊김 — push 중단 신호 후 상위로 전파 (그래프 상태는 체크포인트에 보존)
        stop.set()
        raise

    return interrupted


def _load_transcript_sidecar(session: Session) -> list[dict]:
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

    input_stems = {Path(vp).stem for vp in session.video_paths}
    candidates: list[tuple[float, Path]] = []
    for sidecar in subtitles_dir.glob("*.json"):
        try:
            mtime = sidecar.stat().st_mtime
        except OSError:
            continue
        if sidecar.stem in input_stems or mtime >= session.created_at:
            candidates.append((mtime, sidecar))

    for _, sidecar in sorted(candidates, reverse=True):
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8"))
            segments = data.get("segments", [])
            if segments:
                return [
                    {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": str(s.get("text", ""))}
                    for s in segments
                ]
        except Exception:
            continue
    return []


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

    # transcript 비어 있으면 사이드카에서 보충
    if isinstance(video_context, dict) and not video_context.get("transcript"):
        sidecar = _load_transcript_sidecar(session)
        if sidecar:
            video_context = {**video_context, "transcript": sidecar}

    await websocket.send_json({
        "type": "final",
        "output_path": final_path,
        "output_url": _to_file_url(final_path),
        "video_context": _jsonable(video_context) if video_context else None,
        "critic": _jsonable(critic) if critic else None,
    })


async def _run_turn(websocket: WebSocket, session: Session, stream_input) -> None:
    """한 번의 그래프 실행 세그먼트. interrupt 로 멈추면 클라이언트의 다음
    메시지(resume)가 top-level 루프에서 이어받는다 — 접속이 끊겨도 interrupt
    상태는 체크포인트에 남아 재접속 후 복원/승인 가능."""
    async with session.run_lock:
        interrupted = await _relay_stream(websocket, session, stream_input)
    if interrupted:
        return
    await _send_final(websocket, session)
    await websocket.send_json({"type": "done"})


@app.websocket("/ws/chat/{session_id}")
async def chat_stream(websocket: WebSocket, session_id: str):
    """세션 기반 WebSocket 스트리밍. 프로토콜은 파일 상단 docstring 참고."""
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

    try:
        while True:
            data = await websocket.receive_text()
            try:
                payload = json.loads(data)
                if not isinstance(payload, dict):
                    raise ValueError("payload 는 JSON 객체여야 합니다")
            except (json.JSONDecodeError, ValueError) as exc:
                await websocket.send_json({"type": "error", "detail": f"잘못된 메시지 형식: {exc}"})
                continue

            msg_type = payload.get("type", "chat")

            if session.run_lock.locked():
                await websocket.send_json({
                    "type": "error",
                    "detail": "이미 실행 중인 작업이 있습니다. 완료 후 다시 시도하세요.",
                })
                continue

            if msg_type == "resume":
                # interrupt 는 체크포인트 기준으로 판단 — 재접속 후 resume 도 허용
                if session.pending_interrupt() is None:
                    await websocket.send_json({
                        "type": "error",
                        "detail": "대기 중인 승인 요청이 없습니다.",
                    })
                    continue
                if payload.get("approved", False):
                    stream_input = Command(resume={"approved": True})
                else:
                    stream_input = Command(resume={
                        "approved": False,
                        "feedback": payload.get("feedback", ""),
                    })
                await _run_turn(websocket, session, stream_input)
                continue

            # 일반 채팅
            user_message = payload.get("message", "")
            if not user_message:
                await websocket.send_json({"type": "error", "detail": "message 가 비어 있습니다."})
                continue
            if session.pending_interrupt() is not None:
                await websocket.send_json({
                    "type": "error",
                    "detail": "계획 승인 대기 중입니다. 승인하거나 수정 요청을 보내세요.",
                })
                continue

            await _run_turn(websocket, session, _build_graph_input(session, user_message))

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
