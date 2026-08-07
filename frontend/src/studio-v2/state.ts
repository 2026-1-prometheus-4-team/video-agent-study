/**
 * studio-v2 상태 관리 (zustand + immer).
 *
 * 백엔드 WebSocket 이벤트를 각 카드/스트림으로 흘려주는 단일 소스.
 * mock 모드는 mockStream.ts 에서 이 store 를 동일하게 사용.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

// ---------- Types ----------

export type Node =
  | "orchestrator"
  | "research"
  | "planning"
  | "edit"
  | "critic";

export type ConnectionStatus =
  | "online"
  | "connecting"
  | "offline"
  | "reconnecting";

export type SessionStatus =
  | "idle"
  | "streaming"
  | "awaiting-interrupt"
  | "completed"
  | "error";

/** 큐가 들고 있는 자기 스타일. 문서 기본값을 덮어쓴다. */
export type CueStyle = {
  font?: string;
  size?: number;
  color?: string;
  stroke_color?: string;
  stroke_width?: number;
  position?: "top" | "middle" | "bottom";
  margin_v?: number;
  bold?: boolean;
};

/**
 * 자막/제목 큐 하나.
 *
 * role 은 제목("title")과 대사를 가르는 유일한 표시고, style 은 그 큐의 실제
 * 서식이다. 둘 다 서버가 보내주기 전에는 인스펙터가 기본값을 진짜 값인 척
 * 보여줬다 — 제목을 열면 "아래 · 26px" 로 뜨고, 건드리는 순간 그 값이 저장됐다.
 * id 는 저장 시 배열 위치 대신 쓰는 매칭 키다.
 */
export type TranscriptSeg = {
  start: number;
  end: number;
  text: string;
  id?: string;
  role?: string;
  style?: CueStyle;
};
export type SceneSeg = { start: number; end: number; description: string };

/**
 * 서버 라이브러리(GET /media)의 영상 하나.
 *
 * 업로드가 끝나면 여기 남는다. 실행이 실패해도 목록은 유지되므로 같은 파일을
 * 다시 올릴 필요가 없다 — 재선택하고 다시 지시하면 된다.
 */
export interface MediaItem {
  name: string;
  originalName: string;
  path: string;
  url: string;
  size: number;
  duration: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  createdAt: string;
}

/** clarify interrupt 의 구간 후보 (서버 candidates 항목). */
export interface ClarifyCandidate {
  startMs: number;
  endMs: number;
  label: string;
  score?: number;
}

export interface StoryboardItem {
  idx: number;
  outputStartMs?: number;
  outputEndMs?: number;
  role: string;
  source: string;
  sourceStartMs?: number;
  sourceEndMs?: number;
  visual: string;
  selectionReason: string;
  onScreenText: string;
  narration: string;
  editDirection: string;
  sfx: string;
}

export interface CreativeBrief {
  title: string;
  concept: string;
  intent: string;
  hook: string;
  targetDurationSec?: number;
  durationReason: string;
  recommendedBgm: string;
  bgmFlow: string;
  storyboard: StoryboardItem[];
  directing: {
    cutTempo: string;
    subtitleAndFont: string;
    visualAndSpeed: string;
  };
  userRevisionGuide: string[];
}

