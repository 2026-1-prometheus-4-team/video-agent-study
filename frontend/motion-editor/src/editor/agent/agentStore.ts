"use client";

// agentStore — 편집 에이전트(백엔드 LangGraph) 연결 상태 + 채팅 피드.
// 에디터 doc 스토어(store.ts)와 분리 — 채팅은 문서 편집 히스토리(undo)와 무관.
// WebSocket 프로토콜은 backend/server.py 상단 docstring 이 소스 오브 트루스.
//
// 견고성 규칙 (리뷰 반영):
//  - 소켓은 세션에 바인딩 (wsSession) — 세션이 바뀌면 반드시 새로 연결
//  - 접속 끊김(비 4004) 시 1회 자동 재접속 → 서버가 미해결 interrupt 를
//    다시 보내주므로 승인 흐름이 복원됨. 실패하면 상태를 복구하고 에러 표시
//  - interrupt 카드 resolved 마킹은 전송 성공 후에만 (낙관적 마킹 금지)
//  - 세션은 localStorage 에 영속 — 새로고침 후 GET /session 으로 복원

import { create } from "zustand";

export const AGENT_API =
  process.env.NEXT_PUBLIC_AGENT_API ?? "http://localhost:8000";

const WS_BASE = AGENT_API.replace(/^http/, "ws");
const STORAGE_KEY = "video-agent-session";

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

type FeedPayload =
  | { kind: "user"; text: string }
  | { kind: "agent"; node: string; text: string }
  | { kind: "tool"; node: string; tool: string; args: Record<string, unknown> }
  | { kind: "interrupt"; payload: InterruptPayload; resolved?: "approved" | "feedback" }
  | { kind: "final"; result: FinalResult }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export type FeedItem = FeedPayload & { id: number };

export type AgentStatus =
  | "no-session"   // 세션 없음 (업로드 대기)
  | "uploading"    // 영상 업로드 중
  | "ready"        // 세션 준비 완료, 명령 대기
  | "running"      // 파이프라인 실행 중
  | "awaiting"     // 계획 승인 대기 (interrupt)
  | "offline";     // 백엔드 연결 불가

type AgentState = {
  status: AgentStatus;
  sessionId: string | null;
  videoPath: string | null; // 서버 기준 상대 경로 (videos/xxx.mp4)
  videoUrl: string | null;  // 업로드 원본 재생 URL (절대)
  uploadPct: number;        // 업로드 진행률 0..100 (uploading 일 때만 의미)
  backendUp: boolean | null; // null = 미확인
  feed: FeedItem[];
  lastFinal: FinalResult | null;

  checkBackend: () => Promise<boolean>;
  restoreSession: () => Promise<void>;
  uploadAndStart: (file: File) => Promise<void>;
  sendChat: (text: string) => void;
  resolveInterrupt: (approved: boolean, feedback?: string) => void;
  pushError: (text: string) => void;
  reset: () => void;
};

// ---- 모듈 레벨 소켓 상태 (리렌더와 무관) ----

let ws: WebSocket | null = null;
let wsSession: string | null = null;       // 이 소켓이 연결된 세션
let wsConnecting: Promise<WebSocket> | null = null; // in-flight connect 가드
let reconnectTried = false;                // 세션당 자동 재접속 1회

let nextItemId = 1;
let restoreStarted = false; // StrictMode 이중 effect 로 인한 복원 중복 방지 래치

function push(item: FeedPayload) {
  useAgent.setState((s) => ({ feed: [...s.feed, { ...item, id: nextItemId++ }] }));
}

function setStatus(status: AgentStatus) {
  useAgent.setState({ status });
}

/** 마지막 interrupt 카드가 미해결이면 true */
function hasUnresolvedInterrupt(): boolean {
  const { feed } = useAgent.getState();
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = feed[i];
    if (it.kind === "interrupt") return !it.resolved;
  }
  return false;
}

function persistSession() {
  try {
    const { sessionId, videoPath, videoUrl } = useAgent.getState();
    if (sessionId) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId, videoPath, videoUrl }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* localStorage 불가 환경 무시 */
  }
}

