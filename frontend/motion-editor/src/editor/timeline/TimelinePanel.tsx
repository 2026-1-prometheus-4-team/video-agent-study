"use client";

// TimelinePanel — 하단 타임라인. 씬 스트립(전체) + 활성 씬 스코프의 눈금/행.
// 행 바 = elementPhases 의 enter/hold/exit 페이즈 세그먼트, 레이어 칩 = elementTimings.

import React from "react";
import { useEditor } from "@/editor/store";
import { uiPrompt, uiConfirm } from "@/editor/ui/dialogs";
import {
  seekTo,
  togglePlay,
  beginScrub,
  endScrub,
  usePlayerPlaying,
  usePlayerFrame,
  getPlayer,
} from "@/editor/playerBridge";
import {
  getKeyframes,
  addCameraKeyframeAt,
  moveCameraKeyframe,
  selectKeyframe,
  deleteCameraKeyframe,
} from "@/editor/camera";
import { getLightKeyframes, addLightKeyframeAt, moveLightKeyframe, deleteLightKeyframe, lightOnSegments } from "@/editor/light";
import {
  channelsForElement,
  KF_CHANNELS,
  CHANNEL_META,
  getElementKeyframes,
  channelKeys,
  addElementKeyframeAt,
  armChannel,
  disarmChannel,
  isChannelArmed,
  moveElementKeyframe,
  moveElementKeyframesBulk,
  deleteElementKeyframe,
  deleteElementKeyframesBulk,
  selectElementKeyframe,
  type KfChannel,
} from "@/editor/elementKeyframes";
import {
  sceneFrames,
  totalFrames,
  sceneStarts,
  frameToScene,
  elementPhases,
  elementTimings,
} from "@/editor/timing";
import { flattenScene, elementLabel, getElement, isContainer, isDescendantOf, parentPath, parsePath, type ElementPath } from "@/editor/specPath";
import type { SceneSpec, SceneElementSpec } from "@engine/motion/SceneRenderer";
import type { ElementKeyframe } from "@engine/motion/keyframes";
import {
  addScene,
  deleteScene,
  duplicateScene,
  moveScene,
  setElementTiming,
  splitElementAtPlayhead,
  trimElementTo,
  duplicateElements,
  deleteElements,
  moveElements,
  trimElementsBy,
  trimTargetOf,
  type TrimTarget,
  splitSceneAt,
  mergeScenes,
  copyElementAnimation,
  hasAnimClipboard,
  pasteElementAnimation,
} from "@/editor/mutations";
import { FPS } from "@/engine/normalize";
import { audioClipList, type AudioClipSpec, type VideoSpec } from "@engine/motion/SceneRenderer";
import {
  docAudioClips,
  addAudioClipFromFile,
  updateAudioClip,
  removeAudioClip,
  removeAudioClips,
  moveAudioClipsBulk,
  duplicateAudioClip,
  splitAudioClipAt,
  getAudioPeaks,
} from "@/editor/audioClips";

// 타임라인 행 드래그 reparent 의 드롭 위치
type TlDropSpot =
  | { kind: "into"; container: ElementPath }
  | { kind: "line"; container: ElementPath | null; index: number; rowPath: ElementPath; edge: "top" | "bottom"; indent: number };
import { usePanelResize } from "@/editor/usePanelResize";
import { tickStep } from "./timeUtil";
import { Playhead, PlayheadCap, TransportTime } from "./Playhead";
import s from "./timeline.module.css";

const GUTTER = 184;
const BEAT_FRAMES_DEFAULT = 0.6 * FPS; // 100BPM = 14.4f
// bpm 을 가진 첫 오디오 클립(=음악)이 비트 그리드를 정한다 — 간격은 60/bpm 초,
// 오프셋은 그 클립의 시작 프레임 (비트 1번이 음악 시작에 앵커).
function beatGrid(doc: unknown): { step: number; offset: number } {
  const clips = audioClipList((doc as VideoSpec | null)?.audio);
  const music = clips.find((c) => c.bpm && c.bpm > 0);
  if (music?.bpm) return { step: (60 / music.bpm) * FPS, offset: music.start ?? 0 };
  return { step: BEAT_FRAMES_DEFAULT, offset: 0 };
}
const ROW_H = 28;
const STRIP_H = 46; // 씬 스트립 높이 (sticky top:0)
const RULER_H = 32; // 눈금 행 높이 (sticky top:STRIP_H) — 스크럽 잡기 쉽게 넉넉히
const TRACK_TOP = STRIP_H + RULER_H; // 트랙 영역 시작 y (구분선/비트/트랜지션 밴드 top)
const HEADER_H = 34; // 트랜스포트 헤더 높이 (접었을 때 패널 높이 = 이것만)

const ROLE_COLOR: Record<string, string> = {
  in: "var(--role-in)",
  hold: "var(--role-hold)",
  out: "var(--role-out)",
  afterIn: "var(--role-afterin)",
};

// 씬 exit 트랜지션(transition_out) → 타임라인 표시용 메타.
// frames: 트랜지션이 씬 마지막 N프레임에 걸리는 길이(밴드 폭 계산용).
//   transitions.ts 의 기본 duration 상수/클램프(4~30f)를 그대로 미러한다.
// hard_cut(순간 컷) 과 미지정은 밴드/뱃지를 그리지 않으므로 null 반환.
type TransitionMeta = { frames: number; label: string; glyph: string };

function transitionMeta(t: SceneSpec["transition_out"]): TransitionMeta | null {
  if (t == null || t === "hard_cut") return null;
  const clampF = (n: number) => Math.max(4, Math.min(30, n));
  // legacy fade — SceneRenderer 는 마지막 12f 에 걸쳐 opacity 를 내린다.
  if (t === "fade") return { frames: 12, label: "fade", glyph: "◐" };
  const dir = "direction" in t ? t.direction : undefined;
  const arrow = dir ? ` → ${dir}` : "";
  switch (t.type) {
    case "slide_push":
      return { frames: clampF(t.frames ?? 12), label: `slide push${arrow}`, glyph: "⇥" };
    case "zoom_punch": {
      const out = (t.toScale ?? 1.5) < 1; // toScale<1 = 뒤로 빠지는 zoom out 변형
      return { frames: clampF(t.frames ?? 10), label: `zoom punch${out ? " out" : ""}`, glyph: "⊙" };
    }
    case "wipe_collapse":
      return { frames: clampF(t.frames ?? 14), label: `wipe collapse${arrow}`, glyph: "◨" };
    case "light_sweep":
      return { frames: clampF(t.frames ?? 12), label: "light sweep", glyph: "✦" };
    case "text_collapse_fill":
      // collapse + fill 두 페이즈 합산이 전체 트랜지션 길이.
      return {
        frames: clampF(t.collapseFrames ?? 12) + clampF(t.fillFrames ?? 12),
        label: "collapse fill",
        glyph: "▭",
      };
    default:
      return null;
  }
}

// 컨텍스트 메뉴 — 뷰포트 경계 클램핑. 클릭 좌표에 그대로 띄우면 하단
// 오디오 레인 등에서 화면 밖으로 잘린다 (실측 리포트). 마운트 직후 실측
// 크기로 좌/상 플립 — useLayoutEffect 라 잘린 프레임이 그려지지 않는다.
function ClampedMenu({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - r.width);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top });
  }, [x, y]);
  return (
    <div
      ref={ref}
      className={s.contextMenu}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>
  );
}

function TypeGlyph({ kind }: { kind: string }) {
  if (kind === "shape")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="2" y="3" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    );
  if (kind === "group")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1" fill="none" strokeDasharray="2 1.5" />
      </svg>
    );
  if (kind === "frame")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <path d="M3.5 1v10M8.5 1v10M1 3.5h10M1 8.5h10" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  if (kind === "logo")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    );
  if (kind === "image")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M2.5 8.5l2.5-2.5 2 1.8 1.5-1.3 1 1" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="4.5" cy="4.5" r="0.9" fill="currentColor" />
      </svg>
    );
  if (kind === "video")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M5 4.4v3.2L7.8 6z" fill="currentColor" />
      </svg>
    );
  if (kind === "shader")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M2 8c1.4-1.2 2.6-1.2 4 0s2.6 1.2 4 0" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" />
        <path d="M2 5.4c1.4-1.2 2.6-1.2 4 0s2.6 1.2 4 0" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" opacity="0.55" />
      </svg>
    );
  if (kind === "device")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="3.5" y="1.5" width="5" height="9" rx="1.2" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M5.2 2.6h1.6" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" />
      </svg>
    );
  if (kind === "gooey")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <circle cx="4.4" cy="6" r="2.6" stroke="currentColor" strokeWidth="1" fill="none" />
        <circle cx="8.2" cy="6.6" r="1.8" stroke="currentColor" strokeWidth="1" fill="none" />
      </svg>
    );
  if (kind === "edge_light")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="3" width="9" height="6" rx="2.6" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.35" />
        <path d="M3 3.2c1.6-.5 4.4-.5 6 0" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      </svg>
    );
  if (kind === "particles")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <circle cx="3" cy="4" r="1" fill="currentColor" />
        <circle cx="8.6" cy="3.2" r="0.8" fill="currentColor" opacity="0.7" />
        <circle cx="6" cy="8.4" r="1.1" fill="currentColor" opacity="0.85" />
      </svg>
    );
  if (kind === "neon_pill" || kind === "glow_card" || kind === "glow_menu")
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
        <rect x="1.5" y="3" width="9" height="6" rx="2.6" stroke="currentColor" strokeWidth="1" fill="none" />
        <path d="M6 1.2l.6 1.2 1.2.6-1.2.6L6 4.8l-.6-1.2-1.2-.6 1.2-.6z" fill="currentColor" opacity="0.8" />
      </svg>
    );
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
      <path d="M2 3h8M6 3v6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