export type StreamItem =
  | { kind: "user"; id: string; text: string; createdAt: number; files?: string[] }
  | {
      kind: "agent";
      id: string;
      text: string;
      createdAt: number;
      streaming: boolean;
      node?: Node;
    }
  | {
      kind: "tool";
      id: string;
      node: Node;
      tool: string;
      args: Record<string, unknown>;
      state: "running" | "success" | "error";
      startedAt: number;
      endedAt?: number;
      result?: unknown;
      errorMessage?: string;
    }
  | {
      kind: "interrupt";
      id: string;
      createdAt: number;
      plan: PlanStep[];
      questions: string[];
      creativeBrief?: CreativeBrief;
      resolved?: "approved" | "revised" | "answered";
      // interrupt 종류. 미지정이면 script_approval (하위호환).
      interruptKind?: "script_approval" | "clarify";
      // script_approval 전용 — 한국어 마크다운 기획안 (컨셉·타임라인·스크립트·
      // BGM·편집 팁). 있으면 steps 리스트 대신 <Markdown> 으로 렌더.
      planMarkdown?: string;
      // 기획 컨셉 이름 — 있으면 카드 제목으로 크게 표시.
      conceptName?: string;
      // clarify 전용 필드
      question?: string;
      candidates?: ClarifyCandidate[];
      options?: string[];
      context?: string;
    }
  | {
      kind: "final";
      id: string;
      createdAt: number;
      outputPath: string;
      outputUrl?: string;
      duration: number;
      criticNote?: string;
      success?: boolean;
      transcript?: TranscriptSeg[];
      scenes?: SceneSeg[];
    }
  | {
      kind: "info";
      id: string;
      createdAt: number;
      text: string;
    }
  | {
      kind: "error";
      id: string;
      createdAt: number;
      title: string;
      detail?: string;
      toolId?: string;
    }
  | {
      kind: "subtitle_style";
      id: string;
      createdAt: number;
      stem: string;
      status: "pending" | "applied";
      outputPath?: string;
    }
  | {
      kind: "phase";
      id: string;
      // 실제 노드 이름 (analysis/script/interrupt_gate/supervisor/critic) 또는
      // pending (첫 이벤트 도착 전 스켈레톤).
      phase: string;
      label: string;
      detail: string;
      state: "running" | "done";
      startedAt: number;
      endedAt?: number;
    };

export interface PlanStep {
  id: number;
  action: string;
  expert: Node;
  rationale: string;
  estimatedSec?: number;
  parallelGroup?: number | null;
  dependsOn?: number[];
}

export interface AgentState {
  // connection
  connection: ConnectionStatus;
  sessionId: string | null;
  sessionStatus: SessionStatus;
  // pipeline HUD
  activeNode: Node | null;
  nodeToolCount: Record<Node, number>;
  // stream
  stream: StreamItem[];
  // UI helpers
  streamingAgentId: string | null;
  pendingInterrupt: StreamItem & { kind: "interrupt" } | null;
  lastFinal: StreamItem & { kind: "final" } | null;
  // upload
  uploadPct: number | null;
  uploadedName: string | null; // 첫(대표) 영상 — 프리뷰/모션에디터가 참조
  uploadedUrl: string | null; // 첫 영상 재생 URL
  serverVideoPath: string | null; // 첫 영상 서버 경로
  // 멀티 영상 — 세션 생성 시 전부 video_paths 로 전달. 단수 필드는 [0] 미러.
  serverVideoPaths: string[];
  uploadedNames: string[];
  // 서버 라이브러리 전체 (선택 여부와 무관). serverVideoPaths 는 이 중 선택분.
  media: MediaItem[];
  mediaLoading: boolean;
  // 업로드 실패 사유 — 조용히 삼키면 사용자가 왜 안 되는지 알 수 없다.
  uploadError: string | null;
  // insights (video_context) — 실제 배열 포함
  videoContext: {
    file_path: string;
    duration: number;
    scenes: SceneSeg[];
    transcript: TranscriptSeg[];
  } | null;

  // ── Timeline · Stage 동기화 ──
  playhead: number;              // 현재 재생 위치 (초)
  playing: boolean;               // 재생 중 여부
  timelineZoom: number;           // 1 = 100%, 최소 1, 최대 8
  // 선택된 세그먼트 (scene/subtitle 인스펙터용).
  selected: { kind: "scene" | "subtitle"; index: number } | null;
  // Stage 재생 소스 (원본 · 편집본). Timeline 도 이걸 봐서 씬/자막 소스 결정.
  // 편집본이 도착하면 자동으로 "final" 로 스위치.
  stageViewMode: "source" | "final";
  // 현재 활성 재생 소스의 실제 duration (<video> metadata 기반).
  // lastFinal.duration / videoContext.duration 은 그래프 state 그대로라 편집으로
  // 실제 mp4 길이가 짧아지면 맞지 않음. Timeline 은 이 값을 우선 사용.
  stageVideoDuration: number;
  // 외부(채팅 카드·타임스탬프 칩)에서 요청한 시킹. nonce 로 같은 t 재요청도 감지.
  // Stage 가 이 값을 보고 playing 여부와 무관하게 video.currentTime 을 이동.
  seekRequest: { t: number; nonce: number } | null;
  // 자막 스타일 카드에서 "저장"할 때마다 증가. Stage 가 이 값을 구독해 새로고침
  // 없이 자막 스타일을 즉시 재조회하도록 한다.
  subtitleStyleVersion: number;