function teardownSocket() {
  if (ws) {
    // 핸들러를 떼고 닫아야 이전 세션 이벤트가 새 세션 피드에 섞이지 않음
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  ws = null;
  wsSession = null;
  wsConnecting = null;
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
    // 재접속 복원 시 서버가 같은 interrupt 를 다시 보낼 수 있음 — 미해결 카드가
    // 이미 떠 있으면 중복 카드를 만들지 않는다
    if (!hasUnresolvedInterrupt()) {
      push({ kind: "interrupt", payload: (ev.payload as InterruptPayload) ?? {} });
    }
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
    const prev = useAgent.getState().lastFinal;
    if ((result.outputPath || result.outputUrl) && result.outputPath !== prev?.outputPath) {
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
    // 에러 후 상태 복구 — 미해결 승인이 있으면 awaiting, 아니면 ready
    const st = useAgent.getState().status;
    if (st === "running" || st === "awaiting") {
      setStatus(hasUnresolvedInterrupt() ? "awaiting" : "ready");
    }
    return;
  }
}

function connectWS(sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`${WS_BASE}/ws/chat/${sessionId}`);

    sock.onopen = () => resolve(sock);

    sock.onmessage = (e) => {
      if (sock !== ws) return; // 교체된(stale) 소켓 이벤트 무시
      try {
        handleEvent(JSON.parse(e.data));
      } catch {
        /* 비 JSON 프레임 무시 */
      }
    };

    sock.onclose = (e) => {
      if (sock !== ws) return; // 교체된 소켓의 close 는 무시
      ws = null;
      wsSession = null;
      wsConnecting = null;

      if (e.code === 4004) {
        push({ kind: "error", text: "세션이 만료됐어요. 영상을 다시 업로드해 주세요." });
        useAgent.setState({ status: "no-session", sessionId: null });
        persistSession();
        return;
      }

      const st = useAgent.getState().status;
      if (st === "running" || st === "awaiting") {
        // 실행 중 끊김 — 1회 자동 재접속. 서버가 미해결 interrupt 를 재전송해준다.
        if (!reconnectTried) {
          reconnectTried = true;
          push({ kind: "info", text: "연결이 끊겨 재접속 중..." });
          setTimeout(() => {
            void ensureWS()
              .then(() => {
                push({ kind: "info", text: "재접속 완료" });
                // 실행 결과를 놓쳤을 수 있으니 세션 상태를 서버에서 회수
                void syncFromServer();
              })
              .catch(() => {
                push({ kind: "error", text: "재접속 실패 — 백엔드 상태를 확인해 주세요." });
                setStatus(hasUnresolvedInterrupt() ? "awaiting" : "ready");
              });
          }, 800);
        } else {
          push({ kind: "error", text: "연결이 끊겼어요. 백엔드 상태를 확인해 주세요." });
          setStatus(hasUnresolvedInterrupt() ? "awaiting" : "ready");
        }
      }
    };

    sock.onerror = () => {
      if (sock.readyState !== WebSocket.OPEN) reject(new Error("WebSocket 연결 실패"));
    };
  });
}

async function ensureWS(): Promise<WebSocket | null> {
  const { sessionId } = useAgent.getState();
  if (!sessionId) return null;

  // 열려 있어도 다른 세션 소켓이면 폐기 후 재연결 (세션-소켓 바인딩)
  if (ws && ws.readyState === WebSocket.OPEN && wsSession === sessionId) return ws;
  if (wsConnecting) return wsConnecting; // in-flight 연결 재사용

  if (ws) teardownSocket();

  wsConnecting = connectWS(sessionId).then((sock) => {
    ws = sock;
    wsSession = sessionId;
    wsConnecting = null;
    return sock;
  });
  wsConnecting.catch(() => {
    wsConnecting = null;
  });
  return wsConnecting;
}

