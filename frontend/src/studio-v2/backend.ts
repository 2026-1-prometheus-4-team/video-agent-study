/**
 * backend.ts — FastAPI 백엔드 (backend/server.py) 클라이언트.
 *
 * REST:
 *   GET  /health                     서버 살아있는지
 *   POST /upload  (multipart file)   영상 업로드, {path, url, size} 반환
 *   POST /session                    세션 생성, {session_id} 반환
 *   GET  /session/{id}               세션 상태
 *   DEL  /session/{id}               세션 종료
 *
 * WS:
 *   /ws/chat/{session_id}
 *   client → { type:"chat", message } | { type:"resume", approved, feedback? }
 *   server → { type: message|tool_call|interrupt|final|done|error, ... }
 */

import { useAgentStore } from "./state";

const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

const WS_BASE = API_BASE.replace(/^http/, "ws");

// ---------- REST ----------

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`, {
      method: "GET",
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface UploadResult {
  path: string; // 서버 상대 경로 — /session 에 넘길 값
  url: string; // /files/videos/xxx.mp4
  size: number;
}

export async function uploadVideo(file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`upload failed (${res.status}) ${detail}`);
  }
  return (await res.json()) as UploadResult;
}

export async function createSession(
  videoPaths: string[] = []
): Promise<{ session_id: string }> {
  const res = await fetch(`${API_BASE}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_paths: videoPaths }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`session failed (${res.status}) ${detail}`);
  }
  return await res.json();
}

// ---------- WebSocket ----------

type BackendEvent =
  | { type: "message"; node?: string; content: string }
  | { type: "tool_call"; node?: string; tool_name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id?: string; ok?: boolean; result?: unknown; detail?: string }
  | {
      type: "interrupt";
      payload: {
        plan?: Array<Record<string, unknown>>;
        script_plan?: {
          steps?: Array<Record<string, unknown>>;
          questions?: string[];
        };
        questions?: string[];
      };
    }
  | {
      type: "final";
      output_path?: string;
      output_url?: string;
      video_context?: Record<string, unknown>;
      critic?: { message_to_user?: string };
    }
  | { type: "done" }
  | { type: "error"; detail: string };

const NODE_MAP: Record<string, "orchestrator" | "research" | "planning" | "edit" | "critic"> = {
  supervisor: "orchestrator",
  orchestrator: "orchestrator",
  script: "planning",
  planning: "planning",
  research: "research",
  edit: "edit",
  edit_expert: "edit",
  audio: "edit",
  audio_expert: "edit",
  text: "edit",
  text_expert: "edit",
  effect: "edit",
  effect_expert: "edit",
  research_expert: "research",
  critic: "critic",
};

const asNode = (n?: string) =>
  (n && NODE_MAP[n]) ||
  ((n === "message" || !n) ? "orchestrator" : "orchestrator");

// ---------- Module-level socket singleton ----------

let currentSocket: AgentSocket | null = null;

export function getSocket(): AgentSocket | null {
  return currentSocket;
}

export async function ensureSessionAndConnect(
  videoPath?: string
): Promise<AgentSocket | null> {
  try {
    const existing = useAgentStore.getState().sessionId;
    if (currentSocket && existing) return currentSocket;

    useAgentStore.getState().setConnection("connecting");
    const { session_id } = await createSession(
      videoPath ? [videoPath] : []
    );
    useAgentStore.getState().startSession(session_id);
    const sock = new AgentSocket(session_id);
    sock.connect();
    currentSocket = sock;
    return sock;
  } catch (err) {
    console.warn("session create failed", err);
    useAgentStore.getState().setConnection("offline");
    return null;
  }
}

export function closeSocket() {
  currentSocket?.disconnect();
  currentSocket = null;
}

/** Composer 가 호출: backend 있으면 real WS, 없으면 caller 가 mock fallback. */
export function trySendChat(message: string): boolean {
  if (!currentSocket) return false;
  try {
    currentSocket.sendChat(message);
    return true;
  } catch {
    return false;
  }
}

