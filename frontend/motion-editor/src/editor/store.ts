// store.ts
// 에디터 단일 스토어 (zustand). 모든 spec 변경은 updateDoc() 하나로만 —
// immer produceWithPatches 로 패치 기반 undo/redo 를 얻는다.
//
// 계약 (패널 에이전트 공통):
//   - spec 읽기: useEditor((s) => s.doc)
//   - spec 변경: useEditor.getState().updateDoc("라벨", (draft) => { ... }, { coalesceKey? })
//     드래그처럼 연속 변경은 같은 coalesceKey 를 넘기면 히스토리 1건으로 합쳐진다.
//     드래그 종료 시 endCoalescing() 호출.
//   - 선택: select(paths, { additive }) / setHovered(path)
//   - 재생 프레임은 스토어에 없다 — playerBridge.usePlayerFrame() 사용 (재렌더 격리).
//
// 구조 변경(요소 추가/삭제/이동) 시 selection 경로가 무효화될 수 있으므로
// updateDoc 의 recipe 안에서 draft 를 바꾼 뒤, 필요하면 opts.selectAfter 로
// 새 selection 을 함께 지정한다.

"use client";

import { create } from "zustand";
import {
  produce,
  produceWithPatches,
  applyPatches,
  enablePatches,
  type Patch,
} from "immer";
import type { VideoSpec } from "@engine/motion/SceneRenderer";
import type { ElementPath } from "./specPath";
import { normalizeSelection } from "./specPath";
import { normalizeSpec, detectShape, containsPreset, type SpecShape } from "@/engine/normalize";
import { migrateDetachPresets } from "./detachPresets";

enablePatches();

export type HistoryEntry = {
  label: string;
  patches: Patch[];
  inversePatches: Patch[];
  selectionBefore: ElementPath[];
  selectionAfter: ElementPath[];
  coalesceKey?: string;
};

export type EditorTool = "select" | "hand" | "text" | "shape" | "frame" | "scale";

// 카메라 키프레임 선택 (타임라인 카메라 트랙 <-> 인스펙터 동기화)
export type SelectedKeyframe = { sceneIdx: number; kfIndex: number } | null;

// 요소 속성 키프레임 선택 (타임라인 채널 lane <-> 인스펙터)
export type KfChannel = "x" | "y" | "scale" | "rotate" | "opacity" | "blur" | "rotateX" | "rotateY" | "progress" | "w" | "h" | "z" | "color";
export type SelectedElKeyframe = { path: ElementPath; channel: KfChannel; kfIndex: number } | null;

export type DocMeta = {
  /** specs 루트 기준 상대 경로 (예: "text-motion/words-test.json"). 새 문서면 null */
  relPath: string | null;
  /** 원본 파일의 형태. video 외 형태는 저장 시 VideoSpec 으로 승격됨(경고 표시) */
  loadedShape: SpecShape | null;
  /** 원본에 preset 씬이 있어 확장-편집 중인가 (저장 시 프리셋 구조는 사라짐) */
  hadPresets: boolean;
  dirty: boolean;
};

export type EasingEditorTarget = {
  /** 어떤 요소/레이어의 easing 을 편집 중인가 (없으면 탐색 모드) */
  path?: ElementPath;
  layerIdx?: number;
  /** layer props 안에서 easing 값이 사는 key 경로 (예: "props.easing", "props.perLetter.easing") */
  propPath?: string;
  /** 카메라 키프레임 세그먼트 이징 편집 (path/propPath 대신) */
  cameraKf?: { sceneIdx: number; kfIndex: number };
  /** 요소 속성 키프레임 세그먼트 이징 편집 */
  elementKf?: { path: ElementPath; channel: KfChannel; kfIndex: number };
  /** 현재 값 */
  value?: string;
};

