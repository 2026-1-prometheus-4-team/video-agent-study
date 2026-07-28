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
 *   client → { type:"chat", message }
 *          | { type:"resume", approved?, feedback?, reply?, selected? }
 *          | { type:"cancel" }
 *   server → { type: message|tool_call|tool_result|interrupt|phase|video_context
 *                    |final|info|ping|done|error, ... }
 *   interrupt payload 는 두 종류:
 *     script_approval: { plan, questions, instructions }
 *     clarify:         { question, candidates:[{start_ms,end_ms,label,score}],
 *                        options, context, instructions }
 *   done = "턴 종료" (세션은 계속 살아있음).
 */

import {
  useAgentStore,
  type ClarifyCandidate,
  type CreativeBrief,
  type PlanStep,
} from "./state";

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

/**
 * 여러 영상 파일을 순차 업로드하고 store 에 누적한다.
 * 각 파일: 로컬 blob 프리뷰 즉시 → 서버 업로드 → addVideo.
 * 반환: 성공한 서버 경로 목록.
 */
export async function uploadVideos(files: File[]): Promise<string[]> {
  const store = useAgentStore.getState();
  const ok: string[] = [];
  const total = files.length;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const url = URL.createObjectURL(f);
    store.setUpload(Math.round((i / total) * 100), undefined, undefined);
    try {
      const res = await uploadVideo(f);
      store.addVideo(res.path, f.name, url);
      ok.push(res.path);
    } catch {
      // 개별 실패는 건너뛴다 — 나머지는 계속 시도.
    }
  }
  store.setUpload(100);
  persistStudioSession();
  return ok;
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
  | { type: "tool_call"; tool_call_id?: string; node?: string; tool_name: string; args?: Record<string, unknown> }
  | { type: "tool_result"; tool_call_id?: string; ok?: boolean; result?: unknown; detail?: string }
  | {
      type: "interrupt";
      // script_approval | clarify — 파싱은 applyInterruptPayload 에서 분기.
      payload?: Record<string, unknown>;
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
      success?: boolean;
      output_path?: string;
      output_url?: string;
      video_context?: Record<string, unknown>;
      critic?: { message_to_user?: string };
    }
  | { type: "info"; content?: string }
  | { type: "ping" }
  | { type: "done" }
  | { type: "resume_accepted" }
  | {
      type: "error";
      detail: string;
      code?: "RESUME_NOT_READY" | "NO_PENDING_INTERRUPT" | string;
      retry_after_ms?: number;
    };

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

// ---------- 공용 파서 (WS interrupt 이벤트 · GET /session pending_interrupt) ----------

type WireVideoContext = {
  file_path?: string;
  duration?: number;
  scenes?: Array<{ start: number; end: number; description?: string }>;
  transcript?: Array<{ start: number; end: number; text?: string }>;
};

function mapVideoContext(vc: WireVideoContext) {
  return {
    file_path: vc.file_path ?? "",
    duration: typeof vc.duration === "number" ? vc.duration : 0,
    scenes: (vc.scenes ?? []).map((sc) => ({
      start: sc.start,
      end: sc.end,
      description: sc.description ?? "",
    })),
    transcript: (vc.transcript ?? []).map((t) => ({
      start: t.start,
      end: t.end,
      text: t.text ?? "",
    })),
  };
}

/**
 * interrupt payload 를 종류(script_approval | clarify)에 따라 store 카드로 변환.
 * pushInterrupt/pushClarify 가 내부에서 미해결 카드 dedupe 를 수행하므로
 * WS 재접속 시 서버가 재전송한 pending interrupt 로 중복 카드가 생기지 않음.
 */