export default function TimelinePanel() {
  const doc = useEditor((st) => st.doc);
  const activeScene = useEditor((st) => st.activeScene);
  const selection = useEditor((st) => st.selection);
  const hovered = useEditor((st) => st.hovered);
  const pxPerFrame = useEditor((st) => st.ui.pxPerFrame);
  const showBeat = useEditor((st) => st.ui.showBeatGrid);
  const recordKeyframes = useEditor((st) => st.ui.recordKeyframes);
  const setUI = useEditor((st) => st.setUI);
  const playing = usePlayerPlaying();

  const scrollRef = React.useRef<HTMLDivElement>(null);
  // 타임라인 "안"에서의 조작(키프레임/행 클릭) 직후엔 자동 스크롤 억제 —
  // 캔버스/JSON 등 밖에서 온 선택만 트랙을 따라오게 (사용자 UX 결정)
  const tlInteractRef = React.useRef(0);
  React.useEffect(() => {
    const p0 = selection[0];
    const c = scrollRef.current;
    if (!p0 || !c) return;
    if (Date.now() - tlInteractRef.current < 600) return; // 타임라인 내부 발 선택
    const node = c.querySelector(`[data-tlrow="${CSS.escape(p0)}"]`);
    if (!node) return;
    const nb = node.getBoundingClientRect();
    const cb = c.getBoundingClientRect();
    const delta = nb.top + nb.height / 2 - (cb.top + cb.height / 2);
    if (Math.abs(delta) > 4) c.scrollTo({ top: c.scrollTop + delta, behavior: "smooth" });
  }, [selection]);
  // 눈금 스크럽 (훅은 조건부 return 위에 전부 선언 — Rules of Hooks)
  const scrubbing = React.useRef(false);
  const rulerRef = React.useRef<HTMLDivElement>(null);

  // ---- 요소 행 드래그 → 계층 이동(reparent) — 레이어 패널과 동일 동작을 타임
  //      라인 거터에 이식. 그룹/frame 위(중앙)에 놓으면 안으로, 요소 사이 line
  //      이면 형제 재정렬. flattenScene 은 정순(index0=최상단)이라 line 인덱스
  //      계산이 레이어 패널(역순)과 반대. ----
  const DRAG_TH = 5;
  const rowDragRef = React.useRef<{ path: ElementPath; startX: number; startY: number; started: boolean } | null>(null);
  const dropRef = React.useRef<TlDropSpot | null>(null);
  const clickGuardRef = React.useRef(false);
  const [dropSpot, setDropSpotState] = React.useState<TlDropSpot | null>(null);
  const setDrop = (d: TlDropSpot | null) => { dropRef.current = d; setDropSpotState(d); };

  const computeRowDrop = (clientX: number, clientY: number, dragged: ElementPath): TlDropSpot | null => {
    const d0 = useEditor.getState().doc;
    if (!d0) return null;
    const draggedScene = parsePath(dragged).sceneIdx;
    let hit = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest?.("[data-tlpath]") as HTMLElement | null;
    if (!hit) {
      for (const n of scrollRef.current?.querySelectorAll<HTMLElement>("[data-tlpath]") ?? []) {
        const r = n.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) { hit = n; break; }
      }
    }
    const hitPath = hit?.dataset.tlpath;
    if (!hitPath) return null;
    if (hitPath === dragged || isDescendantOf(hitPath, dragged)) return null;
    if (parsePath(hitPath).sceneIdx !== draggedScene) return null; // 씬 넘나드는 이동 금지
    const el = getElement(d0, hitPath);
    const container = isContainer(el);
    const rect = hit!.getBoundingClientRect();
    const rel = (clientY - rect.top) / Math.max(1, rect.height);
    const depth = parsePath(hitPath).indices.length - 1;
    // 컨테이너 중앙(위 15% 제외)에 놓으면 그 안으로
    if (container && rel >= 0.15) return { kind: "into", container: hitPath };
    const parent = parentPath(hitPath);
    if (parent && isDescendantOf(parent, dragged)) return null;
    const arrayIdx = parsePath(hitPath).indices.at(-1) ?? 0;
    // 정순: 위 절반 = 그 앞(같은 인덱스), 아래 절반 = 그 뒤(+1)
    return rel < 0.5
      ? { kind: "line", container: parent, index: arrayIdx, rowPath: hitPath, edge: "top", indent: 10 + depth * 12 }
      : { kind: "line", container: parent, index: arrayIdx + 1, rowPath: hitPath, edge: "bottom", indent: 10 + depth * 12 };
  };

  const onRowDragDown = (e: React.PointerEvent, path: ElementPath) => {
    if (e.button !== 0) return;
    rowDragRef.current = { path, startX: e.clientX, startY: e.clientY, started: false };
  };
  const onRowDragMove = (e: React.PointerEvent) => {
    const d = rowDragRef.current;
    if (!d) return;
    if (!d.started) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_TH) return;
      d.started = true;
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    }
    // 세로 가장자리 오토스크롤
    const sc = scrollRef.current;
    if (sc) {
      const r = sc.getBoundingClientRect();
      if (e.clientY < r.top + 40) sc.scrollTop -= 8;
      else if (e.clientY > r.bottom - 30) sc.scrollTop += 8;
    }
    setDrop(computeRowDrop(e.clientX, e.clientY, d.path));
  };
  const onRowDragUp = () => {
    const d = rowDragRef.current;
    rowDragRef.current = null;
    if (d?.started) {
      clickGuardRef.current = true;
      setTimeout(() => { clickGuardRef.current = false; }, 0);
      const spot = dropRef.current;
      if (spot) {
        if (spot.kind === "into") {
          const el = getElement(useEditor.getState().doc!, spot.container);
          const len = isContainer(el) ? (el.children?.length ?? 0) : 0;
          moveElements([d.path], { container: spot.container, index: len });
        } else {
          moveElements([d.path], { container: spot.container, index: spot.index });
        }
      }
    }
    setDrop(null);
  };

  // cmd/ctrl+wheel 로 pxPerFrame 줌 — 네이티브 non-passive 등록(React onWheel 은
  // passive 라 preventDefault 가 콘솔 에러를 도배한다). 훅이므로 조기 return 위에.
  const onWheelRef = React.useRef<(e: WheelEvent) => void>(() => {});
  onWheelRef.current = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setUI({ pxPerFrame: Math.max(3, Math.min(40, pxPerFrame * factor)) });
    }
  };
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => onWheelRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
    // doc 로드 전엔 scrollRef 가 없다(조기 return 트리) → doc 생기면 재부착.
  }, [doc !== null]);

  // 패널 높이(store) + 리사이즈 + 접기
  const bottomHeight = useEditor((st) => st.ui.bottomHeight);
  const bottomCollapsed = useEditor((st) => st.ui.bottomCollapsed);
  const maxH = Math.round((typeof window !== "undefined" ? window.innerHeight : 900) * 0.7);
  const { dragging: resizing, handleProps: resizeProps } = usePanelResize({
    key: "bottomHeight", axis: "y", dir: -1, min: 140, max: maxH,
  });
  const panelH = bottomCollapsed ? HEADER_H : bottomHeight;

  if (!doc) {
    return (
      <div className={s.panel} style={{ height: panelH }}>
        <div className={s.resizeHandle} {...resizeProps} />
        <div className={s.header}>
          <span className={s.headerHint}>No spec</span>
        </div>
      </div>
    );
  }

  const starts = sceneStarts(doc, FPS);
  const total = totalFrames(doc, FPS);
  const totalW = total * pxPerFrame;
  // 연속 타임라인: 모든 씬을 하나의 트랙에 이어 붙인다. 각 씬 행의 바/키프레임은
  // 그 씬 시작 프레임(starts[si])만큼 우측으로 밀어 전역 프레임 위치에 놓는다.
  const totalElemCount = doc.scenes.reduce(
    (n, _sc, si) => n + flattenScene(doc, si).length,
    0,
  );

  const step = tickStep(pxPerFrame);
  const ticks: number[] = [];
  for (let f = 0; f <= total; f += step) ticks.push(f);

  const BEAT = beatGrid(doc);
  const beats: number[] = [];
  if (showBeat) {
    for (let f = BEAT.offset; f <= total; f += BEAT.step) beats.push(f);
  }

  const seekFromClient = (clientX: number) => {
    const el = rulerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let f = Math.round((clientX - r.left) / pxPerFrame);
    if (showBeat) {
      // 비트선 근처면 스냅
      const nearest = BEAT.offset + Math.round((f - BEAT.offset) / BEAT.step) * BEAT.step;
      if (Math.abs(nearest - f) * pxPerFrame < 5) f = Math.round(nearest);
    }
    seekTo(Math.max(0, Math.min(total, f)));
  };
  const onRulerDown = (e: React.PointerEvent) => {
    scrubbing.current = true;
    beginScrub();
    // 캡처는 비활성 pointerId(합성/펜)에서 throw — seek 이 죽지 않게 가드
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    seekFromClient(e.clientX);
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (scrubbing.current) seekFromClient(e.clientX);
  };
  const onRulerUp = (e: React.PointerEvent) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    endScrub();
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };


  return (
    <div className={s.panel} style={{ height: panelH }} data-collapsed={bottomCollapsed} data-resizing={resizing}>
      {!bottomCollapsed && <div className={s.resizeHandle} {...resizeProps} />}

      {/* 헤더 */}
      <div className={s.header}>
        <div className={s.headerSpacer} />
        <div className={s.transport}>
          <button className="icon-btn" onClick={() => seekTo(0)} title="Go to start">
            <SkipIcon dir="start" />
          </button>
          <button className="icon-btn" onClick={() => togglePlay()} title="Play/Pause (Space)">
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="icon-btn" onClick={() => seekTo(total)} title="Go to end">
            <SkipIcon dir="end" />
          </button>
          <button
            className={s.recBtn}
            data-active={recordKeyframes}
            onClick={() => setUI({ recordKeyframes: !recordKeyframes })}
            title="Record keyframes — 켜두고 캔버스에서 요소를 드래그/회전하면 재생헤드에 자동 키프레임"
          >
            <svg width="11" height="11" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" fill="currentColor" /></svg>
            <span className={s.recLabel}>REC</span>
          </button>
          <TransportTime total={total} />
        </div>
        <div className={s.headerRight}>
          <button
            className="icon-btn"
            data-active={showBeat}
            onClick={() => setUI({ showBeatGrid: !showBeat })}
            title="Beat grid 0.6s (100BPM)"
          >
            <BeatIcon />
          </button>
          <div className={s.zoomSlider}>
            <input
              type="range"
              min={3}
              max={40}
              step={0.5}
              value={pxPerFrame}
              onChange={(e) => setUI({ pxPerFrame: Number(e.target.value) })}
              aria-label="Timeline zoom"
            />
          </div>
          {/* 타임라인 접기/펼치기 */}
          <button
            className="icon-btn"
            title={bottomCollapsed ? "Expand timeline" : "Collapse timeline"}
            onClick={() => setUI({ bottomCollapsed: !bottomCollapsed })}
          >
            <svg width="13" height="13" viewBox="0 0 12 12" style={{ transform: bottomCollapsed ? "scaleY(-1)" : undefined }}>
              <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* 눈금 + 행 (sticky 거터/눈금) — 모든 씬을 하나의 연속 트랙에 */}
      <div className={s.scrollArea} ref={scrollRef} onPointerDownCapture={() => (tlInteractRef.current = Date.now())}>
        <div className={s.inner} style={{ width: GUTTER + totalW }}>
          {/* 씬 스트립 (스크롤 영역 안 — 아래 눈금자와 폭/위치 정렬, sticky top) */}
          <SceneStrip
            doc={doc}
            starts={starts}
            activeScene={activeScene}
            pxPerFrame={pxPerFrame}
            totalW={totalW}
          />

          {/* 눈금 행 (전체 영상 길이) */}
          <div className={s.rulerRow}>
            <div className={s.corner}>
              <span className={s.cornerLabel}>
                {(total / FPS).toFixed(1)}s · {doc.scenes.length} scenes
              </span>
            </div>
            <div
              className={s.ruler}
              ref={rulerRef}
              style={{ width: totalW }}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
            >
              {ticks.map((f) => (
                <div key={f} className={s.tick} style={{ left: f * pxPerFrame }}>
                  <span className={s.tickLabel}>
                    {f % FPS === 0 ? `${f / FPS}s` : f}
                  </span>
                </div>
              ))}
              {/* 재생헤드 캡 — 눈금과 함께 sticky 고정 (라인은 트랙 영역 z7) */}
              <PlayheadCap sceneStart={0} sceneFrames={total} pxPerFrame={pxPerFrame} />
            </div>
          </div>

          {/* 씬 구분선 — 각 씬 경계에 세로선(트랙 영역 전체 높이) */}
          {starts.slice(1, -1).map((f, i) => (
            <div
              key={`div-${i}`}
              className={s.sceneDivider}
              style={{ left: GUTTER + f * pxPerFrame }}
            />
          ))}

          {/* 비트 그리드 */}
          {showBeat &&
            beats.map((f, i) => (
              <div
                key={i}
                className={s.beatLine}
                style={{ left: GUTTER + f * pxPerFrame }}
              />
            ))}

          {/* 카메라 트랙 — 모든 씬의 키프레임을 한 행에(각 씬 오프셋만큼 이동) */}
          <ContinuousCameraTrack
            doc={doc}
            starts={starts}
            pxPerFrame={pxPerFrame}
            totalW={totalW}
          />

          {/* 요소 행 — 모든 씬의 요소를 각 씬 시간 슬롯에 */}
          {totalElemCount === 0 ? (
            <div className={s.emptyRows}>
              No elements — press <span className="keycap">T</span> to add text
            </div>
          ) : (
            doc.scenes.map((sc, si) => {
              const off = starts[si] ?? 0;
              const sF = sceneFrames(sc, FPS);
              return flattenScene(doc, si).map(({ path, el, depth }) => (
                <ElementRow
                  key={path}
                  path={path}
                  el={el}
                  label={elementLabel(el)}
                  kind={el.element}
                  depth={depth}
                  selected={selection.includes(path)}
                  hovered={hovered === path}
                  phases={el.element === "group" ? null : elementPhases(el, sc, FPS)}
                  layers={elementTimings(el, sc, FPS)}
                  pxPerFrame={pxPerFrame}
                  sceneF={sF}
                  sceneIdx={si}
                  frameOffset={off}
                  totalW={totalW}
                  onRowDragDown={onRowDragDown}
                  onRowDragMove={onRowDragMove}
                  onRowDragUp={onRowDragUp}
                  clickGuardRef={clickGuardRef}
                  dropSpot={dropSpot}
                />
              ));
            })
          )}

          {/* exit 트랜지션 밴드 — 씬마다 그 씬 끝에 트랜지션 길이만큼. */}
          {doc.scenes.map((sc, si) => {
            const tmeta = transitionMeta(sc.transition_out);
            const sF = sceneFrames(sc, FPS);
            if (!tmeta || sF <= 0) return null;
            const tf = Math.min(tmeta.frames, sF);
            const off = starts[si] ?? 0;
            return (
              <div
                key={`trans-${si}`}
                className={s.transitionBand}
                style={{ left: GUTTER + (off + sF - tf) * pxPerFrame, width: tf * pxPerFrame }}
                title={`Exit transition: ${tmeta.label}`}
              >
                <span className={s.transitionLabel}>{tmeta.label}</span>
              </div>
            );
          })}

          {/* 플레이헤드 (전역 프레임) */}
          <Playhead
            sceneStart={0}
            sceneFrames={total}
            pxPerFrame={pxPerFrame}
            gutter={GUTTER}
           onScrubDown={onRulerDown} onScrubMove={onRulerMove} onScrubUp={onRulerUp} />

          {/* 오버스크롤 스페이서 — 마지막 요소 행이 오디오 레인 위로 스크롤될
              여유. margin-top:auto 라 콘텐츠가 적으면 레인을 패널 바닥에 민다. */}
          <div className={s.audioSpacer} />
          {/* 오디오 레인 — NLE 관례(비디오 트랙 아래). sticky bottom 으로 요소
              행이 많아도 항상 보인다. 음악은 씬 경계와 무관하게 전 씬 관통. */}
          <AudioLane
            doc={doc}
            starts={starts}
            total={total}
            totalW={totalW}
            pxPerFrame={pxPerFrame}
            showBeat={showBeat}
            beatStep={BEAT.step}
            beatOffset={BEAT.offset}
          />
        </div>
      </div>
    </div>
  );
}

