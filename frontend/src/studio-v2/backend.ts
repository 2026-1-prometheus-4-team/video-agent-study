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
      type: "phase";
      phase: string; // "analysis" | "script" | "supervisor" | "critic" | ...
      state?: "running" | "done";
      label?: string;
      detail?: string;
    }
  | {
      type: "video_context";
      video_context: {
        file_path?: string;
        duration?: number;
        scenes?: Array<{ start: number; end: number; description?: string }>;
        transcript?: Array<{ start: number; end: number; text?: string }>;
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
    if (currentSocket && existing) {
      await currentSocket.ready().catch(() => undefined);
      return currentSocket;
    }

    useAgentStore.getState().setConnection("connecting");
    const { session_id } = await createSession(
      videoPath ? [videoPath] : []
    );
    useAgentStore.getState().startSession(session_id);
    const sock = new AgentSocket(session_id);
    sock.connect();
    currentSocket = sock;
    await sock.ready(6000);
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

/** 진행 중 turn 중지. Backend 가 다음 chunk 경계에서 종료. */
export function tryCancel(): boolean {
  if (!currentSocket) return false;
  try {
    currentSocket.cancel();
    return true;
  } catch {
    return false;
  }
}

// 서버가 아무 이벤트도 안 보내면 이 시간 뒤에 sessionStatus=error 로 전환.
// analysis+script 가 60s+ 걸리는 케이스가 있어 넉넉하게 90s.
const WATCHDOG_MS = 90_000;

export class AgentSocket {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private closedByUser = false;
  private retries = 0;
  private currentAgentMsgId: string | null = null;
  private currentToolStack: string[] = []; // FIFO 로 tool_result 매핑
  private openWaiters: Array<() => void> = [];
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 어떤 이벤트든 오면 watchdog 리셋. */
  bumpWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      const st = useAgentStore.getState();
      if (st.sessionStatus === "streaming") {
        st.pushError(
          "응답 없음",
          `${Math.round(WATCHDOG_MS / 1000)}초간 서버 이벤트 없음. 백엔드 상태 확인해봐.`
        );
      }
    }, WATCHDOG_MS);
  }

  /** open 상태가 될 때까지 대기 (5초 이내). */
  ready(timeoutMs = 5000): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.openWaiters = this.openWaiters.filter((w) => w !== fn);
        reject(new Error("WebSocket ready timeout"));
      }, timeoutMs);
      const fn = () => {
        clearTimeout(t);
        resolve();
      };
      this.openWaiters.push(fn);
    });
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const url = `${WS_BASE}/ws/chat/${this.sessionId}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retries = 0;
      useAgentStore.getState().setConnection("online");
      // waiters flush
      const list = this.openWaiters.slice();
      this.openWaiters = [];
      list.forEach((fn) => fn());
      this.bumpWatchdog();
    });

    ws.addEventListener("message", (ev) => {
      // 어떤 event 든 도착했으면 watchdog 리셋 — 사용자에게 "살아있음" 표시.
      this.bumpWatchdog();
      let data: BackendEvent | null = null;
      try {
        data = JSON.parse(ev.data) as BackendEvent;
      } catch (e) {
        console.warn("bad WS payload (parse)", ev.data, e);
        return;
      }
      try {
        this.handleEvent(data);
      } catch (e) {
        // 어떤 케이스 (예: interrupt/final 파싱) 라도 실패하면 조용히 죽지 않고
        // error 이벤트로 UI 에 명시. 이전엔 파싱 예외가 handler 를 벗어나
        // session 이 무한 streaming 에 갇혔다.
        console.error("handleEvent failed", data, e);
        useAgentStore.getState().pushError(
          "이벤트 처리 실패",
          e instanceof Error ? e.message : String(e)
        );
      }
    });

    ws.addEventListener("error", (ev) => {
      console.warn("WS error", ev);
    });

    ws.addEventListener("close", (ev) => {
      // 서버가 명시적 코드로 close 한 경우 재접속 X:
      //  1000 정상 종료 · 1001 endpoint going away
      //  4004 세션 없음 (서버 재시작 후 in-memory session 사라짐)
      const permanentCodes = new Set([1000, 1001, 1008, 4004]);
      if (permanentCodes.has(ev.code)) {
        this.closedByUser = true;
        useAgentStore.getState().setConnection("offline");
        if (ev.code === 4004) {
          useAgentStore.getState().pushError(
            "세션이 사라졌어",
            "서버가 재시작됐거나 세션이 만료됨. 새 지시를 내리면 새 세션이 자동 생성됨.",
          );
          // 다음 send 에서 새 세션을 만들도록 sessionId 초기화.
          useAgentStore.setState((s) => {
            s.sessionId = null;
            s.sessionStatus = "idle";
          });
          currentSocket = null;
        }
        return;
      }

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
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
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

  cancel() {
    this.send({ type: "cancel" });
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
      case "video_context": {
        // analysis 완료 즉시 도착 — Timeline 이 씬/자막을 실시간으로 그리게.
        const vc = ev.video_context ?? {};
        const duration = typeof vc.duration === "number" ? vc.duration : 0;
        const scenes = (vc.scenes ?? []).map((sc) => ({
          start: sc.start,
          end: sc.end,
          description: sc.description ?? "",
        }));
        const transcript = (vc.transcript ?? []).map((t) => ({
          start: t.start,
          end: t.end,
          text: t.text ?? "",
        }));
        store.setVideoContext({
          file_path: vc.file_path ?? "",
          duration,
          scenes,
          transcript,
        });
        break;
      }
      case "phase": {
        const phase = String(ev.phase || "").trim();
        if (!phase) break;
        // 첫 실제 phase 도착 시 optimistic pending 카드는 종료.
        store.endPhase("pending");
        if (ev.state === "done") {
          store.endPhase(phase, ev.label, ev.detail);
        } else {
          store.startPhase(
            phase,
            ev.label || phase,
            ev.detail || ""
          );
        }
        break;
      }
      case "interrupt": {
        const payload = (ev.payload || {}) as Record<string, unknown>;
        // Backend 는 { type:"script_approval", plan:{steps,questions,...}, questions, instructions }
        // 형태로 보낸다. 예전 이름 script_plan 도 방어적으로 지원.
        const planLike =
          (payload.plan as Record<string, unknown> | undefined) ??
          (payload.script_plan as Record<string, unknown> | undefined) ??
          {};
        const stepsRaw = Array.isArray(planLike.steps)
          ? (planLike.steps as Array<Record<string, unknown>>)
          : [];
        const steps = stepsRaw.map((raw, idx) => ({
          id: (raw.step_id as number) ?? idx + 1,
          action: (raw.action as string) ?? "",
          expert: asNode((raw.expert as string) ?? "orchestrator"),
          rationale: (raw.rationale as string) ?? "",
          estimatedSec: raw.estimated_sec as number | undefined,
          parallelGroup:
            (raw.parallel_group as number | null | undefined) ?? null,
          dependsOn: raw.depends_on as number[] | undefined,
        }));
        const questions = Array.isArray(planLike.questions)
          ? (planLike.questions as string[])
          : Array.isArray(payload.questions)
            ? (payload.questions as string[])
            : [];
        store.pushInterrupt(steps, questions);
        break;
      }
      case "final": {
        const outputPath = ev.output_path || "";
        const outputUrl = ev.output_url
          ? `${API_BASE}${ev.output_url}`
          : undefined;
        const vc =
          (ev.video_context as {
            file_path?: string;
            duration?: number;
            scenes?: Array<{ start: number; end: number; description?: string }>;
            transcript?: Array<{ start: number; end: number; text: string }>;
          } | undefined) ?? undefined;
        const duration = typeof vc?.duration === "number" ? vc.duration : 0;
        const scenes = (vc?.scenes ?? []).map((sc) => ({
          start: sc.start,
          end: sc.end,
          description: sc.description ?? "",
        }));
        const transcript = (vc?.transcript ?? []).map((t) => ({
          start: t.start,
          end: t.end,
          text: t.text ?? "",
        }));

        store.pushFinal(outputPath, duration, {
          criticNote: ev.critic?.message_to_user,
          outputUrl,
          scenes,
          transcript,
        });
        // videoContext 도 갱신 (Timeline 이 참조)
        if (vc) {
          store.setVideoContext({
            file_path: vc.file_path ?? outputPath,
            duration,
            scenes,
            transcript,
          });
        }
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