  // ---- actions ----
  setConnection: (c: ConnectionStatus) => void;
  startSession: (id: string) => void;
  appendUser: (text: string, files?: string[]) => void;
  startAgentMsg: (id: string, node?: Node) => void;
  appendAgentChunk: (id: string, chunk: string) => void;
  endAgentMsg: (id: string) => void;
  startTool: (
    id: string,
    node: Node,
    tool: string,
    args: Record<string, unknown>
  ) => void;
  endTool: (id: string, ok: boolean, result?: unknown, errorMessage?: string) => void;
  pushInterrupt: (
    plan: PlanStep[],
    questions: string[],
    opts?: {
      planMarkdown?: string;
      conceptName?: string;
      creativeBrief?: CreativeBrief;
    }
  ) => void;
  /** clarify interrupt 카드 push. 미해결 카드가 있으면 갱신 (dedupe). */
  pushClarify: (
    question: string,
    candidates: ClarifyCandidate[],
    options: string[],
    context: string
  ) => void;
  resolveInterrupt: (approved: boolean, feedback?: string) => void;
  /**
   * 미해결 interrupt 를 resolved 로만 마킹 (유저 버블 push 없음).
   * 전송 성공이 확인된 뒤에 호출 — 낙관적 마킹 금지.
   */
  markInterruptResolved: (
    resolution: "approved" | "revised" | "answered"
  ) => void;
  /** done 이벤트 = 턴 종료. 세션은 계속 살아있음 (completed 로 전환). */
  endTurn: () => void;
  pushFinal: (
    outputPath: string,
    duration: number,
    opts?: {
      criticNote?: string;
      success?: boolean;
      outputUrl?: string;
      transcript?: TranscriptSeg[];
      scenes?: SceneSeg[];
    }
  ) => void;
  pushInfo: (text: string) => void;
  pushError: (title: string, detail?: string, toolId?: string) => void;
  pushSubtitleStyle: (stem: string) => void;
  applySubtitleStyle: (id: string, outputPath: string) => void;
  /** 노드 진행 카드 시작. 이미 같은 phase 카드가 있으면 no-op. */
  startPhase: (phase: string, label: string, detail: string) => void;
  /** 진행 중인 phase 카드를 완료 상태로. label/detail 을 갱신하고 elapsed 를 fix. */
  endPhase: (phase: string, label?: string, detail?: string) => void;
  setUpload: (
    pct: number | null,
    name?: string | null,
    url?: string | null,
    serverPath?: string | null
  ) => void;
  /** 업로드 완료된 영상 하나를 목록에 추가. 첫 영상은 대표(단수) 필드도 채운다. */
  addVideo: (serverPath: string, name: string, url?: string | null) => void;
  /** 선택 해제 — 라이브러리에는 남기고 이번 세션 대상에서만 뺀다. */
  removeVideo: (serverPath: string) => void;
  /** 업로드 영상 목록 초기화 (새 세션 시작 등). */
  clearVideos: () => void;
  /** 서버 라이브러리 목록 교체 (GET /media 응답). */
  setMedia: (items: MediaItem[]) => void;
  setMediaLoading: (loading: boolean) => void;
  /** 업로드 직후 항목 반영 — 이미 있으면 갱신 (중복 재사용 시 그대로). */
  upsertMedia: (item: MediaItem) => void;
  /** 라이브러리에서 제거 (DELETE /media 성공 후). 선택 상태도 함께 정리. */
  dropMedia: (name: string) => void;
  setUploadError: (message: string | null) => void;
  setVideoContext: (ctx: AgentState["videoContext"]) => void;
  clearStream: () => void;
  /**
   * 세션 ID 만 세팅 (startSession 과 달리 status/파이프라인 초기화 없음).
   * 히스토리에서 지난 세션을 열 때 사용.
   */
  setSessionId: (id: string | null) => void;
  /**
   * 지난 대화(히스토리)에서 재구성한 StreamItem[] 로 스트림을 통째 교체.
   * 과거 기록은 읽기 위주라 streaming/pending/파이프라인 상태를 모두 초기화하고,
   * 마지막 final 이 있으면 lastFinal 로 복원한다. sessionStatus 는 idle.
   */
  hydrateStream: (items: StreamItem[]) => void;