// ---- 오디오 레인 ----
// 클립 바 = [start, start+duration) 컴프 프레임 구간. 겹치는 클립(음악 위 SFX)은
// 자동으로 아래 서브레인에 쌓인다. 바디 드래그 = 이동, 양끝 = 트림(왼쪽은
// trimStart 도 함께 — 소스의 읽기 시작점이 따라간다), 우클릭 = 분할/복제/삭제.
const AUDIO_LANE_H = 34;

function assignAudioLanes(
  clips: AudioClipSpec[],
  total: number,
): { clip: AudioClipSpec; lane: number }[] {
  const sorted = [...clips].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const laneEnds: number[] = [];
  return sorted.map((clip) => {
    const s0 = clip.start ?? 0;
    const e0 = s0 + (clip.duration ?? Math.max(1, total - s0));
    let lane = laneEnds.findIndex((end) => end <= s0);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(e0);
    } else laneEnds[lane] = e0;
    return { clip, lane };
  });
}

// 클립 바 파형 — 디코드된 피크 캐시(getAudioPeaks)에서 [trimStart, +durSec)
// 창만 그린다. 트림/줌으로 폭이 변하면 다시 그림 (피크는 재사용).
function WaveCanvas({ src, trimSec, durSec, w, h }: { src: string; trimSec: number; durSec: number; w: number; h: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    let alive = true;
    void getAudioPeaks(src).then((pk) => {
      const cv = ref.current;
      if (!alive || !pk || !cv) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(110, 231, 183, 0.6)";
      const cols = Math.max(1, Math.floor(w / 2));
      for (let x = 0; x < cols; x++) {
        const sec = trimSec + ((x + 0.5) / cols) * durSec;
        const v = pk.peaks[Math.floor(sec / pk.secPerBucket)] ?? 0;
        const bh = Math.max(1, v * (h - 8));
        ctx.fillRect(x * 2, (h - bh) / 2, 1.4, bh);
      }
    });
    return () => {
      alive = false;
    };
  }, [src, trimSec, durSec, w, h]);
  return <canvas ref={ref} className={s.audioWave} style={{ width: w, height: h }} />;
}