export function tryResumeInterrupt(
  approved: boolean,
  feedback?: string
): boolean {
  if (!currentSocket) return false;
  try {
    currentSocket.resume(approved, feedback);
    return true;
  } catch {
    return false;
  }
}

export class AgentSocket {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private closedByUser = false;
  private retries = 0;
  private currentAgentMsgId: string | null = null;
  private currentToolStack: string[] = []; // FIFO 로 tool_result 매핑

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const url = `${WS_BASE}/ws/chat/${this.sessionId}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retries = 0;
      useAgentStore.getState().setConnection("online");
    });

    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data) as BackendEvent;
        this.handleEvent(data);
      } catch (e) {
        console.warn("bad WS payload", ev.data, e);
      }
    });

    ws.addEventListener("error", (ev) => {
      console.warn("WS error", ev);
    });

    ws.addEventListener("close", () => {
      useAgentStore.getState().setConnection("reconnecting");
      if (!this.closedByUser) {
        const delay = Math.min(30_000, 500 * 2 ** this.retries);
        this.retries++;
        setTimeout(() => this.connect(), delay);
      } else {
        useAgentStore.getState().setConnection("offline");
      }
    });
  }

  disconnect() {
    this.closedByUser = true;
    this.ws?.close();
    this.ws = null;
  }

  send(payload: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  sendChat(message: string) {
    this.send({ type: "chat", message });
  }

  resume(approved: boolean, feedback?: string) {
    this.send({
      type: "resume",
      approved,
      feedback: approved ? undefined : feedback,
    });
  }

  private handleEvent(ev: BackendEvent) {
    const store = useAgentStore.getState();
    switch (ev.type) {
      case "message": {
        // 매번 새 agent bubble (backend 는 whole content 청크)
        const id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        store.startAgentMsg(id, asNode(ev.node));
        store.appendAgentChunk(id, ev.content ?? "");
        store.endAgentMsg(id);
        this.currentAgentMsgId = null;
        break;
      }
      case "tool_call": {
        const id = `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        store.startTool(id, asNode(ev.node), ev.tool_name, ev.args ?? {});
        this.currentToolStack.push(id);
        break;
      }
      case "tool_result": {
        const id = this.currentToolStack.shift();
        if (id) {
          store.endTool(id, ev.ok !== false, ev.result, ev.detail);
        }
        break;
      }
      case "interrupt": {
        const payload = ev.payload || {};
        const script = payload.script_plan || {};
        const stepsRaw = (script.steps as Array<Record<string, unknown>>) || (payload.plan as Array<Record<string, unknown>>) || [];
        const steps = stepsRaw.map((raw, idx) => ({
          id: (raw.step_id as number) ?? idx + 1,
          action: (raw.action as string) ?? "",
          expert: asNode((raw.expert as string) ?? "orchestrator"),
          rationale: (raw.rationale as string) ?? "",
          estimatedSec: (raw.estimated_sec as number | undefined),
          parallelGroup: (raw.parallel_group as number | null | undefined) ?? null,
          dependsOn: raw.depends_on as number[] | undefined,
        }));
        const questions = script.questions ?? payload.questions ?? [];
        store.pushInterrupt(steps, questions);
        break;
      }
      case "final": {
        const outputPath =
          (ev.output_url && `${API_BASE}${ev.output_url}`) ||
          ev.output_path ||
          "";
        const durationRaw = ev.video_context?.duration;
        const duration = typeof durationRaw === "number" ? durationRaw : 0;
        store.pushFinal(outputPath, duration, ev.critic?.message_to_user);
        // 남은 tool 카드 있으면 성공 처리
        while (this.currentToolStack.length) {
          const id = this.currentToolStack.shift()!;
          store.endTool(id, true);
        }
        break;
      }
      case "done": {
        // 남은 tool 카드 정리
        while (this.currentToolStack.length) {
          const id = this.currentToolStack.shift()!;
          store.endTool(id, true);
        }
        store.pushInfo("세션 종료");
        break;
      }
      case "error": {
        store.pushError("오류", ev.detail);
        break;
      }
    }
  }
}
