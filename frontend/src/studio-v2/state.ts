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
      duration: number;
      criticNote?: string;
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
  // insights (video_context)
  videoContext: {
    file_path: string;
    duration: number;
    sceneCount: number;
    transcriptCount: number;
  } | null;

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
  pushFinal: (outputPath: string, duration: number, criticNote?: string) => void;
  pushInfo: (text: string) => void;
  pushError: (title: string, detail?: string, toolId?: string) => void;
  setUpload: (
    pct: number | null,
    name?: string | null,
    url?: string | null
  ) => void;
  setVideoContext: (ctx: AgentState["videoContext"]) => void;
  clearStream: () => void;
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
    videoContext: null,

    setConnection: (c) =>
      set((s) => {
        s.connection = c;
      }),

    startSession: (id) =>
      set((s) => {
        s.sessionId = id;
        s.sessionStatus = "streaming";
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

    pushFinal: (outputPath, duration, criticNote) =>
      set((s) => {
        const item = {
          kind: "final" as const,
          id: nextId(),
          createdAt: Date.now(),
          outputPath,
          duration,
          criticNote,
        };
        s.stream.push(item);
        s.lastFinal = item;
        s.sessionStatus = "completed";
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

    setUpload: (pct, name, url) =>
      set((s) => {
        s.uploadPct = pct;
        if (name !== undefined) s.uploadedName = name;
        if (url !== undefined) {
          // 기존 blob url 이 있으면 revoke (메모리 leak 방지)
          if (s.uploadedUrl && s.uploadedUrl.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(s.uploadedUrl);
            } catch {
              // ignore
            }
          }
          s.uploadedUrl = url;
        }
      }),

    setVideoContext: (ctx) =>
      set((s) => {
        s.videoContext = ctx;
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