function AudioLane({
  doc,
  starts,
  total,
  totalW,
  pxPerFrame,
  showBeat,
  beatStep,
  beatOffset,
}: {
  doc: VideoSpec;
  starts: number[];
  total: number;
  totalW: number;
  pxPerFrame: number;
  showBeat: boolean;
  beatStep: number;
  beatOffset: number;
}) {
  const selectedAudio = useEditor((st) => st.ui.selectedAudio);
  const clips = docAudioClips(doc);
  const placed = assignAudioLanes(clips, total);
  const laneCount = Math.max(1, placed.reduce((m, p) => Math.max(m, p.lane + 1), 0));
  const [menu, setMenu] = React.useState<{ x: number; y: number; id: string } | null>(null);

  const dragRef = React.useRef<{
    id: string;
    mode: "move" | "trimL" | "trimR";
    startX: number;
    start0: number;
    dur0: number;
    trim0: number; // sec
    srcSec: number | null;
    moved: boolean;
    /** move 모드: 함께 끌 다중 선택 스냅샷 (그랩한 클립 포함) */
    group: { id: string; start0: number }[];
  } | null>(null);

  // 스냅 후보: 씬 경계 + 0/끝 + (비트 그리드 켜져 있으면) 비트 프레임
  const snapF = (f: number): number => {
    const th = 6 / pxPerFrame;
    let best = f;
    let bd = th;
    const cands: number[] = [0, total, ...starts];
    if (showBeat) for (let b = beatOffset; b <= total; b += beatStep) cands.push(b);
    for (const c of cands) {
      const d = Math.abs(c - f);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return Math.round(best);
  };

  const selectClip = (id: string, additive = false) => {
    const st = useEditor.getState();
    const cur = st.ui.selectedAudio;
    if (additive) {
      // shift 클릭 = 토글 (요소 선택은 건드리지 않음 — 이미 배타 보장됨)
      st.clearSelection();
      st.setUI({ selectedAudio: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
      return;
    }
    st.clearSelection();
    // 이미 다중 선택 안의 클립을 잡으면 선택 유지 (함께 드래그)
    st.setUI({ selectedAudio: cur.includes(id) && cur.length > 1 ? cur : [id] });
  };

  const onClipDown = (e: React.PointerEvent, clip: AudioClipSpec, mode: "move" | "trimL" | "trimR") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey) {
      // shift = 선택 토글만 — 드래그 시작 안 함 (Figma/NLE 관례)
      selectClip(clip.id!, true);
      return;
    }
    selectClip(clip.id!);
    // move 는 선택된 클립 전체를 함께 (트림은 잡은 클립만)
    const selNow = useEditor.getState().ui.selectedAudio;
    const group = (mode === "move" && selNow.includes(clip.id!) ? selNow : [clip.id!])
      .map((id) => {
        const c = clips.find((cl) => cl.id === id);
        return c ? { id, start0: c.start ?? 0 } : null;
      })
      .filter(Boolean) as { id: string; start0: number }[];
    useEditor.getState().beginGesture();
    dragRef.current = {
      id: clip.id!,
      mode,
      startX: e.clientX,
      start0: clip.start ?? 0,
      dur0: clip.duration ?? Math.max(1, total - (clip.start ?? 0)),
      trim0: clip.trimStart ?? 0,
      srcSec: clip.sourceSec ?? null,
      moved: false,
      group,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 무시 */
    }
  };
  const onClipMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / pxPerFrame;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    d.moved = true;
    if (d.mode === "move") {
      // 그랩한 클립 기준으로 스냅한 델타를 그룹 전체에 (간격 유지, 0 밑 금지)
      let delta = snapF(d.start0 + dx) - d.start0;
      const minStart0 = Math.min(...d.group.map((g) => g.start0));
      delta = Math.max(-minStart0, delta);
      moveAudioClipsBulk(d.group, delta, true);
    } else if (d.mode === "trimL") {
      // 왼끝 트림 — 시작점과 소스 읽기 지점이 같이 움직인다 (내용은 제자리)
      let delta = snapF(d.start0 + dx) - d.start0;
      delta = Math.max(-Math.round(d.trim0 * FPS), Math.min(d.dur0 - 1, delta));
      updateAudioClip(
        d.id,
        { start: d.start0 + delta, trimStart: Math.max(0, d.trim0 + delta / FPS), duration: d.dur0 - delta },
        "Trim audio clip",
        true,
      );
    } else {
      const maxDur = d.srcSec != null ? Math.round((d.srcSec - d.trim0) * FPS) : Infinity;
      const next = Math.max(1, Math.min(maxDur, snapF(d.start0 + d.dur0 + dx) - d.start0));
      updateAudioClip(d.id, { duration: next }, "Trim audio clip", true);
    }
  };
  const onClipUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    useEditor.getState().endGesture();
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const playheadFrame = () => Math.round(getPlayer()?.getCurrentFrame() ?? 0);

  return (
    <div className={s.audioLaneRow} style={{ height: laneCount * AUDIO_LANE_H }}>
      <div className={s.gutterCell} style={{ paddingLeft: 10 }}>
        <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}>
          <path d="M4.6 2.4v6.1M4.6 2.4l4.6-1v6.1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <circle cx="3.2" cy="8.6" r="1.5" stroke="currentColor" strokeWidth="1" fill="none" />
          <circle cx="7.8" cy="7.6" r="1.5" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
        <span className={s.rowLabel}>Audio</span>
        <button
          className={s.kfAdd}
          title="Add audio at playhead (music or SFX)"
          onClick={(e) => {
            e.stopPropagation();
            addAudioClipFromFile(playheadFrame());
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        className={s.audioTrack}
        style={{ width: totalW }}
        onClick={(e) => {
          if (e.target === e.currentTarget) useEditor.getState().setUI({ selectedAudio: [] });
        }}
      >
        {placed.map(({ clip, lane }) => {
          const start = clip.start ?? 0;
          const durF = clip.duration ?? Math.max(1, total - start);
          const w = Math.max(4, durF * pxPerFrame);
          const clipH = AUDIO_LANE_H - 8;
          return (
            <div
              key={clip.id}
              className={s.audioClip}
              data-selected={selectedAudio.includes(clip.id ?? "")}
              style={{ left: start * pxPerFrame, top: lane * AUDIO_LANE_H + 4, width: w, height: clipH }}
              onPointerDown={(e) => onClipDown(e, clip, "move")}
              onPointerMove={onClipMove}
              onPointerUp={onClipUp}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // 다중 선택 안의 클립이면 선택 유지 (일괄 삭제 메뉴)
                if (!useEditor.getState().ui.selectedAudio.includes(clip.id ?? "")) selectClip(clip.id!);
                setMenu({ x: e.clientX, y: e.clientY, id: clip.id! });
              }}
              title={`${clip.name ?? clip.src.split("/").pop()} · f${start}–${start + durF}${clip.bpm ? ` · ${clip.bpm} BPM` : ""}`}
            >
              <WaveCanvas src={clip.src} trimSec={clip.trimStart ?? 0} durSec={durF / FPS} w={w} h={clipH} />
              <span className={s.audioClipName}>
                {clip.name ?? clip.src.split("/").pop()}
                {clip.bpm ? <span className={s.audioBpm}>{clip.bpm} BPM</span> : null}
              </span>
              <div className={s.audioEdge} style={{ left: 0 }} onPointerDown={(e) => onClipDown(e, clip, "trimL")} />
              <div className={s.audioEdge} style={{ right: 0 }} onPointerDown={(e) => onClipDown(e, clip, "trimR")} />
            </div>
          );
        })}
        {clips.length === 0 && (
          <span className={s.kfHint}>Add music or SFX with + (one track can run across all scenes)</span>
        )}
      </div>

      {menu && (
        <>
          <div
            className={s.menuBackdrop}
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <ClampedMenu x={menu.x} y={menu.y}>
            {(() => {
              const c = clips.find((cl) => cl.id === menu.id);
              const gf = playheadFrame();
              const start = c?.start ?? 0;
              const durF = c?.duration ?? Math.max(1, total - start);
              const inside = !!c && gf > start && gf < start + durF;
              return (
                <button
                  className={s.menuItem}
                  disabled={!inside}
                  title={inside ? undefined : "Move the playhead inside this clip first"}
                  onClick={() => {
                    splitAudioClipAt(menu.id, gf);
                    setMenu(null);
                  }}
                >
                  Split at playhead
                </button>
              );
            })()}
            <button
              className={s.menuItem}
              onClick={() => {
                duplicateAudioClip(menu.id);
                setMenu(null);
              }}
            >
              Duplicate clip
            </button>
            <div className={s.menuSep} />
            {(() => {
              const many = selectedAudio.length > 1 && selectedAudio.includes(menu.id);
              return (
                <button
                  className={s.menuItem}
                  data-danger
                  onClick={() => {
                    if (many) removeAudioClips(selectedAudio);
                    else removeAudioClip(menu.id);
                    setMenu(null);
                  }}
                >
                  {many ? `Delete ${selectedAudio.length} clips` : "Delete clip"}
                </button>
              );
            })()}
          </ClampedMenu>
        </>
      )}
    </div>
  );
}