export type UIState = {
  tool: EditorTool;
  leftTab: "library" | "layers" | "ai";
  /** 타임라인 줌: 프레임당 px */
  pxPerFrame: number;
  /** 0.6s(100BPM) 비트 그리드 오버레이 */
  showBeatGrid: boolean;
  /** 캔버스 줌: "fit" 또는 배율 */
  canvasZoom: "fit" | number;
  easingEditor: EasingEditorTarget | null;
  /** 스펙 라이브러리 새로고침 트리거 (저장/생성 후 증가) */
  libraryRefresh: number;
  /** JSON 소스 패널 열림 */
  jsonOpen: boolean;
  /** 카메라 키프레임 자동 기록(플레이헤드 이동 중 카메라 변경 시 키프레임 생성) */
  cameraAutoKey: boolean;
  /** 캔버스에서 카메라 직접 조작 모드(드래그=팬, 휠=줌 → 플레이헤드에 자동 키) */
  cameraManip: boolean;
  /** 선택된 카메라 키프레임 */
  selectedKeyframe: SelectedKeyframe;
  /** 요소 키프레임 record 모드(캔버스 조작 → 플레이헤드에 자동 키). 빨간 상태로 경고. */
  recordKeyframes: boolean;
  /** 선택된 요소 속성 키프레임 (타임라인 채널 lane <-> 인스펙터) */
  selectedElKeyframe: SelectedElKeyframe;
  /** 다중 키프레임 선택 (shift 클릭) — 통째 드래그 이동용. */
  kfMultiSel: { path: string; kfIndex: number }[];
  /** 씬 스트립 다중 선택 (shift 클릭) — 병합용. */
  sceneMultiSel: number[];
  /** 선택된 오디오 클립 id 들 (타임라인 오디오 레인 <-> 인스펙터). 요소 선택과
   *  배타. shift 클릭 다중 선택 -> 함께 드래그/삭제. */
  selectedAudio: string[];
  /** 타임라인에서 채널 lane 을 펼친 요소들 (path -> true) */
  expandedKfRows: Record<string, boolean>;
  /** 레퍼런스 영상 오버레이/비교 — doc.reference 로 파일에 저장/복원 (setRefOverlay 가 미러) */
  refOverlay: RefOverlayState;
  /** 레퍼런스 영상 피커 모달 열림 */
  refPickerOpen: boolean;
  /** 패널 크기/접힘 (좌 사이드바 / 우 인스펙터 / 하단 타임라인) */
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
};

export type RefOverlayState = {
  /** 선택된 영상 rel 경로(예: "ui-demo/teamble.mp4"). null = 없음 */
  video: string | null;
  /** 보이기/숨기기 (피그마 레이어 눈 아이콘식 — 숨겨도 영상·정렬 유지) */
  visible: boolean;
  mode: "overlay" | "side";
  /** 오버레이 불투명도 0..1 */
  opacity: number;
  /** 이 전역 프레임에서 레퍼런스 t=0 이 시작 */
  startFrame: number;
  /** 레퍼런스가 끝나는 전역 프레임(정렬용, null = 자연 길이) */
  endFrame: number | null;
  /** 좌우 분할 시 레퍼런스가 놓이는 쪽 */
  side: "left" | "right";
};

export type EditorState = {
  doc: VideoSpec | null;
  meta: DocMeta;
  selection: ElementPath[];
  hovered: ElementPath | null;
  /** 타임라인/인스펙터가 보는 활성 씬 */
  activeScene: number;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /** 진행 중 제스처(포인터 드래그 등)의 병합 키 — 있으면 그 동안의 모든
   *  updateDoc 이 히스토리 1건으로 합쳐진다 (coalesceKey 보다 우선).
   *  컬러 피커 문지르기, 캔버스 드래그처럼 "한 번의 조작 = 한 번의 undo"
   *  를 보장한다. 서로 다른 coalesceKey 가 번갈아 기록돼 병합이 깨지는
   *  문제(armed x/y 키 동시 드래그)도 이걸로 해결. */
  gestureKey: string | null;
  ui: UIState;

  loadDoc: (relPath: string | null, raw: unknown) => void;
  newDoc: () => void;
  updateDoc: (
    label: string,
    recipe: (draft: VideoSpec) => void,
    opts?: { coalesceKey?: string; selectAfter?: ElementPath[] },
  ) => void;
  endCoalescing: () => void;
  /** 제스처 경계 — 드래그 시작/끝에서 호출. begin~end 사이 모든 doc 변경이
   *  undo 1건. end 는 마지막 항목의 병합 키를 닫는다. */
  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  select: (paths: ElementPath[], opts?: { additive?: boolean }) => void;
  toggleSelect: (path: ElementPath) => void;
  clearSelection: () => void;
  setHovered: (path: ElementPath | null) => void;
  setActiveScene: (idx: number) => void;
  setUI: (partial: Partial<UIState>) => void;
  /** 레퍼런스 오버레이 갱신 — ui 상태와 doc.reference 를 함께 쓴다 (파일 저장,
   *  undo 히스토리엔 안 남김 — 보기 보조지 콘텐츠 편집이 아님). */
  setRefOverlay: (p: Partial<RefOverlayState>) => void;
  markSaved: () => void;
  /** JSON 텍스트를 파싱·정규화해 doc 전체 교체(undo 가능). 실패 시 error 반환. */
  applyJsonEdit: (rawText: string) => { ok: boolean; error?: string };
};