/** 놓친 결과 회수: GET /session — final / pending interrupt / context 복원 */
async function syncFromServer(): Promise<void> {
  const { sessionId, lastFinal } = useAgent.getState();
  if (!sessionId) return;
  try {
    const res = await fetch(`${AGENT_API}/session/${sessionId}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.final_output_path && data.final_output_path !== lastFinal?.outputPath) {
      const result: FinalResult = {
        outputPath: data.final_output_path,
        outputUrl: data.final_output_url ?? null,
        videoContext: data.video_context ?? null,
        critic: null,
      };
      push({ kind: "final", result });
      useAgent.setState({ lastFinal: result });
    }

    if (data.pending_interrupt && !hasUnresolvedInterrupt()) {
      push({ kind: "interrupt", payload: data.pending_interrupt });
      setStatus("awaiting");
    } else if (!data.pending_interrupt && useAgent.getState().status === "running") {
      setStatus("ready");
    }
  } catch {
    /* 회수 실패는 치명적이지 않음 */
  }
}

/** XHR 업로드 (fetch 는 업로드 진행률 미지원) */
function uploadWithProgress(file: File): Promise<{ path: string; url: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${AGENT_API}/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        useAgent.setState({ uploadPct: Math.round((e.loaded / e.total) * 100) });
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("업로드 응답 파싱 실패"));
        }
      } else {
        let detail = `HTTP ${xhr.status}`;
        try {
          detail = JSON.parse(xhr.responseText).detail ?? detail;
        } catch {
          /* keep status text */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("네트워크 오류 — 백엔드가 켜져 있는지 확인하세요"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

// ---- 스토어 ----

export const useAgent = create<AgentState>((set, get) => ({
  status: "no-session",
  sessionId: null,
  videoPath: null,
  videoUrl: null,
  uploadPct: 0,
  backendUp: null,
  feed: [],
  lastFinal: null,

  checkBackend: async () => {
    try {
      const res = await fetch(`${AGENT_API}/health`, { signal: AbortSignal.timeout(3000) });
      const up = res.ok;
      set({ backendUp: up });
      if (up && get().status === "offline") set({ status: get().sessionId ? "ready" : "no-session" });
      return up;
    } catch {
      set({ backendUp: false });
      return false;
    }
  },

  restoreSession: async () => {
    // 새로고침 후 이전 세션 복원 (localStorage → GET /session 검증)
    if (restoreStarted || get().sessionId) return;
    restoreStarted = true;
    let saved: { sessionId?: string; videoPath?: string; videoUrl?: string } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved?.sessionId) return;

    try {
      const res = await fetch(`${AGENT_API}/session/${saved.sessionId}`);
      if (!res.ok) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const data = await res.json();
      set({
        sessionId: saved.sessionId,
        videoPath: saved.videoPath ?? null,
        videoUrl: saved.videoUrl ?? null,
        status: "ready",
        backendUp: true,
      });
      reconnectTried = false;
      push({ kind: "info", text: "이전 세션을 복원했어요." });

      if (data.final_output_path) {
        const result: FinalResult = {
          outputPath: data.final_output_path,
          outputUrl: data.final_output_url ?? null,
          videoContext: data.video_context ?? null,
          critic: null,
        };
        push({ kind: "final", result });
        set({ lastFinal: result });
      }
      if (data.pending_interrupt) {
        push({ kind: "interrupt", payload: data.pending_interrupt });
        set({ status: "awaiting" });
      }
      await ensureWS();
    } catch {
      /* 백엔드 다운 — checkBackend 가 offline 표시 */
    }
  },

  uploadAndStart: async (file: File) => {
    const st = get().status;
    if (st === "uploading") return;
    if (st === "running" || st === "awaiting") {
      push({ kind: "error", text: "실행 중에는 새 영상을 올릴 수 없어요. '새 세션'으로 초기화 후 시도하세요." });
      return;
    }

    // 이전 세션 상태 백업 (실패 시 복구)
    const prev = {
      status: st,
      sessionId: get().sessionId,
      videoPath: get().videoPath,
      videoUrl: get().videoUrl,
    };

    set({ status: "uploading", uploadPct: 0 });
    push({ kind: "info", text: `업로드 중: ${file.name} (${(file.size / 1e6).toFixed(1)}MB)` });
    try {
      const up = await uploadWithProgress(file);

      const sessRes = await fetch(`${AGENT_API}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_paths: [up.path] }),
      });
      if (!sessRes.ok) throw new Error(`세션 생성 실패 (${sessRes.status})`);
      const sess = (await sessRes.json()) as { session_id: string };

      // 새 세션 확정 — 이전 세션 소켓은 반드시 폐기 (세션-소켓 바인딩)
      teardownSocket();
      reconnectTried = false;
      set({
        sessionId: sess.session_id,
        videoPath: up.path,
        videoUrl: `${AGENT_API}${up.url}`,
        status: "ready",
        backendUp: true,
        uploadPct: 100,
      });
      persistSession();
      push({ kind: "info", text: "영상 준비 완료 — 이제 편집을 지시해 보세요." });
      await ensureWS();
    } catch (err) {
      push({ kind: "error", text: `업로드 실패: ${err instanceof Error ? err.message : err}` });
      // 이전 세션이 살아 있으면 그대로 복귀, 없으면 no-session
      set({
        status: prev.sessionId ? "ready" : "no-session",
        sessionId: prev.sessionId,
        videoPath: prev.videoPath,
        videoUrl: prev.videoUrl,
      });
      void get().checkBackend();
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
        setStatus(hasUnresolvedInterrupt() ? "awaiting" : "ready");
        void get().checkBackend();
      });
  },

  resolveInterrupt: (approved: boolean, feedback?: string) => {
    // 전송 성공 후에만 카드를 resolved 로 마킹 (실패 시 승인 버튼 유지)
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
        useAgent.setState((s) => {
          const feed = [...s.feed];
          for (let i = feed.length - 1; i >= 0; i--) {
            const it = feed[i];
            if (it.kind === "interrupt" && !it.resolved) {
              feed[i] = { ...it, resolved: approved ? "approved" : "feedback" };
              break;
            }
          }
          return { feed, status: "running" };
        });
      })
      .catch((err) => {
        push({ kind: "error", text: `승인 전송 실패: ${err instanceof Error ? err.message : err}` });
        setStatus("awaiting"); // 카드는 미해결 그대로 — 재시도 가능
        void get().checkBackend();
      });
  },

  pushError: (text: string) => {
    push({ kind: "error", text });
  },

  reset: () => {
    teardownSocket();
    reconnectTried = false;
    set({
      status: "no-session",
      sessionId: null,
      videoPath: null,
      videoUrl: null,
      uploadPct: 0,
      feed: [],
      lastFinal: null,
    });
    persistSession();
  },
}));
