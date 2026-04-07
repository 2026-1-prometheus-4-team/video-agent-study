"""
FastAPI 서버 - 에이전트 WebSocket 스트리밍 엔드포인트
"""

import json
import asyncio
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from agent import build_graph, VideoContext


app = FastAPI(title="Video Edit Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------------------------------------------------
# Request / Response 스키마
# -------------------------------------------------------------------

class EditRequest(BaseModel):
    user_input: str
    video_context: Optional[VideoContext] = None


class EditResponse(BaseModel):
    result: str
    edit_history: list[str]


# -------------------------------------------------------------------
# REST 엔드포인트 (단순 요청용)
# -------------------------------------------------------------------

@app.post("/edit", response_model=EditResponse)
async def edit_video(request: EditRequest):
    graph = build_graph()

    initial_state = {
        "messages": [HumanMessage(content=request.user_input)],
        "video_context": request.video_context,
        "edit_history": []
    }

    final_state = await asyncio.to_thread(graph.invoke, initial_state)

    last_message = final_state["messages"][-1]
    result = last_message.content if hasattr(last_message, "content") else ""

    return EditResponse(
        result=result,
        edit_history=final_state.get("edit_history", [])
    )


# -------------------------------------------------------------------
# WebSocket 엔드포인트 (스트리밍용)
# Claude Code처럼 실시간으로 에이전트 동작 전송
# -------------------------------------------------------------------

@app.websocket("/ws/edit")
async def edit_video_stream(websocket: WebSocket):
    await websocket.accept()

    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)

            user_input = payload.get("user_input", "")
            video_context = payload.get("video_context", None)

            graph = build_graph()

            initial_state = {
                "messages": [HumanMessage(content=user_input)],
                "video_context": video_context,
                "edit_history": []
            }

            # 스트리밍으로 각 노드 실행 결과 실시간 전송
            for step in graph.stream(initial_state):
                for node_name, state in step.items():
                    for message in state["messages"]:

                        if isinstance(message, AIMessage):
                            if message.content:
                                await websocket.send_json({
                                    "type": "ai_message",
                                    "node": node_name,
                                    "content": message.content
                                })

                            if hasattr(message, "tool_calls") and message.tool_calls:
                                for tc in message.tool_calls:
                                    await websocket.send_json({
                                        "type": "tool_call",
                                        "node": node_name,
                                        "tool_name": tc["name"],
                                        "args": tc["args"]
                                    })

                        elif isinstance(message, ToolMessage):
                            await websocket.send_json({
                                "type": "tool_result",
                                "node": node_name,
                                "content": message.content
                            })

                    if state.get("edit_history"):
                        await websocket.send_json({
                            "type": "edit_history",
                            "history": state["edit_history"]
                        })

            await websocket.send_json({"type": "done"})

    except WebSocketDisconnect:
        pass


# -------------------------------------------------------------------
# 실행
# -------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