  // Timeline · Stage 액션
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setTimelineZoom: (z: number) => void;
  selectSegment: (
    kind: "scene" | "subtitle" | null,
    index?: number | null
  ) => void;
  setStageViewMode: (m: "source" | "final") => void;
  setStageVideoDuration: (sec: number) => void;
  /** 지정 시각(초)으로 시킹 요청. 재생 중에도 Stage 가 즉시 이동 (재생 유지). */
  requestSeek: (t: number) => void;
}

// ---------- Store ----------

let idCounter = 0;
const nextId = () => `it-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

/**
 * 스트림에서 가장 최근 interrupt 카드가 미해결이면 반환.
 * WS 재접속 시 서버가 pending interrupt 를 재전송하는데, 이때 중복 카드를
 * 만들지 않고 기존 카드를 갱신하기 위한 dedupe 헬퍼.
 */
function lastUnresolvedInterrupt(
  stream: StreamItem[]
): Extract<StreamItem, { kind: "interrupt" }> | null {
  for (let i = stream.length - 1; i >= 0; i--) {
    const it = stream[i];
    if (it.kind === "interrupt") return it.resolved ? null : it;
  }
  return null;
}

/**
 * 서버가 턴을 정상 종료했다(done)는 건 그 턴의 interrupt 가 이미 소비됐다는 뜻 —
 * 서버는 interrupt 로 멈춘 턴에 done 을 보내지 않는다 (backend/server.py _run_turn).
 * Composer 가 script_approval 답변을 chat 으로 넘긴 경우 승인/수정 판정을 서버가
 * 하므로 카드가 미해결로 남는데, 여기서 중립적으로("답변 전송됨") 마감한다.
 * 승인 여부를 모르므로 "approved"/"revised" 로 단정하지 않는다.
 */
function settleStaleInterrupt(s: {
  stream: StreamItem[];
  pendingInterrupt: AgentState["pendingInterrupt"];
}) {
  const pending = s.pendingInterrupt;
  if (!pending) return;
  const found = s.stream.find(
    (x) => x.kind === "interrupt" && x.id === pending.id
  );
  if (found && found.kind === "interrupt" && !found.resolved) {
    found.resolved = "answered";
  }
  s.pendingInterrupt = null;
}

const initialNodeCount: Record<Node, number> = {
  orchestrator: 0,
  research: 0,
  planning: 0,
  edit: 0,
  critic: 0,
};

export const useAgentStore = create<AgentState>()(
  immer((set) => ({
    connection: "offline",
    sessionId: null,
    sessionStatus: "idle",
    activeNode: null,
    nodeToolCount: { ...initialNodeCount },
    stream: [],
    streamingAgentId: null,
    pendingInterrupt: null,
    lastFinal: null,
    uploadPct: null,
    uploadedName: null,
    uploadedUrl: null,
    serverVideoPath: null,
    serverVideoPaths: [],
    uploadedNames: [],
    media: [],
    mediaLoading: false,
    uploadError: null,
    videoContext: null,
    playhead: 0,
    playing: false,
    timelineZoom: 1,
    selected: null,
    stageViewMode: "source",
    stageVideoDuration: 0,
    seekRequest: null,
    subtitleStyleVersion: 0,

    setConnection: (c) =>
      set((s) => {
        s.connection = c;
      }),

    startSession: (id) =>
      set((s) => {
        s.sessionId = id;
        s.sessionStatus = "streaming";
        // 새 세션 = 파이프라인 상태 초기화. 잔재 카운터가 HUD 에 표시되던 이슈
        // (예: "7" 이 총괄 배지에 남는 것) 방지.
        s.activeNode = null;
        s.nodeToolCount = { ...initialNodeCount };
      }),

    appendUser: (text, files) =>
      set((s) => {
        s.stream.push({
          kind: "user",
          id: nextId(),
          text,
          files,
          createdAt: Date.now(),
        });
      }),

    startAgentMsg: (id, node) =>
      set((s) => {
        s.stream.push({
          kind: "agent",
          id,
          text: "",
          createdAt: Date.now(),
          streaming: true,
          node,
        });
        s.streamingAgentId = id;
        s.sessionStatus = "streaming";
      }),

    appendAgentChunk: (id, chunk) =>
      set((s) => {
        const item = s.stream.find((x) => x.kind === "agent" && x.id === id);
        if (item && item.kind === "agent") item.text += chunk;
      }),

    endAgentMsg: (id) =>
      set((s) => {
        const item = s.stream.find((x) => x.kind === "agent" && x.id === id);
        if (item && item.kind === "agent") item.streaming = false;
        if (s.streamingAgentId === id) s.streamingAgentId = null;
      }),

    startTool: (id, node, tool, args) =>
      set((s) => {
        s.stream.push({
          kind: "tool",
          id,
          node,
          tool,
          args,
          state: "running",
          startedAt: Date.now(),
        });
        s.activeNode = node;
        s.nodeToolCount[node] = (s.nodeToolCount[node] ?? 0) + 1;
      }),

    endTool: (id, ok, result, errorMessage) =>
      set((s) => {
        const item = s.stream.find((x) => x.kind === "tool" && x.id === id);
        if (item && item.kind === "tool") {
          item.state = ok ? "success" : "error";
          item.endedAt = Date.now();
          item.result = result;
          item.errorMessage = errorMessage;
          s.nodeToolCount[item.node] = Math.max(
            0,
            (s.nodeToolCount[item.node] ?? 1) - 1
          );
          if (s.nodeToolCount[item.node] === 0) {
            s.activeNode = null;
          }
        }
      }),

    pushInterrupt: (plan, questions, opts) =>
      set((s) => {
        // 재접속/복원으로 같은 interrupt 가 다시 오면 기존 미해결 카드를 갱신.
        const existing = lastUnresolvedInterrupt(s.stream);
        if (existing) {
          existing.interruptKind = "script_approval";
          existing.plan = plan;
          existing.questions = questions;
          existing.planMarkdown = opts?.planMarkdown;
          existing.conceptName = opts?.conceptName;
          existing.creativeBrief = opts?.creativeBrief;
          existing.question = undefined;
          existing.candidates = undefined;
          existing.options = undefined;
          existing.context = undefined;
          s.pendingInterrupt = existing;
          s.sessionStatus = "awaiting-interrupt";
          return;
        }
        const item = {
          kind: "interrupt" as const,
          id: nextId(),
          createdAt: Date.now(),
          interruptKind: "script_approval" as const,
          plan,
          questions,
          planMarkdown: opts?.planMarkdown,
          conceptName: opts?.conceptName,
          creativeBrief: opts?.creativeBrief,
        };
        s.stream.push(item);
        s.pendingInterrupt = item;
        s.sessionStatus = "awaiting-interrupt";
      }),

    pushClarify: (question, candidates, options, context) =>
      set((s) => {
        const existing = lastUnresolvedInterrupt(s.stream);
        if (existing) {
          existing.interruptKind = "clarify";
          existing.plan = [];
          existing.questions = [];
          existing.question = question;
          existing.candidates = candidates;
          existing.options = options;
          existing.context = context;
          s.pendingInterrupt = existing;
          s.sessionStatus = "awaiting-interrupt";
          return;
        }
        const item = {
          kind: "interrupt" as const,
          id: nextId(),
          createdAt: Date.now(),
          interruptKind: "clarify" as const,
          plan: [] as PlanStep[],
          questions: [] as string[],
          question,
          candidates,
          options,
          context,
        };
        s.stream.push(item);
        s.pendingInterrupt = item;
        s.sessionStatus = "awaiting-interrupt";
      }),

    resolveInterrupt: (approved, feedback) =>
      set((s) => {
        if (s.pendingInterrupt) {
          const found = s.stream.find(
            (x) => x.kind === "interrupt" && x.id === s.pendingInterrupt!.id
          );
          if (found && found.kind === "interrupt") {
            found.resolved = approved ? "approved" : "revised";
          }
          if (!approved && feedback) {
            s.stream.push({
              kind: "user",
              id: nextId(),
              text: feedback,
              createdAt: Date.now(),
            });
          }
        }
        s.pendingInterrupt = null;
        s.sessionStatus = "streaming";
      }),

    markInterruptResolved: (resolution) =>
      set((s) => {
        if (s.pendingInterrupt) {
          const found = s.stream.find(
            (x) => x.kind === "interrupt" && x.id === s.pendingInterrupt!.id
          );
          if (found && found.kind === "interrupt") {
            found.resolved = resolution;
          }
        }
        s.pendingInterrupt = null;
        s.sessionStatus = "streaming";
      }),

    endTurn: () =>
      set((s) => {
        // 남아있는 running phase 카드 마감 (final 없는 턴 대비).
        for (const it of s.stream) {
          if (it.kind === "phase" && it.state === "running") {
            it.state = "done";
            it.endedAt = Date.now();
          }
        }
        if (s.pendingInterrupt) {
          // 오류로 깨진 턴은 서버 체크포인트에 interrupt 가 그대로 남아있을 수
          // 있다 (error 후에도 done 은 온다). 카드를 살려두고 응답 대기로 유지.
          if (s.sessionStatus === "error") {
            s.sessionStatus = "awaiting-interrupt";
            return;
          }
          // 정상 종료 = 서버가 interrupt 를 이미 소비함. 미해결로 남은 카드 마감.
          settleStaleInterrupt(s);
        }
        if (s.sessionStatus !== "error") {
          s.sessionStatus = "completed";
        }
      }),

    pushFinal: (outputPath, duration, opts) =>
      set((s) => {
        const item = {
          kind: "final" as const,
          id: nextId(),
          createdAt: Date.now(),
          outputPath,
          outputUrl: opts?.outputUrl,
          duration,
          criticNote: opts?.criticNote,
          success: opts?.success,
          transcript: opts?.transcript,
          scenes: opts?.scenes,
        };
        s.stream.push(item);
        s.lastFinal = item;
        s.sessionStatus = opts?.success === false ? "error" : "completed";
        // 세션 완료 시 파이프라인 배지 초기화 + 남아있는 running phase 마감.
        s.activeNode = null;
        s.nodeToolCount = { ...initialNodeCount };
        for (const it of s.stream) {
          if (it.kind === "phase" && it.state === "running") {
            it.state = "done";
            it.endedAt = Date.now();
          }
        }
        // 편집이 성공했고 자막(cue)이 있으면 최종본 stem 으로 자막 스타일 카드를
        // 지금(편집 후) 띄운다. 편집 전에 미리 띄우던 예전 동작을 대체한다.
        const finalStem =
          outputPath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
        const hasCues = (opts?.transcript?.length ?? 0) > 0;
        const alreadyCard = s.stream.some(
          (x) => x.kind === "subtitle_style" && x.stem === finalStem
        );
        if (opts?.success !== false && hasCues && finalStem && !alreadyCard) {
          s.stream.push({
            kind: "subtitle_style",
            id: nextId(),
            createdAt: Date.now(),
            stem: finalStem,
            status: "pending",
          });
        }
      }),

    pushSubtitleStyle: (stem) =>
      set((s) => {
        s.stream.push({
          kind: "subtitle_style",
          id: nextId(),
          createdAt: Date.now(),
          stem,
          status: "pending",
        });
      }),

    applySubtitleStyle: (id, outputPath) =>
      set((s) => {
        const item = s.stream.find(
          (x) => x.kind === "subtitle_style" && x.id === id
        );
        if (item && item.kind === "subtitle_style") {
          item.status = "applied";
          item.outputPath = outputPath;
        }
        s.subtitleStyleVersion += 1;
      }),

    pushInfo: (text) =>
      set((s) => {
        s.stream.push({
          kind: "info",
          id: nextId(),
          text,
          createdAt: Date.now(),
        });
      }),

    pushError: (title, detail, toolId) =>
      set((s) => {
        s.stream.push({
          kind: "error",
          id: nextId(),
          title,
          detail,
          toolId,
          createdAt: Date.now(),
        });
        s.sessionStatus = "error";
      }),

    startPhase: (phase, label, detail) =>
      set((s) => {
        // 같은 phase 카드가 이미 running 이면 label/detail 만 갱신 (하트비트).
        const existing = s.stream.find(
          (x) => x.kind === "phase" && x.phase === phase && x.state === "running"
        );
        if (existing && existing.kind === "phase") {
          existing.label = label;
          existing.detail = detail;
          return;
        }
        s.stream.push({
          kind: "phase",
          id: nextId(),
          phase,
          label,
          detail,
          state: "running",
          startedAt: Date.now(),
        });
        s.sessionStatus = "streaming";
      }),

    endPhase: (phase, label, detail) =>
      set((s) => {
        // 뒤에서부터 찾아 가장 최근 running 인스턴스만 종료.
        for (let i = s.stream.length - 1; i >= 0; i--) {
          const it = s.stream[i];
          if (it.kind === "phase" && it.phase === phase && it.state === "running") {
            it.state = "done";
            it.endedAt = Date.now();
            if (label !== undefined) it.label = label;
            if (detail !== undefined) it.detail = detail;
            break;
          }
        }
      }),

    setUpload: (pct, name, url, serverPath) =>
      set((s) => {
        s.uploadPct = pct;
        if (name !== undefined) s.uploadedName = name;
        if (url !== undefined && url !== s.uploadedUrl) {
          // 이전 blob 이 있고 실제로 새 URL 로 바뀔 때만 revoke.
          // 같은 URL 재세팅 시 revoke 하면 <video src> 참조가 끊겨 404 남.
          if (s.uploadedUrl && s.uploadedUrl.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(s.uploadedUrl);
            } catch {
              // ignore
            }
          }
          s.uploadedUrl = url;
        }
        if (serverPath !== undefined) s.serverVideoPath = serverPath;
      }),

    addVideo: (serverPath, name, url) =>
      set((s) => {
        if (s.serverVideoPaths.includes(serverPath)) return; // 중복 방지
        s.serverVideoPaths.push(serverPath);
        s.uploadedNames.push(name);
        s.uploadPct = 100;
        // 첫 영상 = 대표. 프리뷰/모션에디터가 참조하는 단수 필드를 채운다.
        if (s.serverVideoPaths.length === 1) {
          s.serverVideoPath = serverPath;
          s.uploadedName = name;
          if (url && url !== s.uploadedUrl) s.uploadedUrl = url;
        }
      }),

    removeVideo: (serverPath) =>
      set((s) => {
        const idx = s.serverVideoPaths.indexOf(serverPath);
        if (idx === -1) return;
        s.serverVideoPaths.splice(idx, 1);
        s.uploadedNames.splice(idx, 1);
        // 대표(단수) 필드는 항상 [0] 을 미러 — 첫 영상을 뺐으면 다음 것이 대표.
        const head = s.serverVideoPaths[0] ?? null;
        s.serverVideoPath = head;
        s.uploadedName = head ? s.uploadedNames[0] ?? null : null;
        if (!head) {
          if (s.uploadedUrl?.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(s.uploadedUrl);
            } catch {
              // ignore
            }
          }
          s.uploadedUrl = null;
          s.uploadPct = null;
        } else {
          const item = s.media.find((m) => m.path === head);
          if (item) s.uploadedUrl = item.url;
        }
      }),

    setMedia: (items) =>
      set((s) => {
        s.media = items;
        s.mediaLoading = false;
      }),

    setMediaLoading: (loading) =>
      set((s) => {
        s.mediaLoading = loading;
      }),

    upsertMedia: (item) =>
      set((s) => {
        const idx = s.media.findIndex((m) => m.name === item.name);
        if (idx === -1) s.media.unshift(item);
        else s.media[idx] = item;
      }),

    dropMedia: (name) =>
      set((s) => {
        const item = s.media.find((m) => m.name === name);
        s.media = s.media.filter((m) => m.name !== name);
        if (!item) return;
        const idx = s.serverVideoPaths.indexOf(item.path);
        if (idx === -1) return;
        s.serverVideoPaths.splice(idx, 1);
        s.uploadedNames.splice(idx, 1);
        const head = s.serverVideoPaths[0] ?? null;
        s.serverVideoPath = head;
        s.uploadedName = head ? s.uploadedNames[0] ?? null : null;
        if (!head) {
          s.uploadedUrl = null;
          s.uploadPct = null;
        }
      }),

    setUploadError: (message) =>
      set((s) => {
        s.uploadError = message;
      }),

    clearVideos: () =>
      set((s) => {
        if (s.uploadedUrl && s.uploadedUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(s.uploadedUrl);
          } catch {
            // ignore
          }
        }
        s.serverVideoPaths = [];
        s.uploadedNames = [];
        s.serverVideoPath = null;
        s.uploadedName = null;
        s.uploadedUrl = null;
        s.uploadPct = null;
        s.uploadError = null;
        // media 는 서버 라이브러리 미러라 세션 초기화와 무관하게 유지한다.
      }),

    setVideoContext: (ctx) =>
      set((s) => {
        s.videoContext = ctx;
      }),

    setPlayhead: (t) =>
      set((s) => {
        s.playhead = Math.max(0, t);
      }),

    setPlaying: (p) =>
      set((s) => {
        s.playing = p;
      }),

    setTimelineZoom: (z) =>
      set((s) => {
        s.timelineZoom = Math.max(1, Math.min(8, z));
      }),

    selectSegment: (kind, index) =>
      set((s) => {
        if (kind === null || index == null) {
          s.selected = null;
        } else {
          s.selected = { kind, index };
        }
      }),

    setStageViewMode: (m) =>
      set((s) => {
        s.stageViewMode = m;
        // 소스 전환 시 playhead 초기화 · 선택 클리어 · 실 duration 리셋
        // (새 소스가 로드되면 다시 갱신됨).
        s.playhead = 0;
        s.playing = false;
        s.selected = null;
        s.stageVideoDuration = 0;
      }),

    setStageVideoDuration: (sec) =>
      set((s) => {
        s.stageVideoDuration = Number.isFinite(sec) && sec > 0 ? sec : 0;
      }),

    requestSeek: (t) =>
      set((s) => {
        if (!Number.isFinite(t)) return;
        s.seekRequest = {
          t: Math.max(0, t),
          nonce: (s.seekRequest?.nonce ?? 0) + 1,
        };
      }),

    clearStream: () =>
      set((s) => {
        s.stream = [];
        s.streamingAgentId = null;
        s.pendingInterrupt = null;
        s.lastFinal = null;
        s.activeNode = null;
        s.nodeToolCount = { ...initialNodeCount };
        s.videoContext = null;
        // 업로드된 파일은 유지 (mock 시나리오에서 재생용).
        // uploadedUrl 은 유저가 명시적으로 clear 할 때만 revoke.
        s.sessionStatus = "idle";
      }),

    setSessionId: (id) =>
      set((s) => {
        s.sessionId = id;
      }),

    hydrateStream: (items) =>
      set((s) => {
        s.stream = items;
        s.streamingAgentId = null;
        s.pendingInterrupt = null;
        s.activeNode = null;
        s.nodeToolCount = { ...initialNodeCount };
        // 마지막 final 카드를 lastFinal 로 (Stage 가 편집본으로 스위치 가능).
        let lastFinal: (StreamItem & { kind: "final" }) | null = null;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "final") {
            lastFinal = it;
            break;
          }
        }
        s.lastFinal = lastFinal;
        s.sessionStatus = "idle";
      }),
  }))
);

// dev helper — browser console: __store.getState().pushSubtitleStyle("test")
// production 번들에는 노출하지 않는다.
if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  // @ts-expect-error dev
  window.__store = useAgentStore;
}
