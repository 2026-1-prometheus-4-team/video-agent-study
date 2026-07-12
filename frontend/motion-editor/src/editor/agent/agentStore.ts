"use client";

// agentStore — 편집 에이전트(백엔드 LangGraph) 연결 상태 + 채팅 피드.
// 에디터 doc 스토어(store.ts)와 분리 — 채팅은 문서 편집 히스토리(undo)와 무관.
// WebSocket 프로토콜은 backend/server.py 상단 docstring 이 소스 오브 트루스.

import { create } from "zustand";

export const AGENT_API =
  process.env.NEXT_PUBLIC_AGENT_API ?? "http://localhost:8000";

const WS_BASE = AGENT_API.replace(/^http/, "ws");

// ---- 피드 아이템 ----

export type PlanStep = {
  step_id?: number;
  expert?: string;
  action?: string;
  description?: string;
  [k: string]: unknown;
};

export type InterruptPayload = {
  type?: string;
  plan?: {
    target_format?: string;
    target_aspect_ratio?: string;
    target_duration_sec?: number;
    steps?: PlanStep[];
    questions?: string[];
    [k: string]: unknown;
  };
  questions?: string[];
  instructions?: string;
};

export type TranscriptSeg = { start: number; end: number; text: string };

export type FinalResult = {
  outputPath: string;
  outputUrl: string | null; // "/files/..." (AGENT_API 기준 상대)
  videoContext: {
    file_path?: string;
    duration?: number;
    scenes?: { start: number; end: number; description: string }[];
    transcript?: TranscriptSeg[];
  } | null;
  critic: { verdict?: string; message_to_user?: string } | null;
};

export type FeedItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; node: string; text: string }
  | { kind: "tool"; node: string; tool: string; args: Record<string, unknown> }
  | { kind: "interrupt"; payload: InterruptPayload; resolved?: "approved" | "feedback" }
  | { kind: "final"; result: FinalResult }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export type AgentStatus =
  | "no-session"   // 세션 없음 (업로드 대기)
  | "uploading"    // 영상 업로드 중
  | "ready"        // 세션 준비 완료, 명령 대기
  | "running"      // 파이프라인 실행 중
  | "awaiting"     // 계획 승인 대기 (interrupt)
  | "error";

type AgentState = {
  status: AgentStatus;
  sessionId: string | null;
  videoPath: string | null; // 서버 기준 상대 경로 (videos/xxx.mp4)
  videoUrl: string | null;  // 업로드 원본 재생 URL (절대)
  feed: FeedItem[];
  lastFinal: FinalResult | null;

  uploadAndStart: (file: File) => Promise<void>;
  sendChat: (text: string) => void;
  resolveInterrupt: (approved: boolean, feedback?: string) => void;
  reset: () => void;
};

// WS 는 리렌더와 무관 — 모듈 레벨 보관.
let ws: WebSocket | null = null;

function push(item: FeedItem) {
  useAgent.setState((s) => ({ feed: [...s.feed, item] }));
}

function setStatus(status: AgentStatus) {
  useAgent.setState({ status });
}

// ---- WS 이벤트 핸들링 ----

function handleEvent(ev: Record<string, unknown>) {
  const type = ev.type as string;

  if (type === "message") {
    const content = String(ev.content ?? "").trim();
    if (content) push({ kind: "agent", node: String(ev.node ?? ""), text: content });
    return;
  }
  if (type === "tool_call") {
    push({
      kind: "tool",
      node: String(ev.node ?? ""),
      tool: String(ev.tool_name ?? ""),
      args: (ev.args as Record<string, unknown>) ?? {},
    });
    return;
  }
  if (type === "interrupt") {
    push({ kind: "interrupt", payload: (ev.payload as InterruptPayload) ?? {} });
    setStatus("awaiting");
    return;
  }
  if (type === "final") {
    const result: FinalResult = {
      outputPath: String(ev.output_path ?? ""),
      outputUrl: (ev.output_url as string) ?? null,
      videoContext: (ev.video_context as FinalResult["videoContext"]) ?? null,
      critic: (ev.critic as FinalResult["critic"]) ?? null,
    };
    if (result.outputPath || result.outputUrl) {
      push({ kind: "final", result });
      useAgent.setState({ lastFinal: result });
    }
    return;
  }
  if (type === "done") {
    setStatus("ready");
    return;
  }
  if (type === "error") {
    push({ kind: "error", text: String(ev.detail ?? "unknown error") });
    return;
  }
}