const MAX_HISTORY = 200;
let gestureSeq = 0;

const EMPTY_DOC: VideoSpec = {
  fps: 24,
  brandDefaults: {
    background: "#0D0B10",
    fontFamily: "General Sans, Inter, Helvetica, Arial, sans-serif",
    colors: ["#7C4DFF", "#FF4D9D", "#4D7DFF"],
  },
  scenes: [
    {
      id: "scene-1",
      duration: 2.5,
      elements: [],
    },
  ],
};

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  meta: { relPath: null, loadedShape: null, hadPresets: false, dirty: false },
  selection: [],
  hovered: null,
  activeScene: 0,
  undoStack: [],
  redoStack: [],
  gestureKey: null,
  ui: {
    tool: "select",
    leftTab: "library",
    pxPerFrame: 8,
    showBeatGrid: false,
    canvasZoom: "fit",
    easingEditor: null,
    libraryRefresh: 0,
    jsonOpen: false,
    cameraAutoKey: false,
    cameraManip: false,
    selectedKeyframe: null,
    recordKeyframes: false,
    selectedElKeyframe: null,
    kfMultiSel: [],
    sceneMultiSel: [],
    selectedAudio: [],
    expandedKfRows: {},
    refOverlay: { video: null, visible: true, mode: "overlay", opacity: 0.5, startFrame: 0, endFrame: null, side: "right" },
    refPickerOpen: false,
    leftWidth: 260,
    rightWidth: 288,
    bottomHeight: 264,
    leftCollapsed: false,
    rightCollapsed: false,
    bottomCollapsed: false,
  },

  loadDoc: (relPath, raw) => {
    // 프리셋 monolith 는 열자마자 일반 요소 조립로 자동 분해 — 에디터에서는
    // 항상 "모든 부분이 선택·편집·키프레임 가능한" 상태만 존재한다.
    const doc = migrateDetachPresets(normalizeSpec(raw));
    // 과거 저장분의 중복 요소 id 정리 — 복제 버그(수정됨)로 저장된 스펙이
    // React key 충돌 경고를 무한 반복시킨다. 로드 시 한 번 유일화.
    {
      // 키프레임 채널 목록 — 다채널 엔트리를 채널별 단일 엔트리로 쪼갠다.
      const KF_CHANS = ["x", "y", "scale", "rotate", "opacity", "blur", "rotateX", "rotateY", "progress", "w", "h", "z", "color"] as const;
      // 한 키프레임 객체가 여러 채널을 담으면(손수 작성/붙여넣기 스펙) 타임라인
      // 에서 채널 다이아몬드가 같은 배열 엔트리를 공유해 함께 움직인다. 에디터
      // 관례(채널당 단일 엔트리)에 맞춰 로드 시 분리 — 렌더는 불변(엔진은 채널
      // 독립 보간), 편집만 채널별 독립이 된다.
      const splitKfs = (kfs: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
        const out: Array<Record<string, unknown>> = [];
        for (const k of kfs) {
          const chans = KF_CHANS.filter((c) => (c === "color" ? typeof k[c] === "string" : typeof k[c] === "number"));
          if (chans.length <= 1) {
            out.push(k);
            continue;
          }
          for (const c of chans) {
            const entry: Record<string, unknown> = { frame: k.frame, [c]: k[c] };
            if (k.easing !== undefined) entry.easing = k.easing;
            if (k.loop !== undefined) entry.loop = k.loop;
            out.push(entry);
          }
        }
        return out;
      };
      const seen = new Set<string>();
      const walk = (els: Array<{ id?: string; children?: unknown[]; keyframes?: unknown[] }>) => {
        for (const e of els) {
          if (e.id) {
            if (seen.has(e.id)) {
              let n = 2;
              let cand = `${e.id}-${n}`;
              while (seen.has(cand)) cand = `${e.id}-${++n}`;
              e.id = cand;
            }
            seen.add(e.id);
          }
          if (Array.isArray(e.keyframes) && e.keyframes.length > 0) {
            e.keyframes = splitKfs(e.keyframes as Array<Record<string, unknown>>);
          }
          if (Array.isArray(e.children)) walk(e.children as Array<{ id?: string; children?: unknown[]; keyframes?: unknown[] }>);
        }
      };
      for (const sc of doc.scenes ?? []) walk((sc.elements ?? []) as Array<{ id?: string; children?: unknown[]; keyframes?: unknown[] }>);
    }
    // 파일에 저장된 레퍼런스 오버레이 복원 (없으면 초기화)
    const ref = (doc as { reference?: { video?: string; mode?: "overlay" | "side"; opacity?: number; startFrame?: number; endFrame?: number | null; side?: "left" | "right"; visible?: boolean } }).reference;
    const refOverlay: RefOverlayState = ref?.video
      ? {
          video: ref.video,
          visible: ref.visible !== false,
          mode: ref.mode ?? "overlay",
          opacity: ref.opacity ?? 0.5,
          startFrame: ref.startFrame ?? 0,
          endFrame: ref.endFrame ?? null,
          side: ref.side ?? "right",
        }
      : { video: null, visible: true, mode: "overlay", opacity: 0.5, startFrame: 0, endFrame: null, side: "right" };
    set({
      doc,
      meta: {
        relPath,
        loadedShape: detectShape(raw),
        hadPresets: containsPreset(raw),
        dirty: false,
      },
      ui: { ...get().ui, refOverlay },
      selection: [],
      hovered: null,
      activeScene: 0,
      undoStack: [],
      redoStack: [],
    });
  },

  newDoc: () => {
    set({
      // structuredClone: EMPTY_DOC 원본 오염 방지
      doc: structuredClone(EMPTY_DOC),
      meta: { relPath: null, loadedShape: "video", hadPresets: false, dirty: true },
      selection: [],
      hovered: null,
      activeScene: 0,
      undoStack: [],
      redoStack: [],
    });
  },

  updateDoc: (label, recipe, opts) => {
    const { doc, selection, undoStack } = get();
    if (!doc) return;
    const [next, patches, inversePatches] = produceWithPatches(doc, (d) => {
      recipe(d as VideoSpec);
    });
    if (patches.length === 0) return;

    const selectionAfter = opts?.selectAfter ?? selection;
    const last = undoStack[undoStack.length - 1];
    // 제스처 진행 중이면 개별 coalesceKey 대신 제스처 키로 전부 병합
    const key = get().gestureKey ?? opts?.coalesceKey;
    const canCoalesce = key && last && last.coalesceKey === key;

    let nextUndo: HistoryEntry[];
    if (canCoalesce) {
      // 같은 드래그 안의 연속 변경: patches 는 이어붙이고 inverse 는 처음 것 유지
      nextUndo = [
        ...undoStack.slice(0, -1),
        {
          ...last,
          label,
          patches: [...last.patches, ...patches],
          inversePatches: [...inversePatches, ...last.inversePatches],
          selectionAfter,
        },
      ];
    } else {
      nextUndo = [
        ...undoStack.slice(-MAX_HISTORY + 1),
        {
          label,
          patches,
          inversePatches,
          selectionBefore: selection,
          selectionAfter,
          coalesceKey: key,
        },
      ];
    }

    set({
      doc: next,
      undoStack: nextUndo,
      redoStack: [],
      selection: selectionAfter,
      meta: { ...get().meta, dirty: true },
    });
  },

  endCoalescing: () => {
    // 제스처 중엔 개별 쓰기의 최종 커밋이 경계를 만들면 안 된다 — 제스처
    // 종료(endGesture)가 유일한 경계.
    if (get().gestureKey) return;
    const { undoStack } = get();
    const last = undoStack[undoStack.length - 1];
    if (!last?.coalesceKey) return;
    set({
      undoStack: [...undoStack.slice(0, -1), { ...last, coalesceKey: undefined }],
    });
  },

  beginGesture: () => {
    set({ gestureKey: `gesture-${++gestureSeq}` });
  },

  endGesture: () => {
    if (!get().gestureKey) return;
    set({ gestureKey: null });
    get().endCoalescing();
  },

  undo: () => {
    const { doc, undoStack, redoStack } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!doc || !entry) return;
    const prev = applyPatches(doc, entry.inversePatches) as VideoSpec;
    set({
      doc: prev,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, entry],
      selection: entry.selectionBefore,
      meta: { ...get().meta, dirty: true },
    });
  },

  redo: () => {
    const { doc, undoStack, redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!doc || !entry) return;
    const next = applyPatches(doc, entry.patches) as VideoSpec;
    set({
      doc: next,
      undoStack: [...undoStack, entry],
      redoStack: redoStack.slice(0, -1),
      selection: entry.selectionAfter,
      meta: { ...get().meta, dirty: true },
    });
  },

  select: (paths, opts) => {
    const { selection } = get();
    const next = opts?.additive
      ? normalizeSelection([...selection, ...paths])
      : normalizeSelection(paths);
    set({ selection: next });
    // 요소 선택은 오디오 클립 선택과 배타 — 인스펙터가 한쪽만 보이게
    if (next.length > 0 && get().ui.selectedAudio.length > 0) {
      set({ ui: { ...get().ui, selectedAudio: [] } });
    }
    // 선택한 요소의 씬을 활성화
    if (next.length > 0) {
      const sceneIdx = Number(next[next.length - 1].split(":")[0]);
      if (Number.isInteger(sceneIdx)) set({ activeScene: sceneIdx });
    }
  },

  toggleSelect: (path) => {
    const { selection } = get();
    set({
      selection: selection.includes(path)
        ? selection.filter((p) => p !== path)
        : normalizeSelection([...selection, path]),
    });
  },

  // 오디오 클립 선택도 함께 해제 — clearSelection 은 "Scene 인스펙터로 돌아가기"
  // 의도로 불리는 곳(씬 스트립/카메라 lane 등)이 많다. 클립 선택은 해제 후 setUI.
  clearSelection: () =>
    set((st) => ({ selection: [], ui: st.ui.selectedAudio.length ? { ...st.ui, selectedAudio: [] } : st.ui })),
  setHovered: (path) => set({ hovered: path }),
  // selection 은 씬 독립(연속 타임라인). activeScene 전환만으로 선택을 지우지 않는다.
  // 씬 스트립에서 씬을 넘길 때의 선택 해제는 그쪽(selectScene)에서 명시적으로 한다.
  setActiveScene: (idx) => set({ activeScene: idx }),
  setUI: (partial) => set({ ui: { ...get().ui, ...partial } }),
  setRefOverlay: (p) =>
    set((st) => {
      const next = { ...st.ui.refOverlay, ...p };
      if (!st.doc) return { ui: { ...st.ui, refOverlay: next } };
      const doc = { ...st.doc } as typeof st.doc & { reference?: unknown };
      if (next.video) {
        doc.reference = {
          video: next.video,
          mode: next.mode,
          opacity: next.opacity,
          startFrame: next.startFrame,
          endFrame: next.endFrame,
          side: next.side,
          visible: next.visible,
        };
      } else {
        delete doc.reference;
      }
      return { ui: { ...st.ui, refOverlay: next }, doc, meta: { ...st.meta, dirty: true } };
    }),
  markSaved: () =>
    set({
      meta: { ...get().meta, dirty: false },
      ui: { ...get().ui, libraryRefresh: get().ui.libraryRefresh + 1 },
    }),

  applyJsonEdit: (rawText) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    let normalized: VideoSpec;
    try {
      normalized = normalizeSpec(parsed);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    // updateDoc 으로 통째 교체(undo 가능). 선택은 무효화되므로 비운다.
    get().updateDoc(
      "Edit JSON",
      (draft) => {
        draft.fps = normalized.fps;
        draft.brandDefaults = normalized.brandDefaults;
        draft.scenes = normalized.scenes;
      },
      { selectAfter: [] },
    );
    return { ok: true };
  },
}));

// dev 편의: 브라우저 콘솔에서 스토어 접근 (window.__editor.getState()). 디버깅용.
if (typeof window !== "undefined") {
  (window as unknown as { __editor?: typeof useEditor }).__editor = useEditor;
}

// 편의: recipe 없이 얕은 필드 하나 바꿀 때 (produce 재노출)
export { produce };
