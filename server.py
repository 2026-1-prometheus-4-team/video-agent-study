"""
FastAPI 서버 - Supervisor Agent + 세션 기반 대화

세션 흐름:
  1. POST /session       → 영상 로드, session_id 반환
  2. POST /chat          → session_id + prompt 로 연속 대화
  3. GET  /session/{id}  → 세션 정보 조회
  4. DELETE /session/{id} → 세션 종료

Swagger UI: http://localhost:8000/docs
"""

import json
import uuid
import asyncio
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from langgraph.checkpoint.memory import MemorySaver

from agent.graph import build_graph
from agent.state import VideoContext


app = FastAPI(
    title="Video Edit Agent API",
    description="Supervisor + Sub-Agent 구조의 영상 편집 에이전트 (세션 기반)",
    version="0.3.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------------------------------------------------
# 세션 저장소 (in-memory, 프로덕션에선 Redis 등으로 교체)
# -------------------------------------------------------------------

class Session:
    def __init__(self, session_id: str, video_context: Optional[VideoContext]):
        self.session_id = session_id
        self.video_context = video_context
        self.checkpointer = MemorySaver()
        self.graph = build_graph(checkpointer=self.checkpointer)


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

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "video_context": {
                        "file_path": "/videos/sample.mp4",
                        "duration": 120.0,
                        "scenes": [{"start": 0.0, "end": 10.0, "description": "인트로"}],
                        "transcript": [{"start": 0.0, "end": 5.0, "text": "안녕하세요"}],
                    }
                }
            ]
        }
    }


class CreateSessionResponse(BaseModel):
    session_id: str
    video_context: Optional[VideoContextSchema] = None


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


# -------------------------------------------------------------------
# 세션 관리 엔드포인트
# -------------------------------------------------------------------

@app.post("/session", response_model=CreateSessionResponse)
async def create_session(request: CreateSessionRequest):
    """새 편집 세션을 생성한다.

    영상 정보(video_context)를 넘기면 이후 대화에서 자동 참조됨.
    video_context 없이 생성해도 됨 (나중에 영상 로드 가능).
    """
    session_id = str(uuid.uuid4())[:8]

    video_ctx: Optional[VideoContext] = None
    if request.video_context:
        video_ctx = request.video_context.model_dump()

    sessions[session_id] = Session(session_id=session_id, video_context=video_ctx)

    return CreateSessionResponse(
        session_id=session_id,
        video_context=request.video_context,
    )


@app.get("/session/{session_id}")
async def get_session(session_id: str):
    """세션 정보를 조회한다."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")

    session = sessions[session_id]
    return {
        "session_id": session_id,
        "video_context": session.video_context,
    }


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    """세션을 종료한다."""
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없습니다")

    del sessions[session_id]
    return {"status": "deleted", "session_id": session_id}


# -------------------------------------------------------------------
# 채팅 엔드포인트 (세션 기반 연속 대화)
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
        {"messages": [{"role": "user", "content": request.message}]},
        config={"configurable": {"thread_id": session.session_id}},
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
    video_ctx: Optional[VideoContext] = None
    if request.video_context:
        video_ctx = request.video_context.model_dump()

    graph = build_graph()

    result = await asyncio.to_thread(
        graph.invoke,
        {"messages": [{"role": "user", "content": request.user_input}]}
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

@app.websocket("/ws/chat/{session_id}")
async def chat_stream(websocket: WebSocket, session_id: str):
    """세션 기반 WebSocket 스트리밍.

    연결 후 JSON 메시지 전송: {"message": "3초에서 7초 잘라줘"}
    """
    if session_id not in sessions:
        await websocket.close(code=4004, reason="세션을 찾을 수 없습니다")
        return

    await websocket.accept()
    session = sessions[session_id]

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            user_message = payload.get("message", "")

            def _stream():
                return list(session.graph.stream(
                    {"messages": [{"role": "user", "content": user_message}]},
                    config={"configurable": {"thread_id": session.session_id}},
                    stream_mode="updates",
                ))

            chunks = await asyncio.to_thread(_stream)

            for chunk in chunks:
                for node_name, state in chunk.items():
                    if "messages" not in state:
                        continue

                    for msg in state["messages"]:
                        if hasattr(msg, "content") and msg.content:
                            content = msg.content if isinstance(msg.content, str) else str(msg.content)
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
                                    "args": tc["args"],
                                })

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