export function applyInterruptPayload(payloadRaw: unknown) {
  const payload = (payloadRaw ?? {}) as Record<string, unknown>;
  const store = useAgentStore.getState();

  if (payload.type === "clarify") {
    const candidatesRaw = Array.isArray(payload.candidates)
      ? (payload.candidates as Array<Record<string, unknown>>)
      : [];
    const candidates: ClarifyCandidate[] = candidatesRaw.map((c) => ({
      startMs: typeof c.start_ms === "number" ? c.start_ms : 0,
      endMs: typeof c.end_ms === "number" ? c.end_ms : 0,
      label: typeof c.label === "string" ? c.label : "",
      score: typeof c.score === "number" ? c.score : undefined,
    }));
    const options = Array.isArray(payload.options)
      ? (payload.options as unknown[]).filter(
          (o): o is string => typeof o === "string"
        )
      : [];
    store.pushClarify(
      typeof payload.question === "string" ? payload.question : "",
      candidates,
      options,
      typeof payload.context === "string" ? payload.context : ""
    );
    return;
  }

  // script_approval (기본). 예전 이름 script_plan 도 방어적으로 지원.
  const planLike =
    (payload.plan as Record<string, unknown> | undefined) ??
    (payload.script_plan as Record<string, unknown> | undefined) ??
    {};
  const stepsRaw = Array.isArray(planLike.steps)
    ? (planLike.steps as Array<Record<string, unknown>>)
    : [];
  const steps: PlanStep[] = stepsRaw.map((raw, idx) => ({
    id: (raw.step_id as number) ?? idx + 1,
    action: (raw.action as string) ?? "",
    expert: asNode((raw.expert as string) ?? "orchestrator"),
    rationale: (raw.rationale as string) ?? "",
    estimatedSec: raw.estimated_sec as number | undefined,
    parallelGroup: (raw.parallel_group as number | null | undefined) ?? null,
    dependsOn: raw.depends_on as number[] | undefined,
  }));
  const questions = Array.isArray(planLike.questions)
    ? (planLike.questions as string[])
    : Array.isArray(payload.questions)
      ? (payload.questions as string[])
      : [];
  const creativeBrief = parseCreativeBrief(planLike.creative_brief);
  store.pushInterrupt(steps, questions, creativeBrief);
}

function parseCreativeBrief(raw: unknown): CreativeBrief | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const brief = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const directingRaw =
    brief.directing && typeof brief.directing === "object"
      ? (brief.directing as Record<string, unknown>)
      : {};
  const storyboardRaw = Array.isArray(brief.storyboard)
    ? (brief.storyboard as Array<Record<string, unknown>>)
    : [];

  return {
    title: text(brief.title),
    concept: text(brief.concept),
    intent: text(brief.intent),
    hook: text(brief.hook),
    targetDurationSec: number(brief.target_duration_sec),
    durationReason: text(brief.duration_reason),
    recommendedBgm: text(brief.recommended_bgm),
    bgmFlow: text(brief.bgm_flow),
    storyboard: storyboardRaw.map((item, index) => ({
      idx: number(item.idx) ?? index + 1,
      outputStartMs: number(item.output_start_ms),
      outputEndMs: number(item.output_end_ms),
      role: text(item.role),
      source: text(item.source),
      sourceStartMs: number(item.source_start_ms),
      sourceEndMs: number(item.source_end_ms),
      visual: text(item.visual),
      selectionReason: text(item.selection_reason),
      onScreenText: text(item.on_screen_text),
      narration: text(item.narration),
      editDirection: text(item.edit_direction),
      sfx: text(item.sfx),
    })),
    directing: {
      cutTempo: text(directingRaw.cut_tempo),
      subtitleAndFont: text(directingRaw.subtitle_and_font),
      visualAndSpeed: text(directingRaw.visual_and_speed),
    },
    userRevisionGuide: Array.isArray(brief.user_revision_guide)
      ? brief.user_revision_guide.filter(
          (item): item is string => typeof item === "string"
        )
      : [],
  };
}

// ---------- Module-level socket singleton ----------

let currentSocket: AgentSocket | null = null;

export function getSocket(): AgentSocket | null {
  return currentSocket;
}

// ---------- 세션 영속 (localStorage) ----------

const STUDIO_SESSION_KEY = "studio-v2-session";

interface PersistedStudioSession {
  sessionId: string;
  serverVideoPath: string | null;
  uploadedName: string | null;
  serverVideoPaths?: string[];
  uploadedNames?: string[];
}

/** 현재 store 의 세션 식별 정보를 localStorage 에 저장 (없으면 제거). */
export function persistStudioSession() {
  try {
    const { sessionId, serverVideoPath, uploadedName, serverVideoPaths, uploadedNames } =
      useAgentStore.getState();
    if (sessionId) {
      const data: PersistedStudioSession = {
        sessionId,
        serverVideoPath,
        uploadedName,
        serverVideoPaths,
        uploadedNames,
      };
      localStorage.setItem(STUDIO_SESSION_KEY, JSON.stringify(data));
    } else {
      localStorage.removeItem(STUDIO_SESSION_KEY);
    }
  } catch {
    // localStorage 불가 환경 (SSR/시크릿) 무시
  }
}

export function clearStudioSession() {
  try {
    localStorage.removeItem(STUDIO_SESSION_KEY);
  } catch {
    // ignore
  }
}

// StrictMode 이중 effect 로 인한 복원 중복 방지 래치
let restoreStarted = false;

