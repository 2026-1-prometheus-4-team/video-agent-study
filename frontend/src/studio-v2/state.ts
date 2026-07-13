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

export type TranscriptSeg = { start: number; end: number; text: string };
export type SceneSeg = { start: number; end: number; description: string };

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
      resolved?: "approved" | "revised";
    }
  | {
      kind: "final";
      id: string;
      createdAt: number;
      outputPath: string;
      outputUrl?: string;
      duration: number;
      criticNote?: string;
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
  uploadedName: string | null;
  uploadedUrl: string | null;
  serverVideoPath: string | null;
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
  pushInterrupt: (plan: PlanStep[], questions: string[]) => void;
  resolveInterrupt: (approved: boolean, feedback?: string) => void;
  pushFinal: (
    outputPath: string,
    duration: number,
    opts?: {
      criticNote?: string;
      outputUrl?: string;
      transcript?: TranscriptSeg[];
      scenes?: SceneSeg[];
    }
  ) => void;
  pushInfo: (text: string) => void;
  pushError: (title: string, detail?: string, toolId?: string) => void;
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
  setVideoContext: (ctx: AgentState["videoContext"]) => void;
  clearStream: () => void;

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
}

// ---------- Store ----------

let idCounter = 0;
const nextId = () => `it-${Date.now().toString(36)}-${(++idCounter).toString(36)}`;

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
    videoContext: null,
    playhead: 0,
    playing: false,
    timelineZoom: 1,
    selected: null,
    stageViewMode: "source",
    stageVideoDuration: 0,

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

    pushInterrupt: (plan, questions) =>
      set((s) => {
        const item = {
          kind: "interrupt" as const,
          id: nextId(),
          createdAt: Date.now(),
          plan,
          questions,
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
          transcript: opts?.transcript,
          scenes: opts?.scenes,
        };
        s.stream.push(item);
        s.lastFinal = item;
        s.sessionStatus = "completed";
        // 세션 완료 시 파이프라인 배지 초기화 + 남아있는 running phase 마감.
        s.activeNode = null;
        s.nodeToolCount = { ...initialNodeCount };
        for (const it of s.stream) {
          if (it.kind === "phase" && it.state === "running") {
            it.state = "done";
            it.endedAt = Date.now();
          }
        }
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
  }))
);