function connectWS(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${WS_BASE}/ws/chat/${sessionId}`);
    sock.onopen = () => resolve(sock);
    sock.onmessage = (e) => {
      try {
        handleEvent(JSON.parse(e.data));
      } catch {
        /* 비 JSON 프레임 무시 */
      }
    };
    sock.onclose = (e) => {
      ws = null;
      if (e.code === 4004) {
        push({ kind: "error", text: "세션이 만료됐어요. 영상을 다시 업로드해 주세요." });
        useAgent.setState({ status: "no-session", sessionId: null });
      }
    };
    sock.onerror = () => reject(new Error("WebSocket 연결 실패"));
  });
}

async function ensureWS(): Promise<WebSocket | null> {
  const { sessionId } = useAgent.getState();
  if (!sessionId) return null;
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  ws = await connectWS(sessionId);
  return ws;
}

// ---- 스토어 ----

export const useAgent = create<AgentState>((set, get) => ({
  status: "no-session",
  sessionId: null,
  videoPath: null,
  videoUrl: null,
  feed: [],
  lastFinal: null,

  uploadAndStart: async (file: File) => {
    if (get().status === "uploading") return;
    set({ status: "uploading" });
    push({ kind: "info", text: `업로드 중: ${file.name} (${(file.size / 1e6).toFixed(1)}MB)` });
    try {
      const form = new FormData();
      form.append("file", file);
      const upRes = await fetch(`${AGENT_API}/upload`, { method: "POST", body: form });
      if (!upRes.ok) throw new Error(`upload ${upRes.status}`);
      const up = (await upRes.json()) as { path: string; url: string };

      const sessRes = await fetch(`${AGENT_API}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_paths: [up.path] }),
      });
      if (!sessRes.ok) throw new Error(`session ${sessRes.status}`);
      const sess = (await sessRes.json()) as { session_id: string };

      set({
        sessionId: sess.session_id,
        videoPath: up.path,
        videoUrl: `${AGENT_API}${up.url}`,
        status: "ready",
      });
      push({ kind: "info", text: `영상 준비 완료 — 이제 편집을 지시해 보세요.` });
      await ensureWS();
    } catch (err) {
      push({ kind: "error", text: `업로드 실패: ${err instanceof Error ? err.message : err}` });
      set({ status: "no-session" });
    }
  },

  sendChat: (text: string) => {
    const msg = text.trim();
    if (!msg) return;
    push({ kind: "user", text: msg });
    setStatus("running");
    void ensureWS()
      .then((sock) => {
        if (!sock) throw new Error("세션이 없습니다");
        sock.send(JSON.stringify({ type: "chat", message: msg }));
      })
      .catch((err) => {
        push({ kind: "error", text: `전송 실패: ${err instanceof Error ? err.message : err}` });
        setStatus("ready");
      });
  },

  resolveInterrupt: (approved: boolean, feedback?: string) => {
    // 마지막 미해결 interrupt 카드를 resolved 로 마킹
    useAgent.setState((s) => {
      const feed = [...s.feed];
      for (let i = feed.length - 1; i >= 0; i--) {
        const it = feed[i];
        if (it.kind === "interrupt" && !it.resolved) {
          feed[i] = { ...it, resolved: approved ? "approved" : "feedback" };
          break;
        }
      }
      return { feed };
    });
    setStatus("running");
    void ensureWS()
      .then((sock) => {
        if (!sock) throw new Error("세션이 없습니다");
        sock.send(
          JSON.stringify(
            approved
              ? { type: "resume", approved: true }
              : { type: "resume", approved: false, feedback: feedback ?? "" },
          ),
        );
      })
      .catch((err) => {
        push({ kind: "error", text: `승인 전송 실패: ${err instanceof Error ? err.message : err}` });
        setStatus("awaiting");
      });
  },

  reset: () => {
    ws?.close();
    ws = null;
    set({
      status: "no-session",
      sessionId: null,
      videoPath: null,
      videoUrl: null,
      feed: [],
      lastFinal: null,
    });
  },
}));