/**
 * 새로고침 후 세션 복원. StudioShell 마운트 시 1회 호출.
 * localStorage → GET /session/{id} 검증 → videoContext/final/pending interrupt
 * 복원 → WS 재연결. 404/실패 시 localStorage 클리어 후 새 상태로 시작.
 */
export async function restoreStudioSession(): Promise<void> {
  if (restoreStarted) return;
  restoreStarted = true;
  if (typeof window === "undefined") return;

  let saved: PersistedStudioSession | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(STUDIO_SESSION_KEY) ?? "null");
  } catch {
    saved = null;
  }
  if (!saved?.sessionId) return;
  if (useAgentStore.getState().sessionId) return; // 이미 활성 세션

  // let 변수는 closure 안에서 narrowing 이 풀리므로 const 로 고정.
  const persisted = saved;

  try {
    const res = await fetch(`${API_BASE}/session/${persisted.sessionId}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      clearStudioSession();
      return;
    }
    const data = (await res.json()) as {
      video_context?: WireVideoContext | null;
      final_output_path?: string;
      final_output_url?: string | null;
      pending_interrupt?: Record<string, unknown> | null;
    };

    // TOCTOU 재확인 — 위 await 들이 도는 동안(StudioShell 은 이 함수를 await 하지
    // 않는다) 사용자가 첫 메시지를 보내 새 세션이 생겼을 수 있다. 그때 늦게 도착한
    // 복원이 sessionId 를 덮어쓰면 진행 중인 턴이 고아가 되므로 복원 전체를 포기.
    // localStorage 는 이미 새 세션 것이므로 건드리지 않는다.
    if (useAgentStore.getState().sessionId || currentSocket) return;

    const store = useAgentStore.getState();

    // 세션 채널만 복원 — startSession 은 status 를 streaming 으로 밀어서 안 씀.
    useAgentStore.setState((s) => {
      s.sessionId = persisted.sessionId;
      s.sessionStatus = "idle";
    });

    // 업로드 메타 복원. blob URL 은 재생성 불가 — 서버 정적 URL 로 유추.
    // 멀티 영상: 저장된 전체 목록을 복원 (없으면 단수 필드로 폴백).
    const paths =
      persisted.serverVideoPaths && persisted.serverVideoPaths.length > 0
        ? persisted.serverVideoPaths
        : persisted.serverVideoPath
          ? [persisted.serverVideoPath]
          : [];
    const names =
      persisted.uploadedNames && persisted.uploadedNames.length > 0
        ? persisted.uploadedNames
        : persisted.uploadedName
          ? [persisted.uploadedName]
          : [];
    paths.forEach((p, i) => {
      const m = p.match(/^(?:.*[/\\])?videos\/(.+)$/);
      const url = m ? `${API_BASE}/files/videos/${m[1]}` : undefined;
      store.addVideo(p, names[i] ?? p.split("/").pop() ?? p, url ?? undefined);
    });

    const vc = data.video_context;
    if (vc && typeof vc === "object") {
      store.setVideoContext(mapVideoContext(vc));
    }

    store.pushInfo("이전 세션을 복원했어");

    if (data.final_output_path) {
      const mapped = vc ? mapVideoContext(vc) : null;
      store.pushFinal(data.final_output_path, mapped?.duration ?? 0, {
        outputUrl: data.final_output_url
          ? `${API_BASE}${data.final_output_url}`
          : undefined,
        scenes: mapped?.scenes,
        transcript: mapped?.transcript,
      });
    }

    if (data.pending_interrupt) {
      applyInterruptPayload(data.pending_interrupt);
    }

    // WS 재연결 — 서버가 pending interrupt 를 다시 보내도 dedupe 로 중복 카드 X.
    const sock = new AgentSocket(persisted.sessionId);
    sock.connect();
    currentSocket = sock;
    await sock.ready(6000).catch(() => undefined);
  } catch {
    clearStudioSession();
  }
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
    // 멀티 영상: 업로드된 전체 경로를 세션에 넘긴다 (analysis_node 가 병렬 분석).
    // 인자 videoPath 는 하위호환 폴백.
    const paths = useAgentStore.getState().serverVideoPaths;
    const videoPaths =
      paths.length > 0 ? paths : videoPath ? [videoPath] : [];
    const { session_id } = await createSession(videoPaths);
    useAgentStore.getState().startSession(session_id);
    persistStudioSession();
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

/**
 * clarify interrupt 답변 전송.
 * reply(자유 텍스트)와 selected(후보 인덱스 배열)는 둘 중 하나만 있어도 됨.
 */
export function tryResumeClarify(
  reply: string,
  selected: number[],
  appendReplyOnAccept = true
): boolean {
  if (!currentSocket) return false;
  try {
    currentSocket.resumeClarify(reply, selected, appendReplyOnAccept);
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

// 다른 탭이 먼저 응답해 interrupt 가 이미 해소된 뒤 resume 을 보냈을 때 서버가
// 주는 error (backend/server.py). 이 경우 우리 쪽 pending 카드가 고아가 된다.
const STALE_RESUME_DETAIL = "대기 중인 승인 요청이 없습니다";

export class AgentSocket {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private closedByUser = false;
  private retries = 0;
  private currentAgentMsgId: string | null = null;
  private currentToolStack: string[] = []; // FIFO 로 tool_result 매핑
  private toolIds = new Map<string, string>();
  private openWaiters: Array<() => void> = [];
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResume: {
    payload: Record<string, unknown>;
    resolution: "approved" | "revised" | "answered";
    feedback?: string;
    reply?: string;
    appendReplyOnAccept?: boolean;
  } | null = null;
  private resumeRetryCount = 0;
  private resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // 이번 턴이 error 이벤트 또는 사용자 cancel 로 깨졌는지. 서버는 중단된 tool 의
  // tool_result 를 보내지 않으므로, flush 시 이 값으로 성공/실패를 가른다.
  private turnBroken = false;
  private turnBrokenReason: string | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** 어떤 이벤트든 오면 watchdog 리셋. */
  bumpWatchdog() {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      const st = useAgentStore.getState();
      // streaming 일 때만 발동 — awaiting-interrupt (사용자 응답 대기) ·
      // completed · idle 은 서버 침묵이 정상이므로 가짜 에러 금지.
      if (st.sessionStatus === "streaming") {
        st.pushError(
          "응답 없음",
          `${Math.round(WATCHDOG_MS / 1000)}초간 서버 이벤트 없음. 백엔드 상태 확인해봐.`
        );
      }
    }, WATCHDOG_MS);
  }

  /** 턴이 끝났거나 사용자 응답 대기로 전환되면 watchdog 을 멈춘다. */
  stopWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
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
          // 죽은 세션은 복원 대상에서도 제외.
          clearStudioSession();
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
    if (this.resumeRetryTimer) {
      clearTimeout(this.resumeRetryTimer);
      this.resumeRetryTimer = null;
    }
    this.pendingResume = null;
    this.resumeRetryCount = 0;
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
    this.turnBroken = false;
    this.turnBrokenReason = null;
    this.bumpWatchdog();
  }

  resume(approved: boolean, feedback?: string) {
    const payload = {
      type: "resume",
      approved,
      feedback: approved ? undefined : feedback,
    };
    this.pendingResume = {
      payload,
      resolution: approved ? "approved" : "revised",
      feedback,
    };
    this.resumeRetryCount = 0;
    this.send(payload);
    this.turnBroken = false;
    this.turnBrokenReason = null;
    this.bumpWatchdog();
  }

  /** clarify interrupt 답변: reply(텍스트)/selected(후보 인덱스) 조합. */
  resumeClarify(
    reply: string,
    selected: number[],
    appendReplyOnAccept = true
  ) {
    const payload: Record<string, unknown> = { type: "resume" };
    if (reply) payload.reply = reply;
    if (selected.length > 0) payload.selected = selected;
    this.pendingResume = {
      payload,
      resolution: "answered",
      reply,
      appendReplyOnAccept,
    };
    this.resumeRetryCount = 0;
    this.send(payload);
    this.turnBroken = false;
    this.turnBrokenReason = null;
    this.bumpWatchdog();
  }

  cancel() {
    this.send({ type: "cancel" });
    // 중지된 턴의 남은 tool 카드는 성공이 아니다.
    this.turnBroken = true;
    this.turnBrokenReason = "사용자가 작업을 중지했어";
  }

  /**
   * 턴 종료 시 tool_result 를 못 받은 카드 마감. 서버는 중단/실패한 tool 의
   * tool_result 를 보내지 않으므로, 이번 턴이 깨졌으면 실패로 닫는다.
   */
  private flushToolStack() {
    const store = useAgentStore.getState();
    while (this.currentToolStack.length) {
      const id = this.currentToolStack.shift()!;
      if (this.turnBroken) {
        store.endTool(id, false, undefined, this.turnBrokenReason || "서버 오류로 결과를 받지 못했어");
      } else {
        store.endTool(id, true);
      }
    }
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
        if (ev.tool_call_id) this.toolIds.set(ev.tool_call_id, id);
        break;
      }
      case "tool_result": {
        const mapped = ev.tool_call_id ? this.toolIds.get(ev.tool_call_id) : undefined;
        const id = mapped ?? this.currentToolStack.shift();
        if (id) {
          this.currentToolStack = this.currentToolStack.filter((x) => x !== id);
          if (ev.tool_call_id) this.toolIds.delete(ev.tool_call_id);
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
        // 사용자 응답 대기 — 서버 침묵이 정상이므로 watchdog 정지.
        this.stopWatchdog();
        applyInterruptPayload(ev.payload);
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
          success: ev.success !== false,
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
        // 남은 tool 카드 마감 (이번 턴이 깨졌으면 실패로)
        this.flushToolStack();
        break;
      }
      case "info": {
        // 큐잉 안내 / cancel 접수 ack 등 — 스트림에 그대로 노출.
        const content = String(ev.content ?? "").trim();
        if (content) store.pushInfo(content);
        break;
      }
      case "ping": {
        // 침묵 하트비트 — watchdog 리셋은 message listener 에서 이미 처리.
        break;
      }
      case "done": {
        // 턴 종료 (세션은 계속 살아있음). 남은 tool 카드 정리 후 completed 로.
        this.flushToolStack();
        this.stopWatchdog();
        store.endTurn();
        // 다음 턴 (큐잉된 chat 이 서버에서 자동 실행되는 경우 포함) 을 위해 리셋.
        this.turnBroken = false;
        this.turnBrokenReason = null;
        this.toolIds.clear();
        break;
      }
      case "resume_accepted": {
        // Only resolve the card after the backend confirms that Command(resume)
        // was started. Until this ack arrives the card remains available while
        // transient RESUME_NOT_READY responses are retried.
        const pending = this.pendingResume;
        if (pending) {
          if (pending.resolution === "answered") {
            if (pending.reply && pending.appendReplyOnAccept) {
              store.appendUser(pending.reply);
            }
            store.markInterruptResolved("answered");
          } else {
            store.resolveInterrupt(
              pending.resolution === "approved",
              pending.feedback
            );
          }
        }
        if (this.resumeRetryTimer) clearTimeout(this.resumeRetryTimer);
        this.resumeRetryTimer = null;
        this.pendingResume = null;
        this.resumeRetryCount = 0;
        break;
      }
      case "error": {
        if (ev.code === "RESUME_NOT_READY" && this.pendingResume) {
          const delays = [200, 500, 1000];
          if (this.resumeRetryCount < delays.length) {
            const delay = Math.max(
              ev.retry_after_ms ?? 0,
              delays[this.resumeRetryCount]
            );
            this.resumeRetryCount += 1;
            if (this.resumeRetryTimer) clearTimeout(this.resumeRetryTimer);
            this.resumeRetryTimer = setTimeout(() => {
              if (!this.pendingResume) return;
              try {
                this.send(this.pendingResume.payload);
                this.bumpWatchdog();
              } catch {
                // A reconnect/error event will preserve the unresolved card.
              }
            }, delay);
            store.pushInfo("질문 상태를 정리하는 중이에요. 답변을 자동으로 다시 전송할게요.");
            break;
          }

          // Keep the interrupt unresolved so the user can submit it again.
          this.pendingResume = null;
          this.resumeRetryCount = 0;
          this.stopWatchdog();
          store.pushInfo("답변 자동 전송에 실패했어요. 선택 카드에서 다시 시도해주세요.");
          break;
        }

        if (ev.code === "NO_PENDING_INTERRUPT" && this.pendingResume) {
          if (this.resumeRetryTimer) clearTimeout(this.resumeRetryTimer);
          this.resumeRetryTimer = null;
          this.pendingResume = null;
          this.resumeRetryCount = 0;
        }

        // 이번 턴은 깨졌다 — 이후 flush 되는 tool 카드를 초록색으로 닫지 않게.
        this.turnBroken = true;
        this.turnBrokenReason = ev.detail || "서버 오류로 결과를 받지 못했어";
        store.pushError("오류", ev.detail);
        // 다른 탭이 먼저 응답해 interrupt 가 이미 해소된 상태에서 우리가 resume 을
        // 보낸 경우. 낙관적으로 띄운 pending phase 카드가 영원히 도는 걸 막고,
        // stale pendingInterrupt 를 클리어해 다음 입력이 chat 으로 나가게 한다.
        if ((ev.detail ?? "").includes(STALE_RESUME_DETAIL)) {
          store.endPhase("pending");
          useAgentStore.setState((s) => {
            s.pendingInterrupt = null;
          });
        }
        break;
      }
    }
  }
}