// ---- 가장자리 오토스크롤 (NLE 관례) ----
// 드래그 중 포인터가 스크롤 영역 좌/우 가장자리 근처면 rAF 로 계속 스크롤하며
// tick(v) 로 드래그 값도 같이 자라게 한다. 오른쪽 끝에서 씬을 늘릴 때 콘텐츠
// 폭이 자라면서 스크롤이 따라가는 구조 (값 먼저 -> 폭 확장 -> 스크롤).
const EDGE_ZONE = 44;
const EDGE_MAX_SPEED = 26;
function edgeScrollController() {
  let raf = 0;
  const stop = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
  const update = (scrollEl: HTMLElement, clientX: number, tick: (v: number) => void) => {
    stop();
    const r = scrollEl.getBoundingClientRect();
    let v = 0;
    if (clientX > r.right - EDGE_ZONE) v = Math.min(EDGE_MAX_SPEED, 4 + (clientX - (r.right - EDGE_ZONE)) * 0.4);
    else if (clientX < r.left + EDGE_ZONE) v = -Math.min(EDGE_MAX_SPEED, 4 + (r.left + EDGE_ZONE - clientX) * 0.4);
    if (!v) return;
    const loop = () => {
      tick(v);
      scrollEl.scrollLeft += v;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };
  return { update, stop };
}
function findScrollArea(from: HTMLElement): HTMLElement | null {
  return from.closest(`.${s.scrollArea}`) as HTMLElement | null;
}

// ---- 씬 스트립 ----
function SceneStrip({
  doc,
  starts,
  activeScene,
  pxPerFrame,
  totalW,
}: {
  doc: NonNullable<ReturnType<typeof useEditor.getState>["doc"]>;
  starts: number[];
  activeScene: number;
  pxPerFrame: number;
  totalW: number;
}) {
  const setActiveScene = useEditor((st) => st.setActiveScene);
  // 씬 클릭 시 활성 씬 전환 + 플레이어를 그 씬 시작 프레임으로 정확히 이동.
  // (frameToScene 이 경계 프레임 starts[i] 를 씬 i 로 해석하므로 +1 불필요)
  const selectScene = (i: number) => {
    useEditor.getState().clearSelection(); // 씬 스트립으로 씬 넘길 때만 선택 해제
    setActiveScene(i);
    seekTo(starts[i] ?? 0);
  };
  const [menu, setMenu] = React.useState<{ x: number; y: number; idx: number } | null>(null);
  const dragEdge = React.useRef<{ idx: number; startX: number; dur: number; extra: number } | null>(null);
  const scroller = React.useRef(edgeScrollController()).current;
  // 씬 블록 가로 드래그 = 연속 범위 다중 선택 (병합용). moved 면 click 의
  // 일반 선택(=multiSel 클리어)을 건너뛴다.
  const stripDrag = React.useRef<{ startIdx: number; moved: boolean } | null>(null);

  const applyEdgeDur = (clientX: number) => {
    const d = dragEdge.current;
    if (!d) return;
    // extra = 오토스크롤로 흘러간 픽셀 (포인터가 안 움직여도 값이 자란다)
    const deltaFrames = (clientX - d.startX + d.extra) / pxPerFrame;
    // 프레임 단위 스냅 — 씬 길이의 진실은 프레임이다 (0.1s 스텝은 24fps 에서
    // 2.4프레임씩 튀어 정밀 편집 불가, 실측 리포트)
    const nextFrames = Math.max(Math.round(0.3 * FPS), Math.min(30 * FPS, Math.round(d.dur * FPS + deltaFrames)));
    const next = nextFrames / FPS;
    useEditor.getState().updateDoc(
      "Scene duration",
      (draft) => {
        draft.scenes[d.idx].duration = next;
      },
      { coalesceKey: `scene-dur-${d.idx}` },
    );
  };
  const onEdgeDown = (e: React.PointerEvent, idx: number) => {
    e.stopPropagation();
    const scene = doc.scenes[idx];
    if (scene.fit === "auto") return;
    dragEdge.current = { idx, startX: e.clientX, dur: scene.duration ?? 2.5, extra: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onEdgeMove = (e: React.PointerEvent) => {
    const d = dragEdge.current;
    if (!d) return;
    applyEdgeDur(e.clientX);
    const scrollEl = findScrollArea(e.currentTarget as HTMLElement);
    if (scrollEl) {
      const cx = e.clientX;
      scroller.update(scrollEl, cx, (v) => {
        const dd = dragEdge.current;
        if (!dd) return;
        dd.extra += v;
        applyEdgeDur(cx);
      });
    }
  };
  const onEdgeUp = (e: React.PointerEvent) => {
    if (!dragEdge.current) return;
    dragEdge.current = null;
    scroller.stop();
    useEditor.getState().endCoalescing();
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const sceneMultiSel = useEditor((st) => st.ui.sceneMultiSel);

  return (
    <div className={s.sceneStripRow} onPointerMove={onEdgeMove} onPointerUp={onEdgeUp}>
      {/* sticky 코너 — 눈금자/거터 왼쪽 열과 정렬. 씬 추가 버튼. */}
      <div className={s.sceneStripCorner}>
        <button className={s.sceneAdd} onClick={() => addScene()} title="Add scene">
          +
        </button>
      </div>
      {/* 카드 트랙 — 각 씬을 시작 프레임/길이에 맞춰 절대 배치(아래 눈금자와 정렬). */}
      <div className={s.sceneStripCards} style={{ width: totalW }}>
        {doc.scenes.map((scene, i) => {
          const left = starts[i] * pxPerFrame;
          const w = Math.max(2, (starts[i + 1] - starts[i]) * pxPerFrame);
          const trans = transitionMeta(scene.transition_out); // exit 트랜지션 뱃지용
          return (
            <div
              key={scene.id ?? i}
              className={s.sceneBlock}
              data-active={i === activeScene}
              data-multisel={sceneMultiSel.includes(i)}
              style={{ position: "absolute", left, width: w, top: 6, height: 34 }}
              onPointerDown={(e) => {
                if (e.shiftKey || e.button !== 0) return;
                stripDrag.current = { startIdx: i, moved: false };
              }}
              onPointerEnter={(e) => {
                // 좌클릭 누른 채 이웃 블록 위로 드래그 = 연속 범위 선택
                const d = stripDrag.current;
                if (!d || !(e.buttons & 1) || i === d.startIdx) return;
                d.moved = true;
                const lo = Math.min(d.startIdx, i);
                const hi = Math.max(d.startIdx, i);
                const range = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
                useEditor.setState((s2) => ({ ui: { ...s2.ui, sceneMultiSel: range } }));
              }}
              onClick={(e) => {
                const dragged = stripDrag.current?.moved;
                stripDrag.current = null;
                if (dragged) return; // 드래그 범위 선택 완료 — 클리어 금지
                // shift 클릭 = 병합용 다중 선택 토글 (연속 여부는 병합 시 검사).
                // 비어 있으면 활성 씬을 시드로 — "클릭 A, shift-클릭 B" 가
                // [A, B] 가 되도록 (Figma 시멘틱. 이전엔 B 만 들어가 병합 불가).
                if (e.shiftKey) {
                  const st = useEditor.getState();
                  const cur = st.ui.sceneMultiSel;
                  const seed = cur.length === 0 && st.activeScene !== i ? [st.activeScene] : cur;
                  const next = seed.includes(i) ? seed.filter((x) => x !== i) : [...seed, i];
                  useEditor.setState((s2) => ({ ui: { ...s2.ui, sceneMultiSel: next } }));
                  return;
                }
                useEditor.setState((s2) => ({ ui: { ...s2.ui, sceneMultiSel: [] } }));
                selectScene(i);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, idx: i });
              }}
            >
              <div className={s.sceneBlockInner}>
                <span className={s.sceneName}>{scene.id ?? `Scene ${i + 1}`}</span>
                <span className={`${s.sceneDur} tnum`}>
                  {scene.fit === "auto"
                    ? "auto"
                    : `${(Math.round((scene.duration ?? 2.5) * 100) / 100).toFixed(2).replace(/\.?0+$/, "")}s · ${Math.round((scene.duration ?? 2.5) * FPS)}f`}
                </span>
              </div>
              {trans && (
                <span className={s.sceneTransBadge} title={`Exit: ${trans.label}`}>
                  {trans.glyph}
                </span>
              )}
              {scene.fit !== "auto" && (
                <div className={s.sceneEdge} onPointerDown={(e) => onEdgeDown(e, i)} />
              )}
            </div>
          );
        })}
      </div>

      {menu && (
        <>
          <div className={s.menuBackdrop} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <ClampedMenu x={menu.x} y={menu.y}>
            {(() => {
              const gf = Math.round(getPlayer()?.getCurrentFrame() ?? 0);
              const inScene = gf > (starts[menu.idx] ?? 0) && gf < (starts[menu.idx + 1] ?? 0);
              return (
                <button
                  className={s.menuItem}
                  disabled={!inScene}
                  title={inScene ? undefined : "Move the playhead inside this scene first"}
                  onClick={() => { splitSceneAt(menu.idx, gf - (starts[menu.idx] ?? 0)); setMenu(null); }}
                >
                  Split scene at playhead <span className={s.menuKey}>⇧S</span>
                </button>
              );
            })()}
            {sceneMultiSel.length >= 2 && sceneMultiSel.includes(menu.idx) && (
              <button className={s.menuItem} onClick={() => { mergeScenes(sceneMultiSel); setMenu(null); }}>
                Merge {sceneMultiSel.length} scenes
              </button>
            )}
            <div className={s.menuSep} />
            <button className={s.menuItem} onClick={() => { duplicateScene(menu.idx); setMenu(null); }}>Duplicate scene</button>
            <button className={s.menuItem} data-danger onClick={() => { deleteScene(menu.idx); setMenu(null); }} disabled={doc.scenes.length <= 1}>Delete scene</button>
            {menu.idx > 0 && <button className={s.menuItem} onClick={() => { moveScene(menu.idx, menu.idx - 1); setMenu(null); }}>Move left</button>}
            {menu.idx < doc.scenes.length - 1 && <button className={s.menuItem} onClick={() => { moveScene(menu.idx, menu.idx + 1); setMenu(null); }}>Move right</button>}
          </ClampedMenu>
        </>
      )}
    </div>
  );
}

// ---- Scene 트랙 (최상위 계층 — Camera / Light 키프레임 lane) ----
// 씬 자체가 갖는 애니메이션(카메라, 라이트)을 요소 트랙과 같은 문법(속성 lane)
// 으로. 헤더/lane 클릭 = 선택 해제 -> Scene 인스펙터. 키프레임은 씬마다 독립
// (scene.camera / scene.light)이고 각 씬 오프셋만큼 밀어 한 lane 에 그린다.
const LIGHT_KF_COLOR = "#FDE047";

function ContinuousCameraTrack({
  doc,
  starts,
  pxPerFrame,
  totalW,
}: {
  doc: NonNullable<ReturnType<typeof useEditor.getState>["doc"]>;
  starts: number[];
  pxPerFrame: number;
  totalW: number;
}) {
  const selectedKf = useEditor((st) => st.ui.selectedKeyframe);
  const globalFrame = usePlayerFrame();
  // 재생헤드가 속한 씬 + 그 씬 로컬 프레임 (+ 버튼이 여기에 키를 찍는다).
  const cur = frameToScene(doc, FPS, Math.round(globalFrame));

  // --- 카메라 다이아 드래그 ---
  const dragRef = React.useRef<{ sceneIdx: number; kfIndex: number; startX: number; startFrame: number } | null>(null);
  const onDiamondDown = (e: React.PointerEvent, sceneIdx: number, kfIndex: number, frame: number) => {
    e.stopPropagation();
    // 요소 선택 해제 → Scene 인스펙터의 카메라 키프레임 편집기(Zoom/Move/Rotate)가 뜬다.
    useEditor.getState().clearSelection();
    // 다른 씬 다이아몬드면 그 씬으로 재생헤드 이동 → 인스펙터가 그 씬 카메라를 보이게.
    const off = starts[sceneIdx] ?? 0;
    const sF = sceneFrames(doc.scenes[sceneIdx], FPS);
    if (globalFrame < off || globalFrame >= off + sF) seekTo(off);
    selectKeyframe(sceneIdx, kfIndex);
    dragRef.current = { sceneIdx, kfIndex, startX: e.clientX, startFrame: frame };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const df = (e.clientX - d.startX) / pxPerFrame;
    const sF = sceneFrames(doc.scenes[d.sceneIdx], FPS);
    moveCameraKeyframe(d.sceneIdx, d.kfIndex, Math.max(0, Math.min(sF, d.startFrame + df)), true);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const df = (e.clientX - d.startX) / pxPerFrame;
    const sF = sceneFrames(doc.scenes[d.sceneIdx], FPS);
    moveCameraKeyframe(d.sceneIdx, d.kfIndex, Math.max(0, Math.min(sF, d.startFrame + df)), false);
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // --- 라이트 다이아 드래그 (카메라 미러) ---
  const lightDragRef = React.useRef<{ sceneIdx: number; kfIndex: number; startX: number; startFrame: number } | null>(null);
  const onLightDown = (e: React.PointerEvent, sceneIdx: number, kfIndex: number, frame: number) => {
    e.stopPropagation();
    useEditor.getState().clearSelection(); // Scene 인스펙터의 Light 섹션으로
    const off = starts[sceneIdx] ?? 0;
    const sF = sceneFrames(doc.scenes[sceneIdx], FPS);
    if (globalFrame < off || globalFrame >= off + sF) seekTo(off);
    lightDragRef.current = { sceneIdx, kfIndex, startX: e.clientX, startFrame: frame };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onLightMove = (e: React.PointerEvent) => {
    const d = lightDragRef.current;
    if (!d) return;
    const df = (e.clientX - d.startX) / pxPerFrame;
    const sF = sceneFrames(doc.scenes[d.sceneIdx], FPS);
    moveLightKeyframe(d.sceneIdx, d.kfIndex, Math.max(0, Math.min(sF, d.startFrame + df)), true);
  };
  const onLightUp = (e: React.PointerEvent) => {
    const d = lightDragRef.current;
    if (!d) return;
    const df = (e.clientX - d.startX) / pxPerFrame;
    const sF = sceneFrames(doc.scenes[d.sceneIdx], FPS);
    moveLightKeyframe(d.sceneIdx, d.kfIndex, Math.max(0, Math.min(sF, d.startFrame + df)), false);
    lightDragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  const anyKf = doc.scenes.some(
    (sc) => sc.camera?.type === "keyframes" && getKeyframes(sc).length > 0,
  );
  const anyLightKf = doc.scenes.some((sc) => getLightKeyframes(sc).length > 0);
  const curLightOn = !!doc.scenes[cur.sceneIdx]?.light;
  // Scene/lane 클릭 = 씬 선택 (선택 해제 -> Scene 인스펙터가 현 씬을 보여줌)
  const selectScene = () => useEditor.getState().clearSelection();

  return (
    <>
      {/* Scene 헤더 — 최상위 계층. 클릭 = 현 시점 씬 선택 */}
      <div className={s.row} data-camera="true" onClick={selectScene} style={{ cursor: "pointer" }}>
        <div className={s.gutterCell} style={{ paddingLeft: 10 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}><rect x="1.5" y="2.5" width="9" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M1.5 4.8h9M4.2 2.5v7M7.8 2.5v7" stroke="currentColor" strokeWidth="0.8" /></svg>
          <span className={s.rowLabel}>Scene</span>
        </div>
        <div className={s.trackCell} style={{ width: totalW }} />
      </div>

      {/* Camera lane */}
      <div className={s.row} data-camera="true" data-kfchannel="true" onClick={selectScene}>
        <div className={s.gutterCell} style={{ paddingLeft: 16 }}>
          <span className={s.kfBranch} />
          <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}><path d="M2 4.5l2-1.5 3 1.5 3-1.5v6l-3 1.5-3-1.5-2 1.5z" stroke="currentColor" strokeWidth="1" fill="none" strokeLinejoin="round" /></svg>
          <span className={s.rowLabel}>Camera</span>
          <button
            className={s.kfAdd}
            title="Add camera keyframe at playhead"
            onClick={(e) => { e.stopPropagation(); useEditor.getState().clearSelection(); const idx = addCameraKeyframeAt(cur.sceneIdx, cur.localFrame); if (idx >= 0) selectKeyframe(cur.sceneIdx, idx); }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2l2.5 4L6 10 3.5 6z" fill="currentColor" /><path d="M6 1v1.5M6 9.5V11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className={s.trackCell} style={{ width: totalW }} onPointerMove={onMove} onPointerUp={onUp}>
          <div className={s.kfLane} style={{ width: totalW }}>
            {doc.scenes.map((sc, si) => {
              const kfs = getKeyframes(sc);
              if (sc.camera?.type !== "keyframes" || kfs.length === 0) return null;
              const off = starts[si] ?? 0;
              return (
                <React.Fragment key={si}>
                  {kfs.length > 1 && (
                    <div
                      className={s.kfLine}
                      style={{ left: (off + kfs[0].frame) * pxPerFrame, width: (kfs[kfs.length - 1].frame - kfs[0].frame) * pxPerFrame }}
                    />
                  )}
                  {kfs.map((k, i) => {
                    const sel = selectedKf?.sceneIdx === si && selectedKf.kfIndex === i;
                    return (
                      <div
                        key={i}
                        className={s.kfDiamond}
                        data-selected={sel}
                        style={{ left: (off + k.frame) * pxPerFrame }}
                        onPointerDown={(e) => onDiamondDown(e, si, i, k.frame)}
                        onDoubleClick={(e) => { e.stopPropagation(); deleteCameraKeyframe(si, i); }}
                        title={`${sc.id ?? `Scene ${si + 1}`} · f${k.frame} · scale ${(k.scale ?? 1).toFixed(2)} (double-click to delete)`}
                      />
                    );
                  })}
                </React.Fragment>
              );
            })}
            {!anyKf && (
              <span className={s.kfHint}>Add a camera keyframe with + (zoom, move, rotate per frame)</span>
            )}
          </div>
        </div>
      </div>

      {/* Light lane */}
      <div className={s.row} data-camera="true" data-kfchannel="true" onClick={selectScene}>
        <div className={s.gutterCell} style={{ paddingLeft: 16 }}>
          <span className={s.kfBranch} />
          <svg width="12" height="12" viewBox="0 0 12 12" className={s.glyph}><circle cx="6" cy="5" r="2.6" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M6 0.8v1M6 8.2v1M1.8 5h1M9.2 5h1M3 2l0.7 0.7M9 2l-0.7 0.7" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
          <span className={s.rowLabel}>Light</span>
          <button
            className={s.kfAdd}
            disabled={!curLightOn}
            title={curLightOn ? "Add light keyframe at playhead" : "Enable Light in the Scene panel first"}
            onClick={(e) => { e.stopPropagation(); useEditor.getState().clearSelection(); addLightKeyframeAt(cur.sceneIdx, cur.localFrame); }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2l2.5 4L6 10 3.5 6z" fill="currentColor" /><path d="M6 1v1.5M6 9.5V11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className={s.trackCell} style={{ width: totalW }} onPointerMove={onLightMove} onPointerUp={onLightUp}>
          <div className={s.kfLane} style={{ width: totalW }}>
            {/* on-구간 밴드 — 라이트가 켜져 있는 시간 창 (씬별) */}
            {doc.scenes.map((sc, si) => {
              if (!sc.light) return null;
              const off = starts[si] ?? 0;
              const sF = sceneFrames(sc, FPS);
              return lightOnSegments(sc).map((seg, gi) => (
                <div
                  key={`${si}-${gi}`}
                  className={s.kfLaneClip}
                  style={{ left: (off + seg.start) * pxPerFrame, width: Math.max(0, ((seg.end ?? sF) - seg.start)) * pxPerFrame, background: "rgba(253, 224, 71, 0.10)" }}
                />
              ));
            })}
            {doc.scenes.map((sc, si) => {
              const kfs = getLightKeyframes(sc);
              if (kfs.length === 0) return null;
              const off = starts[si] ?? 0;
              return (
                <React.Fragment key={si}>
                  {kfs.length > 1 && (
                    <div
                      className={s.kfLine}
                      style={{ left: (off + kfs[0].frame) * pxPerFrame, width: (kfs[kfs.length - 1].frame - kfs[0].frame) * pxPerFrame, background: LIGHT_KF_COLOR }}
                    />
                  )}
                  {kfs.map((k, i) => (
                    <div
                      key={i}
                      className={s.kfDiamond}
                      style={{ left: (off + k.frame) * pxPerFrame, background: LIGHT_KF_COLOR }}
                      onPointerDown={(e) => onLightDown(e, si, i, k.frame)}
                      onDoubleClick={(e) => { e.stopPropagation(); deleteLightKeyframe(si, i); }}
                      title={`${sc.id ?? `Scene ${si + 1}`} · f${k.frame} · light (double-click to delete)`}
                    />
                  ))}
                </React.Fragment>
              );
            })}
            {!anyLightKf && (
              <span className={s.kfHint}>{curLightOn ? "Add a light keyframe with + (position, intensity per frame)" : "Enable Light in the Scene panel to animate it"}</span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---- 키프레임 다이아몬드 lane (요소용 — 카메라 lane 을 요소/채널로 복제) ----
// 요소 행 요약(summary=true, 절대 overlay) + 채널 서브행(summary=false) 공용.
// entries 는 {kf, index(원배열), channel} — 채널색 다이아몬드 + 채널별 연결선.
function KfDiamondLane({
  path,
  entries,
  pxPerFrame,
  sceneF,
  barW,
  frameOffset = 0,
  summary,
}: {
  path: ElementPath;
  entries: { kf: ElementKeyframe; index: number; channel: KfChannel }[];
  pxPerFrame: number;
  sceneF: number;
  barW: number;
  frameOffset?: number; // 전역 위치 오프셋(씬 시작 프레임). 렌더 left 에만 더한다.
  summary?: boolean;
}) {
  const selectedKf = useEditor((st) => st.ui.selectedElKeyframe);
  const multiSel = useEditor((st) => st.ui.kfMultiSel);

  // AE 다중 키 드래그: shift 클릭 = 선택 토글(요소 넘나들며 누적), 일반
  // pointerdown = (선택 안이면 선택 전체 / 밖이면 그 키만) 통째 드래그.
  const dragRef = React.useRef<{ entries: { path: ElementPath; kfIndex: number; frame0: number }[]; startX: number } | null>(null);
  const onDiamondDown = (e: React.PointerEvent, channel: KfChannel, kfIndex: number, frame: number) => {
    e.stopPropagation();
    const st = useEditor.getState();
    const cur = st.ui.kfMultiSel;
    const inSel = cur.some((en) => en.path === path && en.kfIndex === kfIndex);
    if (e.shiftKey) {
      const sel = inSel
        ? cur.filter((en) => !(en.path === path && en.kfIndex === kfIndex))
        : [...cur, { path, kfIndex }];
      useEditor.setState((s2) => ({ ui: { ...s2.ui, kfMultiSel: sel } }));
      selectElementKeyframe(path, channel, kfIndex);
      return; // shift 클릭은 선택만 — 이동은 선택된 키를 일반 드래그로
    }
    const sel = inSel && cur.length > 1 ? cur : [{ path, kfIndex }];
    useEditor.setState((s2) => ({ ui: { ...s2.ui, kfMultiSel: sel } }));
    selectElementKeyframe(path, channel, kfIndex);
    const doc0 = st.doc;
    const entries = sel.map((en) => {
      const el = doc0 ? (getElement(doc0, en.path) as { keyframes?: { frame: number }[] } | null) : null;
      return { path: en.path, kfIndex: en.kfIndex, frame0: el?.keyframes?.[en.kfIndex]?.frame ?? frame };
    });
    dragRef.current = { entries, startX: e.clientX };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // 전체가 0 밑으로 안 내려가게 df 를 최소 frame0 로 제한 (간격 유지)
    const minF0 = Math.min(...d.entries.map((en) => en.frame0));
    const df = Math.max(-minF0, Math.min(sceneF, (e.clientX - d.startX) / pxPerFrame));
    moveElementKeyframesBulk(d.entries, df, true);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const minF0 = Math.min(...d.entries.map((en) => en.frame0));
    const df = Math.max(-minF0, Math.min(sceneF, (e.clientX - d.startX) / pxPerFrame));
    moveElementKeyframesBulk(d.entries, df, false);
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  // 다이아 우클릭 — 삭제 메뉴 (다중 선택이면 선택 전체 삭제)
  const [kfMenu, setKfMenu] = React.useState<{ x: number; y: number; kfIndex: number } | null>(null);

  // 채널별 연결선 (첫~마지막 키). summary 면 채널마다 한 줄.
  const lines: { channel: KfChannel; x0: number; x1: number }[] = [];
  for (const c of KF_CHANNELS) {
    const ce = entries.filter((en) => en.channel === c);
    if (ce.length > 1) {
      const fs = ce.map((en) => en.kf.frame);
      lines.push({ channel: c, x0: Math.min(...fs), x1: Math.max(...fs) });
    }
  }

  // 빈 lane 더블클릭 → 그 프레임에 키 추가 (REC 불필요). 다이아몬드 더블클릭(삭제)은
  // stopPropagation 이라 여기 안 온다. summary lane 은 pointer-events:none 이라
  // 채널 서브행(단일 채널)에서만 동작.
  const onLaneDoubleClick = (e: React.MouseEvent) => {
    if (summary) return;
    const chan = entries[0]?.channel;
    if (!chan) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frame = Math.max(0, Math.min(sceneF, Math.round((e.clientX - rect.left) / pxPerFrame - frameOffset)));
    const idx = addElementKeyframeAt(path, chan, frame);
    if (idx >= 0) selectElementKeyframe(path, chan, idx);
  };

  return (
    <div
      className={summary ? `${s.kfLane} ${s.kfLaneSummary}` : s.kfLane}
      style={{ width: barW }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={onLaneDoubleClick}
    >
      {lines.map((ln) => (
        <div
          key={ln.channel}
          className={s.kfLine}
          style={{ left: (ln.x0 + frameOffset) * pxPerFrame, width: (ln.x1 - ln.x0) * pxPerFrame, background: CHANNEL_META[ln.channel].color }}
        />
      ))}
      {entries.map((en) => {
        const sel =
          (selectedKf?.path === path && selectedKf.channel === en.channel && selectedKf.kfIndex === en.index) ||
          multiSel.some((m) => m.path === path && m.kfIndex === en.index);
        return (
          <div
            key={`${en.channel}:${en.index}`}
            className={s.kfDiamond}
            data-selected={sel}
            style={{ left: (en.kf.frame + frameOffset) * pxPerFrame, background: CHANNEL_META[en.channel].color }}
            onPointerDown={(e) => onDiamondDown(e, en.channel, en.index, en.kf.frame)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => {
              e.stopPropagation();
              deleteElementKeyframe(path, en.index);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setKfMenu({ x: e.clientX, y: e.clientY, kfIndex: en.index });
            }}
            title={`${CHANNEL_META[en.channel].label} · f${en.kf.frame} = ${en.kf[en.channel]} (double-click to delete)`}
          />
        );
      })}
      {kfMenu && (
        <>
          <div className={s.menuBackdrop} onClick={() => setKfMenu(null)} onContextMenu={(e) => { e.preventDefault(); setKfMenu(null); }} />
          <ClampedMenu x={kfMenu.x} y={kfMenu.y}>
            {(() => {
              const inSel = multiSel.some((m) => m.path === path && m.kfIndex === kfMenu.kfIndex);
              const many = inSel && multiSel.length > 1;
              return (
                <button
                  className={s.menuItem}
                  data-danger
                  onClick={() => {
                    if (many) deleteElementKeyframesBulk(multiSel);
                    else deleteElementKeyframe(path, kfMenu.kfIndex);
                    setKfMenu(null);
                  }}
                >
                  {many ? `Delete ${multiSel.length} keyframes` : "Delete keyframe"}
                </button>
              );
            })()}
          </ClampedMenu>
        </>
      )}
    </div>
  );
}

// ---- 요소 행 ----
function ElementRow({
  path,
  el,
  label,
  kind,
  depth,
  selected,
  hovered,
  phases,
  layers,
  pxPerFrame,
  sceneF,
  sceneIdx,
  frameOffset,
  totalW,
  onRowDragDown,
  onRowDragMove,
  onRowDragUp,
  clickGuardRef,
  dropSpot,
}: {
  path: ElementPath;
  el: SceneElementSpec;
  label: string;
  kind: string;
  depth: number;
  selected: boolean;
  hovered: boolean;
  phases: { winStart: number; winEnd: number; enterEnd: number; exitStart: number; total: number } | null;
  layers: ReturnType<typeof elementTimings>;
  pxPerFrame: number;
  sceneF: number;
  sceneIdx: number;
  frameOffset: number; // 씬 시작 프레임 = 전역 위치 오프셋. 렌더 left 에만 더한다.
  totalW: number; // 트랙셀 폭(전체 영상) — 행이 전 구간을 덮게.
  onRowDragDown: (e: React.PointerEvent, path: ElementPath) => void;
  onRowDragMove: (e: React.PointerEvent) => void;
  onRowDragUp: (e: React.PointerEvent) => void;
  clickGuardRef: React.MutableRefObject<boolean>;
  dropSpot: TlDropSpot | null;
}) {
  const select = useEditor((st) => st.select);
  const toggleSelect = useEditor((st) => st.toggleSelect);
  const setHovered = useEditor((st) => st.setHovered);
  const expanded = useEditor((st) => !!st.ui.expandedKfRows[path]);
  const setUI = useEditor((st) => st.setUI);
  // AE "U" 관습 — 펼침 시 기본은 "키 걸린 속성만". 토글로 전 속성 노출(arm 가능).
  const [showAllProps, setShowAllProps] = React.useState(false);

  // 다른 씬 요소면 그 씬으로 재생헤드 이동 → ScenePlayheadSync 가 activeScene 갱신
  // (캔버스가 그 씬을 보이게). 같은 씬이면 재생헤드 안 건드림.
  const followScene = () => {
    const gf = getPlayer()?.getCurrentFrame() ?? 0;
    if (gf < frameOffset || gf >= frameOffset + sceneF) seekTo(frameOffset);
  };

  const onClick = (e: React.MouseEvent) => {
    // 드래그 직후 따라오는 click 은 선택 이동 방지 (reparent 드래그 후 클릭 삼킴)
    if (clickGuardRef.current) return;
    if (e.shiftKey) {
      toggleSelect(path); // 다중 선택 빌드 중엔 재생헤드 안 건드림
      return;
    }
    select([path]);
    // 다른 씬의 요소면 그 씬 시작점으로 이동. 이미 그 씬 안에 있으면 재생헤드
    // 유지 — 키프레임 작업 중 세팅해 둔 위치가 튀지 않게 (사용자 UX 결정).
    followScene();
  };

  // 우클릭 컨텍스트 메뉴 (컷 편집).
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    followScene();
    // 이미 다중 선택 안에 있는 행을 우클릭하면 선택 유지(AE 처럼 여러 대상에
    // "Paste animation" 적용 가능). 선택 밖 행이면 그 행만 선택.
    if (!useEditor.getState().selection.includes(path)) select([path]);
    setMenu({ x: e.clientX, y: e.clientY });
  };

  // cross-scene 연장: 바 폭은 씬 길이와 winEnd(overflow 허용) 중 큰 쪽 —
  // 다음 씬으로 늘린 요소가 시각적으로도 경계 너머까지 그려진다.
  const barW = Math.max(sceneF, phases?.winEnd ?? sceneF) * pxPerFrame;
  const offPx = frameOffset * pxPerFrame; // 씬 오프셋(px)

  // 요소별 사용 가능 채널(경로 유무/그룹 여부)은 한 곳에서 판정.
  const isGroup = kind === "group";
  const hasKf = getElementKeyframes(el).length > 0;
  const usable = channelsForElement(el as Parameters<typeof channelsForElement>[0]);
  const channelsWithKeys = usable.filter((c) => channelKeys(el, c).length > 0);
  // 요약(collapsed) 다이아몬드 — 모든 채널 병합.
  const summaryEntries = channelsWithKeys.flatMap((c) =>
    channelKeys(el, c).map(({ kf, index }) => ({ kf, index, channel: c })),
  );
  // 펼침 가능 = 키프레임 가능한 채널이 하나라도 있는 요소면 항상 (AE 처럼
  // 모든 속성을 스톱워치로 켤 수 있게). group 은 usable 이 transform 뿐.
  const showDisclosure = usable.length > 0;

  // 재생헤드의 씬-로컬 프레임 (클릭 시점에만 필요 → 매 프레임 리렌더 방지 위해 lazy).
  const localFrameNow = () => {
    const gf = getPlayer()?.getCurrentFrame() ?? 0;
    return Math.max(0, Math.min(sceneF, Math.round(gf - frameOffset)));
  };

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cur = useEditor.getState().ui.expandedKfRows;
    setUI({ expandedKfRows: { ...cur, [path]: !cur[path] } });
  };

  // 트림(클립 in/out) 드래그 — 바 끝을 끌어 요소 등장/퇴장 시점 조절(비압축).
  // 다중 선택이면 선택 전체의 같은 엣지를 동시에 민다. start 트림은 키프레임
  // 동행 (trimElementsBy 가 스냅샷 기반으로 처리 — 이중 이동 없음).
  const trimRef = React.useRef<{ edge: "start" | "end"; startX: number; extra: number; targets: TrimTarget[]; bounds: number[]; primary0: number } | null>(null);
  const trimScroller = React.useRef(edgeScrollController()).current;
  const applyTrim = (clientX: number, live: boolean) => {
    const d = trimRef.current;
    if (!d) return;
    let df = (clientX - d.startX + d.extra) / pxPerFrame;
    // 씬 경계 스냅 (end 드래그) — 주 대상 기준 8px 안이면 경계에 자석
    if (d.edge === "end") {
      const raw = d.primary0 + df;
      for (const b of d.bounds) {
        if (Math.abs(raw - b) * pxPerFrame < 8) {
          df = b - d.primary0;
          break;
        }
      }
    }
    trimElementsBy(d.targets, d.edge, df, live);
  };
  const onTrimDown = (e: React.PointerEvent, edge: "start" | "end") => {
    e.stopPropagation();
    if (!phases) return;
    const st = useEditor.getState();
    const doc0 = st.doc;
    if (!doc0) return;
    // 이 요소가 다중 선택 안이면 선택 전체(그룹 제외)에 동시 적용
    const paths = st.selection.includes(path) && st.selection.length > 1 ? st.selection : [path];
    const targets = paths
      .map((p) => trimTargetOf(doc0, p, edge))
      .filter((t): t is TrimTarget => !!t);
    if (targets.length === 0) return;
    // 씬 경계(홈 씬 로컬 프레임) — 홈 씬 끝, 그다음 씬 끝... (cross-scene 스냅)
    const homeIdx = parsePath(path).sceneIdx;
    const bounds: number[] = [];
    let accB = 0;
    for (let bi = homeIdx; bi < doc0.scenes.length; bi++) {
      accB += sceneFrames(doc0.scenes[bi], FPS);
      bounds.push(accB);
    }
    const primary = targets.find((t) => t.path === path) ?? targets[0];
    trimRef.current = { edge, startX: e.clientX, extra: 0, targets, bounds, primary0: primary.edge0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTrimMove = (e: React.PointerEvent) => {
    const d = trimRef.current;
    if (!d) return;
    applyTrim(e.clientX, true);
    const scrollEl = findScrollArea(e.currentTarget as HTMLElement);
    if (scrollEl) {
      const cx = e.clientX;
      trimScroller.update(scrollEl, cx, (v) => {
        const dd = trimRef.current;
        if (!dd) return;
        dd.extra += v;
        applyTrim(cx, true);
      });
    }
  };
  const onTrimUp = (e: React.PointerEvent) => {
    const d = trimRef.current;
    if (!d) return;
    applyTrim(e.clientX, false);
    trimRef.current = null;
    trimScroller.stop();
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <>
      <div
        className={s.row}
        data-eltrack="true"
        data-expanded={expanded}
        data-tlpath={path}
        data-selected={selected}
        data-hovered={hovered}
        data-dropinto={dropSpot?.kind === "into" && dropSpot.container === path}
        onMouseEnter={() => setHovered(path)}
        onMouseLeave={() => setHovered(null)}
        onContextMenu={onContextMenu}
        data-tlrow={path}
      >
        {/* line 드롭 인디케이터 (형제 재정렬) — 이 행의 위/아래 가장자리 */}
        {dropSpot?.kind === "line" && dropSpot.rowPath === path && (
          <div className={s.tlDropLine} data-edge={dropSpot.edge} style={{ left: dropSpot.indent }} />
        )}
        {/* 거터 = 드래그 소스. 클릭=선택, 임계치 넘으면 계층 이동 드래그. */}
        <div
          className={s.gutterCell}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={onClick}
          onPointerDown={(e) => onRowDragDown(e, path)}
          onPointerMove={onRowDragMove}
          onPointerUp={onRowDragUp}
        >
          <span className={s.kfDisclosureSlot}>
            {showDisclosure && (
              <button
                className={s.kfDisclosure}
                data-open={expanded}
                onClick={toggleExpand}
                onPointerDown={(e) => e.stopPropagation()}
                title={expanded ? "Collapse keyframe lanes" : "Expand keyframe lanes"}
              >
                {expanded ? "▾" : "▸"}
              </button>
            )}
          </span>
          <TypeGlyph kind={kind} />
          <span className={s.rowLabel}>{label}</span>
        </div>
        <div
          className={s.trackCell}
          style={{ width: totalW }}
          onClick={onClick}
          onPointerMove={onTrimMove}
          onPointerUp={onTrimUp}
          // 더블클릭 = 그 프레임에 키프레임 (REC 불필요).
          // 키 있는 채널 전부에 추가, 키가 아예 없으면 X/Y 를 arm 해 위치 애니 시작.
          onDoubleClick={(e) => {
            if (isGroup) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const frame = Math.max(0, Math.min(sceneF, Math.round((e.clientX - rect.left) / pxPerFrame - frameOffset)));
            if (channelsWithKeys.length > 0) {
              for (const c of channelsWithKeys) addElementKeyframeAt(path, c, frame);
            } else {
              armChannel(path, "x", frame);
              armChannel(path, "y", frame);
            }
          }}
        >
          {phases ? (
            <>
              <div className={s.phaseBar} style={{ width: barW, marginLeft: offPx }}>
                {/* enter */}
                {phases.enterEnd > phases.winStart && (
                  <div className={s.segIn} style={{ left: phases.winStart * pxPerFrame, width: (phases.enterEnd - phases.winStart) * pxPerFrame }} />
                )}
                {/* hold */}
                <div className={s.segHold} style={{ left: phases.enterEnd * pxPerFrame, width: Math.max(0, (phases.exitStart - phases.enterEnd) * pxPerFrame) }} />
                {/* exit */}
                {phases.exitStart < phases.winEnd && (
                  <div className={s.segOut} style={{ left: phases.exitStart * pxPerFrame, width: (phases.winEnd - phases.exitStart) * pxPerFrame }} />
                )}
                {/* 레이어 칩 */}
                {layers.map((l, i) => (
                  <div
                    key={i}
                    className={s.layerChip}
                    style={{
                      left: l.startFrame * pxPerFrame,
                      width: Math.max(2, l.window * pxPerFrame),
                      background: ROLE_COLOR[l.role] ?? "var(--role-hold)",
                    }}
                    title={`${l.type} · ${l.role} · ${Math.round(l.startFrame)}-${Math.round(l.startFrame + l.window)}f`}
                  />
                ))}
              </div>
              {/* 트림 핸들 (좌=in-point, 우=out-point). 끌면 등장/퇴장 시점 조절(비압축). */}
              <div className={s.trimHandle} style={{ left: (phases.winStart + frameOffset) * pxPerFrame }} onPointerDown={(e) => onTrimDown(e, "start")} onClick={(e) => e.stopPropagation()} title="Trim in — drag to set when it appears" />
              <div className={s.trimHandle} style={{ left: (phases.winEnd + frameOffset) * pxPerFrame }} onPointerDown={(e) => onTrimDown(e, "end")} onClick={(e) => e.stopPropagation()} title="Trim out — drag to set when it disappears" />
            </>
          ) : (
            <div className={s.groupBar} style={{ width: barW, marginLeft: offPx }} />
          )}
          {/* 접힌 요약 — 모든 채널 다이아몬드를 한 lane 에 (절대 overlay). */}
          {!expanded && summaryEntries.length > 0 && (
            <KfDiamondLane
              path={path}
              entries={summaryEntries}
              pxPerFrame={pxPerFrame}
              sceneF={sceneF}
              barW={totalW}
              frameOffset={frameOffset}
              summary
            />
          )}
        </div>
      </div>

      {/* 펼침 — AE 식 속성별 lane. 키가 있든 없든 usable 채널 전부 나열하고,
          각 행에 스톱워치(arm/disarm) + 키 추가. armed(키 있음)면 색 dot + 다이아
          몬드, 아니면 회색 hollow. 레이어(칩/자식 행)와 헷갈리지 않게 data-kfchannel
          로 들여쓴 "속성 레인" 스타일(연결선 + 인셋 배경)로 구분. */}
      {expanded && (
        <div className={s.kfSection} data-kfsection="true">
          {/* AE U 관습: 기본은 키 걸린 속성만, 토글로 전 속성. */}
          <div className={s.kfSectionHead}>
            <div className={s.gutterCell} style={{ paddingLeft: 10 + (depth + 1) * 12 }}>
              <span className={s.kfBranch} data-head="true" />
              <button
                className={s.kfPropToggle}
                onClick={(e) => { e.stopPropagation(); setShowAllProps((v) => !v); }}
                title={showAllProps ? "Show only keyframed properties" : "Show all animatable properties (stopwatch to keyframe)"}
              >
                {showAllProps ? "◂ Keyed only" : "All properties ▸"}
              </button>
            </div>
            <div className={s.trackCell} style={{ width: totalW }} />
          </div>
          {!showAllProps && channelsWithKeys.length === 0 && (
            <div className={s.kfSectionHint} style={{ paddingLeft: 10 + (depth + 2) * 12 }}>
              No keyframes yet — use “All properties” and a stopwatch to start.
            </div>
          )}
          {(showAllProps ? usable : channelsWithKeys).map((c) => {
            const armed = isChannelArmed(el, c);
            const entries = channelKeys(el, c).map(({ kf, index }) => ({ kf, index, channel: c }));
            return (
              <div
                key={c}
                className={s.row}
                data-kfchannel="true"
                data-armed={armed}
                // 속성 lane 클릭 = 요소 선택 (캔버스 동기) + 다른 씬이면 그 씬
                // 시작점으로 (이미 그 씬이면 재생헤드 유지 — 작업 위치 보존)
                onClick={() => { useEditor.getState().select([path]); followScene(); }}
              >
                <div className={s.gutterCell} style={{ paddingLeft: 10 + (depth + 1) * 12 }}>
                  {/* 트리 커넥터 — 부모 요소 행에서 내려오는 스레드 (소속 표시) */}
                  <span className={s.kfBranch} />
                  {/* 스톱워치 — 켜기: 현재 프레임에 첫 키 생성 / 끄기: 이 채널 키 전부 삭제 */}
                  <button
                    className={s.kfStopwatch}
                    data-armed={armed}
                    title={armed ? `${CHANNEL_META[c].label}: keyframing on — click to remove all keys` : `${CHANNEL_META[c].label}: click to keyframe (stopwatch)`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      // 끄기 = 채널 키 전부 삭제(파괴적) — confirm 후 현재 값을 base 로 bake
                      if (armed) {
                        if (await uiConfirm(`Remove all ${CHANNEL_META[c].label} keyframes?`, { danger: true, okLabel: "Remove" })) disarmChannel(path, c, localFrameNow());
                      }
                      else {
                        const idx = armChannel(path, c, localFrameNow());
                        if (idx >= 0) selectElementKeyframe(path, c, idx);
                      }
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                      <circle cx="7" cy="8" r="4.2" stroke="currentColor" strokeWidth="1.2" fill={armed ? "currentColor" : "none"} />
                      <path d="M7 8V5.4M5.5 2.2h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </button>
                  <span className={s.kfChannelDot} style={{ background: armed ? CHANNEL_META[c].color : "var(--text-4)" }} />
                  <span className={s.rowLabel} data-dim={!armed}>{CHANNEL_META[c].label}</span>
                  <button
                    className={s.kfAdd}
                    title={`Add ${CHANNEL_META[c].label} keyframe at playhead`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const idx = addElementKeyframeAt(path, c, localFrameNow());
                      if (idx >= 0) selectElementKeyframe(path, c, idx);
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2l2.5 4L6 10 3.5 6z" fill="currentColor" /><path d="M6 1v1.5M6 9.5V11" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></svg>
                  </button>
                </div>
                <div className={s.trackCell} style={{ width: totalW }}>
                  {/* 부모 클립 구간 밴드 — 이 lane 의 키가 "그 요소의 시간 창" 위에
                      있음을 보여주는 AE 식 소속 큐 */}
                  {phases && (
                    <div
                      className={s.kfLaneClip}
                      style={{ left: (phases.winStart + frameOffset) * pxPerFrame, width: Math.max(0, (phases.winEnd - phases.winStart) * pxPerFrame) }}
                    />
                  )}
                  {entries.length > 0 && (
                    <KfDiamondLane
                      path={path}
                      entries={entries}
                      pxPerFrame={pxPerFrame}
                      sceneF={sceneF}
                      barW={totalW}
                      frameOffset={frameOffset}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 우클릭 컷 편집 메뉴 */}
      {menu && (
        <>
          <div className={s.menuBackdrop} onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <ClampedMenu x={menu.x} y={menu.y}>
            {!isGroup && (
              <>
                <button className={s.menuItem} onClick={() => { splitElementAtPlayhead(path, localFrameNow()); setMenu(null); }}>Split at playhead <span className={s.menuKey}>S</span></button>
                <button className={s.menuItem} onClick={() => { trimElementTo(path, "start", localFrameNow()); setMenu(null); }}>Trim in to playhead <span className={s.menuKey}>[</span></button>
                <button className={s.menuItem} onClick={() => { trimElementTo(path, "end", localFrameNow()); setMenu(null); }}>Trim out to playhead <span className={s.menuKey}>]</span></button>
              </>
            )}
            <div className={s.menuSep} />
            {/* 애니메이션 복사 → 여러 요소에 시차(stagger) 붙여넣기 (AE 워크플로우) */}
            <button className={s.menuItem} onClick={() => { copyElementAnimation(path); setMenu(null); }}>Copy animation</button>
            <button
              className={s.menuItem}
              disabled={!hasAnimClipboard()}
              onClick={async () => {
                setMenu(null);
                const st = useEditor.getState();
                const targets = st.selection.includes(path) ? st.selection : [path];
                if (targets.length > 1) {
                  const v = await uiPrompt("Paste animation with stagger", "4", { message: "Frames of offset per element (0 = same timing)", placeholder: "4" });
                  if (v === null) return;
                  pasteElementAnimation(targets, Math.max(0, parseInt(v, 10) || 0));
                } else {
                  pasteElementAnimation(targets, 0);
                }
              }}
            >
              Paste animation{useEditor.getState().selection.length > 1 ? " (stagger)…" : ""}
            </button>
            <div className={s.menuSep} />
            <button className={s.menuItem} onClick={() => { duplicateElements([path]); setMenu(null); }}>Duplicate <span className={s.menuKey}>⌘D</span></button>
            <button className={s.menuItem} data-danger onClick={() => { deleteElements([path]); setMenu(null); }}>Delete <span className={s.menuKey}>⌫</span></button>
          </ClampedMenu>
        </>
      )}
    </>
  );
}

// ---- 아이콘 ----
function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M4 2.5l7 4.5-7 4.5v-9z" fill="currentColor" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <rect x="3.5" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" />
      <rect x="8" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" />
    </svg>
  );
}
function SkipIcon({ dir }: { dir: "start" | "end" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" style={{ transform: dir === "end" ? "scaleX(-1)" : undefined }}>
      <path d="M4 3v8M11 3.5L5.5 7l5.5 3.5v-7z" stroke="currentColor" strokeWidth="1.3" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}
function BeatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14">
      <path d="M3 9l2-5 2 8 2-6 2 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
