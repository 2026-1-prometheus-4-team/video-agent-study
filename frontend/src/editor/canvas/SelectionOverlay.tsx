"use client";

// SelectionOverlay — 플레이어 위에 얹는 셀렉션/조작 레이어. 엔진이 심어둔
// [data-scene]/[data-el] (display:contents) DOM 을 측정해 요소별 박스를 만들고
// (union of 렌더된 자식 rect), 클릭/마퀴/이동/리사이즈/회전을 처리한다.
// 좌표 변환은 player.getScale() 로 css px <-> composition fraction.
//
// 조작(Figma 급):
//  - 이동: 드래그. shift=축 고정. alt+드래그=복제 후 이동.
//  - 리사이즈: 8핸들(도형) / 4코너(텍스트·로고 균일 스케일). shift 또는 K=비율 고정.
//    alt=중앙 기준.
//  - 회전: 코너 바깥 히트존 드래그. shift=15도 스냅.
//  - 스마트 가이드: 이동/리사이즈 중 다른 요소·씬의 가장자리/중앙에 스냅(탁 멈춤) + 가이드선.
//  - Alt 거리 측정: 요소 선택 후 alt 를 누른 채 다른 요소에 호버하면 간격 표시.

import React from "react";
import { createPortal } from "react-dom";
import { useEditor } from "@/editor/store";
import { getPlayer, usePlayerFrame, pause } from "@/editor/playerBridge";
import {
  duplicateElements,
  deleteElements,
  groupElements,
  copyElements,
  pasteElements,
  frameSelection,
  reorderElements,
  reparentElement,
  frameBoxOf,
  addFrameAt,
  convertGroupToFrame,
  ensureGroupAnchor,
  detachPresetElement,
  copyElementStyle,
  pasteElementStyle,
  hasStyleClipboard,
} from "@/editor/mutations";
import { applyCameraDelta } from "@/editor/camera";
import { snapshotForScale, applyScaleDeep, type ScaleSnap } from "@/editor/mutations";
import { applyElementDelta, isChannelArmed, upsertChannelKey } from "@/editor/elementKeyframes";
import { sampleElementKeyframes } from "@engine/motion/keyframes";
import { sceneStarts, frameToScene } from "@/editor/timing";
import { FPS } from "@/engine/normalize";
import {
  flattenScene,
  getElement,
  hasChildren,
  isGroup,
  isDescendantOf,
  parsePath,
  parentPath,
  buildPath,
  elementLabel,
  type ElementPath,
} from "@/editor/specPath";
import { COMP_W, COMP_H } from "./PlayerCanvas";
import type { VideoSpec, SceneElementSpec } from "@engine/motion/SceneRenderer";
import { sampleCameraKeyframes } from "@engine/motion/SceneRenderer";
import s from "./canvas.module.css";

type Box = { x: number; y: number; w: number; h: number };
type Handle = "tl" | "tr" | "bl" | "br" | "t" | "r" | "b" | "l";

const SNAP_TH = 5; // css px — 스냅 임계
const MIN_BOX = 6; // css px — 최소 크기

// --- 텍스트 잉크 메트릭 (박스 보정용) ---
// DOM 라인박스는 폰트 잉크와 다르다: 위엔 어센트 여백이 남고(프레임 씌우면 패딩처럼
// 보임) 아래론 디센더가 라인박스 밖으로 삐져나온다(박스 밖 렌더). canvas
// measureText 의 actualBoundingBox 로 실제 잉크 상하를 재서 박스를 잉크에 맞춘다.
let inkCanvasCtx: CanvasRenderingContext2D | null = null;
const inkCache = new Map<string, { fbAsc: number; fbDesc: number; actAsc: number; actDesc: number } | null>();
function inkMetrics(text: string, family: string, weight: number) {
  const key = `${weight}|${family}|${text}`;
  if (inkCache.has(key)) return inkCache.get(key) ?? null;
  if (!inkCanvasCtx) inkCanvasCtx = document.createElement("canvas").getContext("2d");
  if (!inkCanvasCtx) return null;
  let v: { fbAsc: number; fbDesc: number; actAsc: number; actDesc: number } | null = null;
  try {
    inkCanvasCtx.font = `${weight} 100px ${family}`;
    const m = inkCanvasCtx.measureText(text);
    v = {
      fbAsc: (m.fontBoundingBoxAscent ?? 80) / 100,
      fbDesc: (m.fontBoundingBoxDescent ?? 20) / 100,
      actAsc: (m.actualBoundingBoxAscent ?? 80) / 100,
      actDesc: (m.actualBoundingBoxDescent ?? 0) / 100,
    };
  } catch {
    v = null;
  }
  if (inkCache.size > 500) inkCache.clear();
  inkCache.set(key, v);
  return v;
}

// root 의 "가장 가까운" [data-el] 자손들 (그 사이 다른 data-el 없음)
function childDataEls(root: Element): Element[] {
  const out: Element[] = [];
  const visit = (el: Element) => {
    for (const child of Array.from(el.children)) {
      // 곡면 클론 컨테이너는 스킵 — 안에 data-el 사본이 수백 개(측정은 고스트가 담당).
      if (child.hasAttribute("data-curveclones")) continue;
      if (child.hasAttribute("data-el")) out.push(child);
      else visit(child);
    }
  };
  visit(root);
  return out;
}

// data-el display:contents 노드의 렌더 박스 (자식 element rect union). 없으면 null.
function leafRect(node: Element): DOMRect | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  // 클론 서브트리(data-curveclones)는 통째로 건너뛴다 — 순회 비용 x 클론 수 방지.
  const kids: Element[] = [];
  const collect = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.hasAttribute("data-curveclones")) continue;
      // data-noboundsdeep: 서브트리째 측정 제외 (3D 캔버스 블리드 등 —
      // data-nobounds 는 "그 노드만" 제외라 캔버스 자식이 잡혀 박스가 비대해짐)
      if (child.hasAttribute("data-noboundsdeep")) continue;
      kids.push(child);
      collect(child);
    }
  };
  collect(node);
  const consider = (el: Element) => {
    // data-nobounds: 풀스크린 필터 컨테이너(gooey SVG 등)는 측정 제외 → 실제 그려진
    // 내용(원/패스)만 재서 선택 박스가 타이트해진다.
    if (el.hasAttribute("data-nobounds")) return;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return;
    x0 = Math.min(x0, r.left);
    y0 = Math.min(y0, r.top);
    x1 = Math.max(x1, r.right);
    y1 = Math.max(y1, r.bottom);
  };
  for (const el of Array.from(node.children)) consider(el);
  kids.forEach(consider);
  if (x0 === Infinity) return null;
  return new DOMRect(x0, y0, x1 - x0, y1 - y0);
}

function unionBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// 포인터 캡처 — 합성 이벤트/펜·터치 등 비활성 pointerId 면 throw 하므로 방어.
// (throw 가 새면 pointerup 의 리페어런트/coalescing 정리가 통째로 죽는다)
// 캡처 = 드래그 제스처 시작 — 드래그 동안의 모든 doc 쓰기(armed x/y 키가
// 번갈아 기록되는 경우 포함)를 undo 1건으로 병합한다. 짝은 onPointerUp 의
// endGesture (finally).
function capturePointer(el: Element, id: number) {
  useEditor.getState().beginGesture();
  try { el.setPointerCapture(id); } catch { /* 비활성 포인터 — 무시 */ }
}
function releasePointer(el: Element, id: number) {
  try { el.releasePointerCapture(id); } catch { /* 비활성 포인터 — 무시 */ }
}


// 활성 씬의 [data-scene] 노드 — pre/postmount 로 이웃 씬 DOM 이 같이 떠 있어
// first-match 가 활성 씬이라는 보장이 없다. 플레이헤드 프레임으로 인덱스를
// 계산해 attribute 가 일치하는 노드를 고른다.
function activeSceneNode(container: Element): Element | null {
  const nodes = Array.from(container.querySelectorAll("[data-scene]"));
  if (nodes.length <= 1) return nodes[0] ?? null;
  const doc = useEditor.getState().doc;
  if (!doc) return nodes[0];
  const f = Math.round(getPlayer()?.getCurrentFrame() ?? 0);
  const idx = frameToScene(doc, FPS, f).sceneIdx;
  return nodes.find((n) => Number(n.getAttribute("data-scene")) === idx) ?? nodes[0];
}

function boxContains(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}
function boxIntersects(a: Box, b: Box): boolean {
  return !(a.x > b.x + b.w || a.x + a.w < b.x || a.y > b.y + b.h || a.y + a.h < b.y);
}

// 리사이즈 시 "고정점"(anchor) — 드래그하는 핸들의 반대편.
function anchorPoint(b: Box, h: Handle, fromCenter: boolean): { x: number; y: number } {
  const cx = b.x + b.w / 2,
    cy = b.y + b.h / 2;
  if (fromCenter) return { x: cx, y: cy };
  const l = b.x,
    r = b.x + b.w,
    t = b.y,
    bo = b.y + b.h;
  switch (h) {
    case "tl": return { x: r, y: bo };
    case "tr": return { x: l, y: bo };
    case "bl": return { x: r, y: t };
    case "br": return { x: l, y: t };
    case "t": return { x: cx, y: bo };
    case "b": return { x: cx, y: t };
    case "l": return { x: r, y: cy };
    case "r": return { x: l, y: cy };
  }
}

// 선택 경로들에서 실제 위치를 갖는 leaf(text/logo/shape) 후보 수집.
// 기준 위치는 현재 프레임의 "시각 위치"(키프레임 sample ?? base.position) — 키프레임이
// 있으면 요소는 sample 위치에 그려지므로, base 를 기준으로 잡으면 드래그 순간 점프한다.
// 조상 frame 체인 합성 스케일 — frame 자식의 comp 델타 <-> 로컬 좌표 변환.
// move/resize 양쪽에서 사용 (감사 #1: 리사이즈가 comp fraction 을 그대로 써서
// frame 자식이 앵커 반대로 드리프트하던 것).
function ancestorFrameScale(doc: VideoSpec, path: ElementPath): { fx: number; fy: number } {
  let pp = parentPath(path);
  let w = 1;
  let h = 1;
  while (pp) {
    const pf = getElement(doc, pp);
    if (pf?.element === "frame") {
      const box = frameBoxOf(pf);
      w *= Math.max(0.01, box.w);
      h *= Math.max(0.01, box.h);
    }
    pp = parentPath(pp);
  }
  return { fx: 1 / w, fy: 1 / h };
}

type DragKind = "pos" | "layoutOrigin" | "pathOrigin";
function leafTargets(
  doc: VideoSpec,
  paths: ElementPath[],
  localFrame: number,
): { path: ElementPath; x: number; y: number; kind?: DragKind }[] {
  const out: { path: ElementPath; x: number; y: number; kind?: DragKind }[] = [];
  const seenOrigin = new Set<string>();
  const addLeaf = (p: ElementPath, el: SceneElementSpec) => {
    if (el.element === "group") return;
    // 경로가 붙은 요소: 화면 위치는 경로가 결정하므로 base.position 드래그는 무효.
    // AE 처럼 드래그 = 모션 패스 전체 이동(origin).
    const mp = (el as { motionPath?: { origin?: { x: number; y: number } } }).motionPath;
    if (mp) {
      out.push({ path: p, x: (mp.origin?.x ?? 0) / 100, y: (mp.origin?.y ?? 0) / 100, kind: "pathOrigin" });
      return;
    }
    // 경로/궤도 배치 그룹의 자식: 개별 position 이 무효(경로가 위치 결정) —
    // 드래그를 부모 그룹의 배치 경로 origin 이동으로 승격.
    const pp = parentPath(p);
    if (pp) {
      const pe = getElement(doc, pp);
      const gl = (pe as { layout?: { type?: string; origin?: { x: number; y: number } } } | null)?.layout;
      if (pe?.element === "group" && gl && (gl.type === "path" || gl.type === "orbit")) {
        if (!seenOrigin.has(pp)) {
          seenOrigin.add(pp);
          out.push({ path: pp, x: (gl.origin?.x ?? 0) / 100, y: (gl.origin?.y ?? 0) / 100, kind: "layoutOrigin" });
        }
        return;
      }
    }
    // gooey 는 위치가 base.fromShape (position 아님).
    const base = (el as { base?: unknown }).base as { position?: { x: number; y: number }; fromShape?: { x: number; y: number } };
    const pos = (el.element === "gooey" ? base.fromShape : base.position) ?? { x: 0.5, y: 0.5 };
    const s = sampleElementKeyframes(
      (el as { keyframes?: Parameters<typeof sampleElementKeyframes>[0] }).keyframes,
      localFrame,
    );
    out.push({ path: p, x: s.x ?? pos.x, y: s.y ?? pos.y, kind: "pos" });
  };
  for (const p of paths) {
    const el = getElement(doc, p);
    if (!el) continue;
    if (isGroup(el)) {
      // 경로/궤도 배치 그룹: 자식들이 경로에 붙어 있어 개별 position 드래그 무효 —
      // 그룹 드래그 = 배치 경로(origin) 통째 이동.
      const gl = (el as { layout?: { type?: string; origin?: { x: number; y: number } } }).layout;
      if (gl && (gl.type === "path" || gl.type === "orbit")) {
        out.push({ path: p, x: (gl.origin?.x ?? 0) / 100, y: (gl.origin?.y ?? 0) / 100, kind: "layoutOrigin" });
        continue;
      }
      // motionPath 그룹: 그룹 전체 이동 = 경로 origin (감사 #13 — leaf 와 동작 통일)
      const gmp = (el as { motionPath?: { origin?: { x: number; y: number } } }).motionPath;
      if (gmp) {
        out.push({ path: p, x: (gmp.origin?.x ?? 0) / 100, y: (gmp.origin?.y ?? 0) / 100, kind: "pathOrigin" });
        continue;
      }
      // 일반 그룹: 그룹 자체가 이동 타깃 — 그룹은 base.position(중심 오프셋,
      // 0.5=중립) + x/y 키프레임 채널을 가지므로 자식 분해가 아니라 그룹의
      // 트랜스폼을 움직인다 (armed 그룹 드래그 = 그룹 x/y 키 자동 기록,
      // 패널 X/Y 수치도 그룹 것이 갱신 — 실측 리포트 해결).
      {
        const gb = (el as { base?: { position?: { x: number; y: number } } }).base;
        const gs = sampleElementKeyframes(
          (el as { keyframes?: Parameters<typeof sampleElementKeyframes>[0] }).keyframes,
          localFrame,
        );
        out.push({ path: p, x: gs.x ?? gb?.position?.x ?? 0.5, y: gs.y ?? gb?.position?.y ?? 0.5, kind: "pos" });
      }
    } else {
      addLeaf(p, el);
    }
  }
  return out;
}

// 요소 타입별 크기 파라미터 추상화
type SizeParams =
  | { kind: "wh"; w: number; h: number } // shape (percent)
  | { kind: "scale"; field: "fontSize" | "size" | "scale"; value: number; min: number; max: number };

function sizeParamsOf(el: SceneElementSpec): SizeParams | null {
  if (el.element === "shape" || el.element === "image" || el.element === "video" || el.element === "frame" || el.element === "device" || el.element === "shader") {
    const base = (el as { base?: unknown }).base as { width?: number; height?: number };
    // 기본값은 엔진 렌더 기본과 일치 (감사 #12)
    const dflt = el.element === "frame" ? { w: 40, h: 30 } : el.element === "shader" ? { w: 100, h: 100 } : el.element === "device" ? { w: 56, h: 64 } : { w: 20, h: 12 };
    return { kind: "wh", w: base.width ?? dflt.w, h: base.height ?? dflt.h };
  }
  // preset element — base.width/height 우선, top-level(레거시 스펙) 폴백
  if (el.element === "neon_pill" || el.element === "glow_card" || el.element === "edge_light") {
    const p = el as { base?: { width?: number; height?: number }; width?: number; height?: number };
    const dflt = el.element === "neon_pill" ? { w: 46, h: 6.2 } : { w: 22, h: 15 };
    return { kind: "wh", w: p.base?.width ?? p.width ?? dflt.w, h: p.base?.height ?? p.height ?? dflt.h };
  }
  if (el.element === "glow_menu") {
    // 메뉴는 콘텐츠 크기 자동 — 균일 스케일로 리사이즈 (그룹과 동일 체감)
    const base = (el as { base?: { scale?: number } }).base;
    return { kind: "scale", field: "scale", value: base?.scale ?? 1, min: 0.05, max: 8 };
  }
  if (el.element === "text") {
    const base = (el as { base?: unknown }).base as { fontSize?: number };
    return { kind: "scale", field: "fontSize", value: base.fontSize ?? 4, min: 0.5, max: 50 };
  }
  if (el.element === "logo") {
    const base = (el as { base?: unknown }).base as { size?: number };
    return { kind: "scale", field: "size", value: base.size ?? 8, min: 0.5, max: 40 };
  }
  if (el.element === "group") {
    // 그룹 리사이즈 = base.scale 균일 스케일 (엔진이 자식 전체에 곱, 피벗은
    // base.anchor — 콘텐츠 중심). Figma 그룹 스케일과 같은 체감.
    const base = (el as { base?: { scale?: number } }).base;
    return { kind: "scale", field: "scale", value: base?.scale ?? 1, min: 0.05, max: 8 };
  }
  return null;
}

// 요소의 "회전 전(로컬)" 박스 크기(css px). 측정된 box 는 회전된 요소의 AABB 라
// 회전 각을 알면 원래 크기를 역산할 수 있다:
//   AABB_w = w0·|cos| + h0·|sin| ,  AABB_h = w0·|sin| + h0·|cos|
// 도형은 spec(width%·height%)로 정확히 계산. 텍스트/로고는 AABB 역산.
function localSize(
  el: SceneElementSpec,
  box: Box,
  scale: number,
  deg: number,
): { w: number; h: number } {
  if (Math.abs(deg) < 0.01) return { w: box.w, h: box.h }; // 회전 없으면 AABB 그대로
  if (el.element === "shape" || el.element === "image" || el.element === "video" || el.element === "frame" || el.element === "device" || el.element === "shader") {
    const base = (el as { base?: unknown }).base as { width?: number; height?: number };
    return {
      w: ((base.width ?? 20) / 100) * COMP_W * scale,
      h: ((base.height ?? 12) / 100) * COMP_H * scale,
    };
  }
  if (el.element === "neon_pill" || el.element === "glow_card" || el.element === "edge_light") {
    // 폭/높이 모두 vw 단위 (engine 계약)
    const p = el as { base?: { width?: number; height?: number }; width?: number; height?: number };
    return {
      w: ((p.base?.width ?? p.width ?? 22) / 100) * COMP_W * scale,
      h: ((p.base?.height ?? p.height ?? 15) / 100) * COMP_W * scale,
    };
  }
  const t = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  const det = c * c - s * s; // = cos(2θ)
  if (Math.abs(det) < 0.15) return { w: box.w, h: box.h }; // 45° 부근 불안정 → AABB 폴백
  return {
    w: Math.max(MIN_BOX, (box.w * c - box.h * s) / det),
    h: Math.max(MIN_BOX, (box.h * c - box.w * s) / det),
  };
}

export function SelectionOverlay() {
  const doc = useEditor((st) => st.doc);
  const selection = useEditor((st) => st.selection);
  const hovered = useEditor((st) => st.hovered);
  const activeScene = useEditor((st) => st.activeScene);
  const tool = useEditor((st) => st.ui.tool);
  const cameraManip = useEditor((st) => st.ui.cameraManip);
  const recordKeyframes = useEditor((st) => st.ui.recordKeyframes);
  const frame = usePlayerFrame(); // 재측정 트리거

  const rootRef = React.useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = React.useState<Record<ElementPath, Box>>({});
  const [marquee, setMarquee] = React.useState<Box | null>(null);
  const [guides, setGuides] = React.useState<{ vx: number[]; hy: number[] }>({ vx: [], hy: [] });
  const [hud, setHud] = React.useState<{ x: number; y: number; text: string } | null>(null);
  const boxesRef = React.useRef(boxes);
  boxesRef.current = boxes;

  // K(비율 고정) 키 held 추적 — Figma 는 shift 지만 사용자 요청으로 K 도 지원.
  // aspect 는 드래그 중 라이브로만 읽어 ref, alt 는 측정 표시 리렌더가 필요해 state.
  const aspectKeyRef = React.useRef(false);
  const [altDown, setAltDown] = React.useState(false);
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" || e.key === "K") aspectKeyRef.current = true;
      if (e.key === "Alt") setAltDown(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "k" || e.key === "K") aspectKeyRef.current = false;
      if (e.key === "Alt") setAltDown(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // 측정 — 활성 씬의 모든 요소 박스를 overlay-local 좌표로.
  const measure = React.useCallback(() => {
    const player = getPlayer();
    const overlay = rootRef.current;
    if (!player || !overlay || !doc) {
      setBoxes({});
      return;
    }
    const container = player.getContainerNode();
    if (!container) return;
    const sceneNode = activeSceneNode(container);
    if (!sceneNode) {
      setBoxes({});
      return;
    }
    const oRect = overlay.getBoundingClientRect();
    const toLocal = (r: DOMRect): Box => ({
      x: r.left - oRect.left,
      y: r.top - oRect.top,
      w: r.width,
      h: r.height,
    });

    const sceneIdx = Number(sceneNode.getAttribute("data-scene"));
    const findNode = (indices: number[]): Element | null => {
      let scope: Element = sceneNode;
      let node: Element | null = null;
      for (const idx of indices) {
        const kids = childDataEls(scope);
        node = kids.find((k) => Number(k.getAttribute("data-el")) === idx) ?? null;
        if (!node) return null;
        scope = node;
      }
      return node;
    };

    // 텍스트 박스 = 폰트 메트릭 박스 (Figma 모델). 잉크 바운드를 쓰면 "for"
    // (디센더 없음)와 "Engineered"(디센더 있음)가 같은 폰트·크기인데 박스
    // 높이가 달라져 세로 정렬이 어긋난다 (실측 리포트). 폰트 바운딩 어센트+
    // 디센트는 텍스트 내용과 무관 → 같은 폰트/크기 = 같은 박스 = 정렬 일치.
    // 글자 산개 등으로 rect 가 추정보다 훨씬 크면(1.8x) 애니메이션 중 — rect 유지.
    const scale = player.getScale() ?? 1;
    const refineTextInk = (box: Box, el: SceneElementSpec): Box => {
      const b = (el as { base?: { text?: string; fontSize?: number; fontWeight?: number; fontFamily?: string } }).base;
      const text = b?.text;
      if (!text) return box;
      const family = b?.fontFamily ?? doc.brandDefaults?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif";
      const m = inkMetrics(text, family, b?.fontWeight ?? 500);
      if (!m) return box;
      const em = (Math.min(50, Math.max(0.5, b?.fontSize ?? 4)) / 100) * COMP_W * scale;
      const cy = box.y + box.h / 2;
      const baseline = cy + ((m.fbAsc - m.fbDesc) / 2) * em;
      // 폰트 메트릭 박스 — 내용 무관 균일 높이 (베이스라인 기준 어센트/디센트)
      const top = baseline - m.fbAsc * em;
      const bottom = baseline + m.fbDesc * em;
      const fontH = bottom - top;
      if (fontH <= 0 || box.h > fontH * 1.8) return box;
      return { x: box.x, y: top, w: box.w, h: fontH };
    };

    const flat = flattenScene(doc, sceneIdx);
    const leafBoxes: Record<ElementPath, Box> = {};
    for (const { path, el } of flat) {
      if (el.element === "group") continue;
      const { indices } = parsePath(path);
      const node = findNode(indices);
      if (!node) continue;
      // 자기 박스(data-framebox) 선언 요소(frame/device)는 자식 union 이 아니라
      // 그 박스가 진실 — 3D bleed 캔버스/오버플로 자식이 박스를 못 부풀린다.
      // (증상: device 호버 박스가 bleed 캔버스 크기로 잡히던 것)
      {
        const own = node.querySelector("[data-framebox]");
        if (own) {
          leafBoxes[path] = toLocal(own.getBoundingClientRect());
          continue;
        }
      }
      const r = leafRect(node);
      if (!r) continue;
      const box = toLocal(r);
      leafBoxes[path] = el.element === "text" ? refineTextInk(box, el) : box;
    }
    const result: Record<ElementPath, Box> = { ...leafBoxes };
    for (const { path, el } of flat) {
      if (el.element !== "group") continue;
      const members = Object.entries(leafBoxes)
        .filter(([lp]) => isDescendantOf(lp, path) && lp !== path)
        .map(([, b]) => b);
      const u = unionBox(members);
      if (u) result[path] = u;
    }
    boxesRef.current = result; // 드래그 시작 등 동기 소비자용 즉시 갱신
    setBoxes(result);
  }, [doc]);

  React.useLayoutEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, frame, activeScene, selection, hovered]);

  React.useEffect(() => {
    const player = getPlayer();
    const overlay = rootRef.current;
    if (!overlay) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(overlay);
    const onScale = () => measure();
    player?.addEventListener("scalechange", onScale);
    return () => {
      ro.disconnect();
      player?.removeEventListener("scalechange", onScale);
    };
  }, [measure]);

  const store = useEditor;

  const topLevelPaths = React.useMemo(
    () => Object.keys(boxes).filter((p) => parsePath(p).indices.length === 1),
    [boxes],
  );

  const hitPath = React.useCallback(
    (x: number, y: number, deep: boolean): ElementPath | null => {
      const candidates = deep
        ? Object.keys(boxes).filter((p) => {
            const el = doc ? getElement(doc, p) : null;
            return el && el.element !== "group";
          })
        : topLevelPaths;
      let hit: ElementPath | null = null;
      let decoHit: ElementPath | null = null; // edge_light — 장식 레이어는 양보
      for (const p of candidates) {
        if (!boxContains(boxes[p], x, y)) continue;
        // edge_light 는 카드 전체를 덮는 히트박스라 안의 텍스트/아이콘 클릭을
        // 가로챈다 — 다른 후보가 있으면 양보, 저만 걸리면 선택 (실측: 분해
        // 카드에서 타이틀 더블클릭이 항상 edge_light 로 빠짐).
        const el = doc ? getElement(doc, p) : null;
        if (el?.element === "edge_light") decoHit = p;
        else hit = p;
      }
      return hit ?? decoHit;
    },
    [boxes, topLevelPaths, doc],
  );

  // --- 포인터 상호작용 ---
  const dragRef = React.useRef<{
    mode: "marquee" | "frameDraw" | "move" | "camera" | "resize" | "rotate" | "scaletool";
    scaleSnaps?: ScaleSnap[];
    scaleCenter?: { x: number; y: number };
    dist0?: number;
    /** marquee 전용 — ⌘ 딥 셀렉트 마퀴 (중첩 요소 선택, Figma) */
    deep?: boolean;
    camZoom?: number;
    startX: number;
    startY: number;
    additive: boolean;
    targets: { path: ElementPath; x: number; y: number; kind?: DragKind }[];
    scale: number;
    lastX?: number;
    lastY?: number;
    // 드래그 시작 시점의 씬-로컬 프레임 — 키는 항상 이 프레임에 쓴다.
    // (재생 중 드래그 시 플레이헤드가 흘러가며 매 move 마다 다른 프레임에
    //  키가 흩뿌려지는 것 방지)
    frame0?: number;
    // shift 축 고정 — 처음 우세했던 축을 드래그 끝까지 유지 (Figma). shift 를
    // 떼면 해제, 다시 누르면 그 시점 델타로 재판정.
    axisLock?: "x" | "y";
    // resize (로컬 회전 프레임)
    handle?: Handle;
    pos0?: { x: number; y: number };
    size0?: SizeParams;
    path?: ElementPath;
    unionBox0?: Box;
    w0?: number; // 회전 전 로컬 폭/높이(css px)
    h0?: number;
    deg?: number; // 요소 회전각
    // rotate
    center0?: { x: number; y: number };
    startAngle?: number;
    rotate0?: number;
  } | null>(null);

  // 씬 카메라 줌 (keyframes 카메라 scale) — 화면 px 는 playerScale x camZoom 으로
  // 확대돼 있어 드래그/리사이즈 환산 시 함께 나눠야 한다. (실측: 카메라 줌 1.27
  // 씬에서 프레임 모서리를 잡는 순간 크기가 1.27배로 기록되던 버그)
  const cameraZoomAt = (lf: number): number => {
    const st0 = useEditor.getState();
    const sc = st0.doc?.scenes?.[st0.activeScene];
    const cam = (sc as { camera?: { type?: string; keyframes?: unknown[] } } | undefined)?.camera;
    if (cam?.type === "keyframes") {
      const s = sampleCameraKeyframes((cam.keyframes ?? []) as Parameters<typeof sampleCameraKeyframes>[0], lf).scale;
      return s > 0 ? s : 1;
    }
    return 1;
  };

  const camLocalFrame = () => {
    const d = store.getState().doc;
    if (!d) return 0;
    const st = sceneStarts(d, FPS)[activeScene] ?? 0;
    return Math.max(0, Math.round((getPlayer()?.getCurrentFrame() ?? 0) - st));
  };

  // 정적 스냅 라인 — 이동/리사이즈 대상 제외 top-level 박스 + 씬 가장자리/중앙.
  const staticLines = (movingPaths: Set<ElementPath>) => {
    const vx: number[] = [];
    const hy: number[] = [];
    for (const p of topLevelPaths) {
      if (movingPaths.has(p)) continue;
      const b = boxes[p];
      if (!b) continue;
      vx.push(b.x, b.x + b.w / 2, b.x + b.w);
      hy.push(b.y, b.y + b.h / 2, b.y + b.h);
    }
    const overlay = rootRef.current;
    if (overlay) {
      const w = overlay.clientWidth,
        h = overlay.clientHeight;
      vx.push(0, w / 2, w);
      hy.push(0, h / 2, h);
    }
    return { vx, hy };
  };

  // 한 값을 후보 라인들에 스냅 — 가장 가까운 매치. [스냅오프셋, 매치라인]
  const snap1 = (val: number, lines: number[]): [number, number | null] => {
    let best: number | null = null;
    let line: number | null = null;
    for (const L of lines) {
      const d = L - val;
      if (Math.abs(d) < SNAP_TH && (best === null || Math.abs(d) < Math.abs(best))) {
        best = d;
        line = L;
      }
    }
    return [best ?? 0, line];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || tool === "hand") return;
    // AE 식: 캔버스를 잡는 순간 재생 정지 (프리뷰 중 편집 = 즉시 멈춤)
    pause();
    // 인라인 텍스트 편집 중 캔버스 조작 시작 = 편집 커밋 후 진행 — 안 닫으면
    // 편집창(textarea)이 옛 위치에 유령처럼 남고 원본 글리프는 숨겨진 채
    // 요소만 이동한다 (실측: "요소 치우니까 텍스트가 제자리에 떠 있음").
    if (editingText) {
      store.getState().endCoalescing();
      setEditingText(null);
    }
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    const x = e.clientX - oRect.left;
    const y = e.clientY - oRect.top;
    const st = store.getState();

    // Frame 툴 (F) — 요소 위든 빈 곳이든 드래그 = frame 그리기 (Figma)
    if (tool === "frame") {
      dragRef.current = { mode: "frameDraw", startX: x, startY: y, additive: false, targets: [], scale: getPlayer()?.getScale() ?? 1 };
      capturePointer(overlay, e.pointerId);
      return;
    }

    // ⌘클릭/드래그 = 깊은(하위) 요소 직접 선택 — frame/group 을 뚫고 그 요소를 잡는다 (Figma).
    const deepPick = e.metaKey;
    const hit = hitPath(x, y, deepPick);

    // Canvas control(카메라 조작): "빈 공간" 드래그만 카메라 팬. 요소 위를 드래그하면
    // 그 요소를 정상 편집(스마트 가이드/이동 동작) — 카메라 켜둔 채로도 요소 편집 가능.
    if (cameraManip && !hit) {
      dragRef.current = { mode: "camera", startX: x, startY: y, additive: false, targets: [], scale: getPlayer()?.getScale() ?? 1, lastX: x, lastY: y };
      capturePointer(overlay, e.pointerId);
      return;
    }

    // 이미 선택된 요소(frame 자식 등 중첩 포함) 위에서 드래그 시작 → 선택 유지.
    // 안 그러면 top-level 히트(frame)로 선택이 갈아치워져 자식 대신 frame 이 끌린다.
    const onSelected =
      !e.shiftKey && !deepPick && st.selection.some((p) => boxes[p] && boxContains(boxes[p], x, y));

    if (!hit && !onSelected) {
      if (!e.shiftKey) st.clearSelection();
      dragRef.current = { mode: "marquee", startX: x, startY: y, additive: e.shiftKey, deep: e.metaKey, targets: [], scale: getPlayer()?.getScale() ?? 1 };
      capturePointer(overlay, e.pointerId);
      return;
    }

    if (e.shiftKey) {
      if (hit) st.toggleSelect(hit);
      return;
    }
    let sel = st.selection;
    if (!onSelected && hit && !sel.includes(hit)) {
      st.select([hit]);
      sel = [hit];
    }
    if (e.altKey) {
      const dup = duplicateElements(sel);
      sel = dup.length ? dup : sel;
    }
    const doc2 = store.getState().doc;
    if (!doc2) return;
    // 스냅 기준용 원본 union 박스(시작 시점) — 매 프레임 재측정값을 쓰면
    // 이미 이동된 박스에 전체 델타를 또 더해 이중 계산됨. 시작 시 신선 측정
    // (줌 직후 스테일 박스 가드 — 리사이즈와 동일).
    measure();
    const selBoxes = sel.map((p) => boxesRef.current[p]).filter(Boolean) as Box[];
    const dragFrame = camLocalFrame();
    const targets = leafTargets(doc2, sel, dragFrame);
    dragRef.current = {
      mode: "move",
      startX: x,
      startY: y,
      additive: false,
      targets,
      scale: getPlayer()?.getScale() ?? 1,
      unionBox0: unionBox(selBoxes) ?? undefined,
      frame0: dragFrame,
      camZoom: cameraZoomAt(dragFrame),
    };
    capturePointer(overlay, e.pointerId);
  };

  // 리사이즈 시작 (핸들에서)
  const startResize = (e: React.PointerEvent, handle: Handle, path: ElementPath) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    // 스테일 박스 가드: 줌 변경 직후 등 재측정 이벤트가 안 돈 상태에서 잡으면
    // 박스가 이전 배율이라 첫 이동에서 크기가 배율비만큼 점프한다 (실측 리포트:
    // "모서리 잡는 순간 1.5배"). 시작 시점에 항상 신선 측정.
    measure();
    const box0 = boxesRef.current[path];
    const el = doc ? getElement(doc, path) : null;
    if (!box0 || !el) return;
    const size0 = sizeParamsOf(el);
    // K(Scale 툴): 핸들 드래그 = 요소 트리 실제값 비율 스케일 (Figma Scale)
    if (store.getState().ui.tool === "scale") {
      const sel = store.getState().selection.length ? store.getState().selection : [path];
      const bs = sel.map((p) => boxesRef.current[p]).filter(Boolean) as Box[];
      const ub = unionBox(bs);
      if (!ub) return;
      const liveScale0 = getPlayer()?.getScale() ?? 1;
      const cx = (ub.x + ub.w / 2) / liveScale0 / COMP_W;
      const cy = (ub.y + ub.h / 2) / liveScale0 / COMP_H;
      const px = e.clientX - oRect.left;
      const py = e.clientY - oRect.top;
      dragRef.current = {
        mode: "scaletool",
        startX: px,
        startY: py,
        additive: false,
        targets: [],
        scale: liveScale0,
        scaleSnaps: snapshotForScale(sel),
        scaleCenter: { x: cx, y: cy },
        center0: { x: ub.x + ub.w / 2, y: ub.y + ub.h / 2 },
        dist0: Math.max(8, Math.hypot(px - (ub.x + ub.w / 2), py - (ub.y + ub.h / 2))),
      };
      capturePointer(overlay, e.pointerId);
      return;
    }
    if (!size0) return;
    // 그룹은 피벗을 콘텐츠 중심으로 — comp 중앙 기준 수축 드리프트 방지
    if (el.element === "group") ensureGroupAnchor(path);
    const base = ((el as { base?: unknown }).base ?? {}) as { position?: { x: number; y: number }; rotate?: number };
    const scale = getPlayer()?.getScale() ?? 1;
    const deg = base.rotate ?? 0;
    const { w, h } = localSize(el, box0, scale, deg);
    dragRef.current = {
      mode: "resize",
      startX: e.clientX - oRect.left,
      startY: e.clientY - oRect.top,
      additive: false,
      targets: [],
      scale,
      handle,
      pos0: base.position ?? { x: 0.5, y: 0.5 },
      size0,
      path,
      // 요소 중심(= AABB 중심, 회전은 중심 기준) · 로컬 크기 · 회전각
      center0: { x: box0.x + box0.w / 2, y: box0.y + box0.h / 2 },
      w0: w,
      h0: h,
      deg,
      camZoom: cameraZoomAt(camLocalFrame()),
    };
    capturePointer(overlay, e.pointerId);
  };

  // 회전 시작 (코너 히트존에서)
  const startRotate = (e: React.PointerEvent, path: ElementPath) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    measure();
    const box0 = boxesRef.current[path];
    const el = doc ? getElement(doc, path) : null;
    if (!box0 || !el) return;
    if (el.element === "group") ensureGroupAnchor(path);
    const cx = box0.x + box0.w / 2,
      cy = box0.y + box0.h / 2;
    const px = e.clientX - oRect.left,
      py = e.clientY - oRect.top;
    const base = ((el as { base?: unknown }).base ?? {}) as { rotate?: number };
    const deg0 = base.rotate ?? 0;
    dragRef.current = {
      mode: "rotate",
      startX: px,
      startY: py,
      additive: false,
      targets: [],
      scale: getPlayer()?.getScale() ?? 1,
      path,
      center0: { x: cx, y: cy },
      startAngle: Math.atan2(py - cy, px - cx),
      rotate0: deg0,
      h0: localSize(el, box0, getPlayer()?.getScale() ?? 1, deg0).h,
      frame0: camLocalFrame(),
    };
    capturePointer(overlay, e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    const x = e.clientX - oRect.left;
    const y = e.clientY - oRect.top;

    if (!d) {
      if (tool === "hand") return;
      if (tool === "frame") {
        // frame 그리기 모드 — 호버 하이라이트 없음 (Figma)
        if (store.getState().hovered) store.getState().setHovered(null);
        return;
      }
      // cameraManip 이어도 요소 호버는 보여준다(요소 위 = 편집, 빈 곳 = 팬 구분 인지).
      const hit = hitPath(x, y, false);
      const st = store.getState();
      if (hit !== st.hovered) st.setHovered(hit);
      return;
    }

    if (d.mode === "scaletool") {
      const dist = Math.max(4, Math.hypot(x - d.center0!.x, y - d.center0!.y));
      const k = dist / (d.dist0 ?? 1);
      applyScaleDeep(d.scaleSnaps ?? [], k, (d.scaleSnaps?.length ?? 0) > 1 ? { type: "union", x: d.scaleCenter!.x, y: d.scaleCenter!.y } : null, true);
      setHud({ x: d.center0!.x, y: d.center0!.y - 30, text: `${Math.round(k * 100)}%` });
      return;
    }
    if (d.mode === "camera") {
      const ddx = (x - (d.lastX ?? x)) / d.scale / COMP_W;
      const ddy = (y - (d.lastY ?? y)) / d.scale / COMP_H;
      d.lastX = x;
      d.lastY = y;
      if (ddx !== 0 || ddy !== 0) applyCameraDelta(activeScene, camLocalFrame(), { dx: ddx, dy: ddy }, true);
      return;
    }

    if (d.mode === "marquee" || d.mode === "frameDraw") {
      setMarquee({ x: Math.min(d.startX, x), y: Math.min(d.startY, y), w: Math.abs(x - d.startX), h: Math.abs(y - d.startY) });
      return;
    }

    if (d.mode === "rotate") {
      const c = d.center0!;
      const ang = Math.atan2(y - c.y, x - c.x);
      let deg = d.rotate0! + ((ang - d.startAngle!) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      // -180..180 정규화
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      const degR = Math.round(deg * 10) / 10;
      // rotate 채널이 armed 거나 REC ON → base.rotate 대신 키프레임(= 시각각 - base.rotate).
      const rotEl = store.getState().doc ? getElement(store.getState().doc!, d.path!) : null;
      if (store.getState().ui.recordKeyframes || (rotEl && isChannelArmed(rotEl, "rotate"))) {
        applyElementDelta(d.path!, d.frame0 ?? camLocalFrame(), { rotate: degR - (d.rotate0 ?? 0) }, true);
      } else {
        store.getState().updateDoc(
          "Rotate",
          (draft) => {
            const el = getElement(draft, d.path!);
            if (!el) return;
            const holder = el as { base?: { rotate?: number } };
            if (!holder.base) holder.base = {};
            holder.base.rotate = degR;
          },
          { coalesceKey: "canvas-rotate" },
        );
      }
      setHud({ x: c.x, y: c.y - (d.h0 ?? 40) / 2 - 26, text: `${Math.round(deg)}°` });
      return;
    }

    if (d.mode === "resize") {
      const liveScale = getPlayer()?.getScale() ?? d.scale;
      const size0 = d.size0!;
      const isScale = size0.kind === "scale";
      const forceAspect = isScale || e.shiftKey || aspectKeyRef.current;
      const fromCenter = e.altKey;
      const handle = d.handle!;
      const deg = d.deg ?? 0;
      const rad = (deg * Math.PI) / 180;
      const c0 = d.center0!; // 요소 중심(스크린 px)
      const w0 = d.w0!,
        h0 = d.h0!;
      const affectX = handle.length === 2 || handle === "l" || handle === "r";
      const affectY = handle.length === 2 || handle === "t" || handle === "b";

      // 커서를 요소 로컬(회전) 프레임으로 회전(-θ). 회전 없으면 항등.
      const gv: number[] = [];
      const gh: number[] = [];
      let sxp = x - c0.x,
        syp = y - c0.y;
      // 스냅은 회전 없을 때만(축정렬 라인 기준) + Cmd/Ctrl 안 눌렀을 때(정밀 리사이즈).
      if (Math.abs(deg) < 0.01 && !(e.metaKey || e.ctrlKey)) {
        const sl = staticLines(new Set([d.path!]));
        if (affectX) {
          const [off, line] = snap1(x, sl.vx);
          if (line !== null) {
            sxp = x + off - c0.x;
            gv.push(line);
          }
        }
        if (affectY) {
          const [off, line] = snap1(y, sl.hy);
          if (line !== null) {
            syp = y + off - c0.y;
            gh.push(line);
          }
        }
      }
      const cosN = Math.cos(-rad),
        sinN = Math.sin(-rad);
      const lx = sxp * cosN - syp * sinN;
      const ly = sxp * sinN + syp * cosN;

      // 로컬 박스: 중심 원점, 크기 w0×h0.
      const localBox: Box = { x: -w0 / 2, y: -h0 / 2, w: w0, h: h0 };
      const a = anchorPoint(localBox, handle, fromCenter);
      let newW = affectX ? (fromCenter ? 2 * Math.abs(lx - a.x) : Math.abs(lx - a.x)) : w0;
      let newH = affectY ? (fromCenter ? 2 * Math.abs(ly - a.y) : Math.abs(ly - a.y)) : h0;
      newW = Math.max(MIN_BOX, newW);
      newH = Math.max(MIN_BOX, newH);
      if (forceAspect && affectX && affectY) {
        const ratio = w0 / h0;
        if (newW / w0 >= newH / h0) newH = newW / ratio;
        else newW = newH * ratio;
      }

      // 로컬 새 중심(원점 기준) — anchor 고정.
      const signX = lx >= a.x ? 1 : -1;
      const signY = ly >= a.y ? 1 : -1;
      const nlx = fromCenter ? 0 : affectX ? a.x + (signX * newW) / 2 : 0;
      const nly = fromCenter ? 0 : affectY ? a.y + (signY * newH) / 2 : 0;
      // 로컬 중심 이동을 스크린으로 되돌림(+θ).
      const cosP = Math.cos(rad),
        sinP = Math.sin(rad);
      const dScreenX = nlx * cosP - nly * sinP;
      const dScreenY = nlx * sinP + nly * cosP;
      const effScale = liveScale * (d.camZoom ?? 1);
      const dxFrac = dScreenX / effScale / COMP_W;
      const dyFrac = dScreenY / effScale / COMP_H;
      // frame 자식은 position 이 frame-로컬 — comp 델타를 로컬로 변환 (감사 #1)
      const rf = store.getState().doc ? ancestorFrameScale(store.getState().doc!, d.path!) : { fx: 1, fy: 1 };
      const npos = {
        x: Math.min(1, Math.max(0, d.pos0!.x + dxFrac * rf.fx)),
        y: Math.min(1, Math.max(0, d.pos0!.y + dyFrac * rf.fy)),
      };

      setGuides({ vx: gv, hy: gh });
      setHud({
        x: c0.x,
        y: c0.y - newH / 2 - 22,
        text: `${Math.round(newW / effScale)} × ${Math.round(newH / effScale)}`,
      });

      // frame 은 w/h 가 키프레임 채널 — REC 또는 armed 면 키로 기록 (백로그 #11)
      {
        const curEl = store.getState().doc ? getElement(store.getState().doc!, d.path!) : null;
        const recOn = store.getState().ui.recordKeyframes;
        const whArmed = !!curEl && (isChannelArmed(curEl, "w") || isChannelArmed(curEl, "h"));
        if (curEl?.element === "frame" && size0.kind === "wh" && (recOn || whArmed)) {
          const lf = d.frame0 ?? camLocalFrame();
          upsertChannelKey(d.path!, "w", lf, Math.min(400, Math.max(0.5, (newW / effScale / COMP_W) * 100)), true);
          upsertChannelKey(d.path!, "h", lf, Math.min(400, Math.max(0.5, (newH / effScale / COMP_H) * 100)), true);
          upsertChannelKey(d.path!, "x", lf, npos.x, true);
          upsertChannelKey(d.path!, "y", lf, npos.y, true);
          return;
        }
      }
      store.getState().updateDoc(
        "Resize",
        (draft) => {
          const el = getElement(draft, d.path!);
          if (!el) return;
          const holder = el as { base?: Record<string, unknown> };
          if (!holder.base) holder.base = {};
          const base = holder.base;
          if (size0.kind === "wh") {
            // 캔버스보다 커질 수 있다 (오프캔버스 배치/줌인 연출) — 400% 상한
            base.width = Math.min(400, Math.max(0.5, (newW / effScale / COMP_W) * 100));
            // preset element(neon_pill/glow_card)는 height 도 vw 단위 (engine 계약)
            const vwH = el.element === "neon_pill" || el.element === "glow_card";
            base.height = Math.min(400, Math.max(0.5, (newH / effScale / (vwH ? COMP_W : COMP_H)) * 100));
            // Figma 동작: hug 프레임의 핸들을 잡으면 Fixed 로 전환 — 안 하면
            // 렌더는 hug(max-content) 인데 선언값만 바뀌어 크기가 "확" 점프한다(실측).
            const fl = (el as { flow?: { hugW?: boolean; hugH?: boolean } }).flow;
            if (fl?.hugW) fl.hugW = undefined;
            if (fl?.hugH) fl.hugH = undefined;
          } else {
            const k = newW / w0; // 균일 스케일(코너, 비율 고정)
            base[size0.field] = Math.min(size0.max, Math.max(size0.min, size0.value * k));
          }
          // 그룹 position 은 "중심 오프셋"(0.5=중립) — 절대좌표 npos 를 쓰면
          // 텔레포트한다. 그룹 스케일은 anchor 피벗 중심 확대라 위치 불변.
          if (el.element !== "group") base.position = npos;
        },
        { coalesceKey: "canvas-resize" },
      );
      return;
    }

    // move
    const liveScale = getPlayer()?.getScale() ?? d.scale;
    let dxCss = x - d.startX;
    let dyCss = y - d.startY;
    if (e.shiftKey) {
      // 처음 우세한 축으로 고정 — 이후 반대축 델타가 커져도 안 바뀜.
      if (!d.axisLock && Math.abs(dxCss) + Math.abs(dyCss) > 2) {
        d.axisLock = Math.abs(dxCss) >= Math.abs(dyCss) ? "x" : "y";
      }
      if (d.axisLock === "x") dyCss = 0;
      else if (d.axisLock === "y") dxCss = 0;
      else { dxCss = 0; dyCss = 0; } // 방향 판정 전 미동 구간
    } else if (d.axisLock) {
      d.axisLock = undefined; // shift 해제 = 자유 이동 복귀
    }

    // 스마트 가이드 — 이동 대상 union 박스(시작 시점 + 전체 델타)의 가장자리/중앙을
    // 정적 라인에 스냅. ub 는 드래그 시작 때 캡처한 원본(재측정값 아님).
    // 제외 집합은 선택된 top-level 경로(그룹이면 그룹 자신) — self-snap 방지.
    const movingPaths = new Set(store.getState().selection);
    const ub = d.unionBox0 ?? null;
    const sl = staticLines(movingPaths);
    const gv: number[] = [];
    const gh: number[] = [];
    // Cmd/Ctrl 누른 채 드래그 = 스냅 무시(픽셀 단위 정밀 이동).
    const snapOff = e.metaKey || e.ctrlKey;
    if (ub && !snapOff) {
      // 중앙을 먼저 — 같은 크기 요소끼리는 상/중/하가 동시에 정렬되는데,
      // first-win 비교라 순서가 곧 우선순위다 (중앙 정렬 피드백이 우선).
      const movLinesX = [ub.x + ub.w / 2 + dxCss, ub.x + dxCss, ub.x + ub.w + dxCss];
      const movLinesY = [ub.y + ub.h / 2 + dyCss, ub.y + dyCss, ub.y + ub.h + dyCss];
      let bestX: number | null = null;
      for (const ml of movLinesX) {
        const [off, line] = snap1(ml, sl.vx);
        if (line !== null && (bestX === null || Math.abs(off) < Math.abs(bestX))) bestX = off;
      }
      let bestY: number | null = null;
      for (const ml of movLinesY) {
        const [off, line] = snap1(ml, sl.hy);
        if (line !== null && (bestY === null || Math.abs(off) < Math.abs(bestY))) bestY = off;
      }
      // 스냅 적용 후 "실제로 일치하는" 정적 라인을 전부 표시 — 중앙+가장자리가
      // 동시에 맞으면 셋 다 보인다 (Figma 관례). 하나만 그리면 중앙 정렬이
      // 인식 안 되는 것처럼 보인다 (실측 리포트).
      if (bestX !== null) {
        dxCss += bestX;
        const movedX = [ub.x + dxCss, ub.x + ub.w / 2 + dxCss, ub.x + ub.w + dxCss];
        for (const line of new Set(sl.vx)) {
          if (movedX.some((mx) => Math.abs(mx - line) < 0.75)) gv.push(line);
        }
      }
      if (bestY !== null) {
        dyCss += bestY;
        const movedY = [ub.y + dyCss, ub.y + ub.h / 2 + dyCss, ub.y + ub.h + dyCss];
        for (const line of new Set(sl.hy)) {
          if (movedY.some((my) => Math.abs(my - line) < 0.75)) gh.push(line);
        }
      }
    }
    setGuides({ vx: gv, hy: gh });

    const camZmv = d.camZoom ?? 1;
    const dxFrac = dxCss / (liveScale * camZmv) / COMP_W;
    const dyFrac = dyCss / (liveScale * camZmv) / COMP_H;

    // frame 자식의 position 은 frame-로컬(0..1=박스) — 캔버스 델타를 박스 크기로 나눈다.
    // 클램프는 로컬 0..1 이 아니라 "comp 0..1 의 로컬 환산" — frame 자식이 frame 경계에
    // 안 걸리고 밖으로 드래그돼 나갈 수 있어야 한다(자동 리페어런트).
    const curDoc = store.getState().doc;
    type DeltaFrame = { fx: number; fy: number; bx: number; by: number; bw: number; bh: number };
    const deltaScaleOf = (path: ElementPath): DeltaFrame => {
      // 조상 frame 체인 전체를 합성 — group 은 좌표계 identity 지만 base.scale
      // (+scale 키프레임)이 있으면 렌더가 배율만큼 증폭되므로 델타를 나눠준다
      // (실측: 스케일 큰 그룹 자식 드래그가 마우스보다 훨씬 크게 움직임).
      const top: DeltaFrame = { fx: 1, fy: 1, bx: 0, by: 0, bw: 1, bh: 1 };
      if (!curDoc) return top;
      let acc = { x: 0, y: 0, w: 1, h: 1 };
      let gscale = 1;
      let pp = parentPath(path);
      const chain: { x: number; y: number; w: number; h: number }[] = [];
      const dragFrame = dragRef.current?.frame0 ?? 0;
      while (pp) {
        const pf = getElement(curDoc, pp);
        if (pf?.element === "frame") chain.unshift(frameBoxOf(pf));
        else if (pf?.element === "group") {
          const gb = (pf as { base?: { scale?: number } }).base;
          const kfS = sampleElementKeyframes((pf as { keyframes?: Parameters<typeof sampleElementKeyframes>[0] }).keyframes, dragFrame).scale;
          gscale *= Math.max(0.01, (gb?.scale ?? 1) * kfS);
        }
        pp = parentPath(pp);
      }
      for (const box of chain) {
        acc = {
          x: acc.x + box.x * acc.w,
          y: acc.y + box.y * acc.h,
          w: acc.w * Math.max(0.01, box.w),
          h: acc.h * Math.max(0.01, box.h),
        };
      }
      if (chain.length === 0 && gscale === 1) return top;
      return { fx: 1 / (acc.w * gscale), fy: 1 / (acc.h * gscale), bx: acc.x, by: acc.y, bw: acc.w, bh: acc.h };
    };
    // 캔버스 밖 자유 배치 (Figma) — 위치를 comp 0..1 에 가두지 않는다.
    // 폭주 방지용 넉넉한 안전 한계만 (-10..11 comp fraction).
    const clX = (v: number, f: DeltaFrame) => Math.min((11 - f.bx) / f.bw, Math.max((-10 - f.bx) / f.bw, v));
    const clY = (v: number, f: DeltaFrame) => Math.min((11 - f.by) / f.bh, Math.max((-10 - f.by) / f.bh, v));
    // 드래그 → 쓰기 규칙 (AE 스톱워치 시멘틱):
    //  - x/y 채널이 armed(키 존재)면 REC 여부와 무관하게 드래그 시작 프레임에 키.
    //    (armed 인데 base 를 쓰면 키프레임이 덮어써서 제자리로 튀는 버그였음)
    //  - REC ON 이면 armed 아니어도 키를 찍는다 = 첫 키 생성(채널 arm).
    //  - 그 외(armed 아님 + REC OFF)는 base.position 편집.
    const rec = store.getState().ui.recordKeyframes;
    const lf = d.frame0 ?? camLocalFrame(); // 드래그 시작 프레임 고정 (재생 중 키 산포 방지)
    const keyTargets: { t: (typeof d.targets)[number]; kx: boolean; ky: boolean }[] = [];
    const moveTargets: typeof d.targets = [];
    for (const t of d.targets) {
      // origin 드래그(경로 통째 이동)는 키프레임 대상 아님 — 항상 직접 쓰기.
      if (t.kind === "layoutOrigin" || t.kind === "pathOrigin") {
        moveTargets.push(t);
        continue;
      }
      const el = curDoc ? getElement(curDoc, t.path) : null;
      // gooey 위치는 base.fromShape 전용 — 엔진이 x/y 키프레임을 소비하지 않아
      // REC/armed 로 보내면 죽은 키만 쌓이고 블롭은 안 움직인다 (감사 #3).
      if (el?.element === "gooey") {
        moveTargets.push(t);
        continue;
      }
      // 축별 판정 — x 만 armed 인 요소를 드래그해도 y 에 키가 찍히면 안 된다
      // (실측: 가로 드래그의 세로 지터가 y 키 49.8/49.5 로 쌓이던 버그).
      const kx = rec || (!!el && isChannelArmed(el, "x"));
      const ky = rec || (!!el && isChannelArmed(el, "y"));
      if (kx || ky) keyTargets.push({ t, kx, ky });
      else moveTargets.push(t);
    }
    // 안 armed 인 축은 정적(base) 이동 — 키로 간 축과 분리 수집
    const axisMoves: { path: ElementPath; x?: number; y?: number }[] = [];
    for (const { t, kx, ky } of keyTargets) {
      const f = deltaScaleOf(t.path);
      const nx = clX(t.x + dxFrac * f.fx, f);
      const ny = clY(t.y + dyFrac * f.fy, f);
      applyElementDelta(t.path, lf, { ...(kx ? { x: nx } : {}), ...(ky ? { y: ny } : {}) }, true);
      if (!kx || !ky) axisMoves.push({ path: t.path, ...(kx ? {} : { x: nx }), ...(ky ? {} : { y: ny }) });
    }
    if (moveTargets.length === 0 && axisMoves.length === 0) return;
    store.getState().updateDoc(
      "Move",
      (draft) => {
        for (const t of moveTargets) {
          const el = getElement(draft, t.path);
          if (!el) continue;
          // 경로 origin 이동 (0..100 단위, 화면 밖 여유 허용)
          if (t.kind === "layoutOrigin" || t.kind === "pathOrigin") {
            const ox = Math.max(-80, Math.min(80, (t.x + dxFrac) * 100));
            const oy = Math.max(-80, Math.min(80, (t.y + dyFrac) * 100));
            const holder = t.kind === "layoutOrigin"
              ? (el as { layout?: { origin?: { x: number; y: number } } }).layout
              : (el as { motionPath?: { origin?: { x: number; y: number } } }).motionPath;
            if (holder) holder.origin = { x: Number(ox.toFixed(2)), y: Number(oy.toFixed(2)) };
            continue;
          }
          const f = deltaScaleOf(t.path);
          const npos = { x: clX(t.x + dxFrac * f.fx, f), y: clY(t.y + dyFrac * f.fy, f) };
          // gooey 는 fromShape, 그 외(그룹 포함)는 position.
          if (el.element === "gooey") (el.base as { fromShape?: { x: number; y: number } }).fromShape = npos;
          else {
            const holder = el as { base?: { position?: { x: number; y: number } } };
            if (!holder.base) holder.base = {};
            holder.base.position = npos;
          }
        }
        // 부분 축 base 쓰기 — 키로 간 축은 건드리지 않는다
        for (const m of axisMoves) {
          const el = getElement(draft, m.path);
          if (!el) continue;
          const holder = el as { base?: { position?: { x: number; y: number } } };
          if (!holder.base) holder.base = {};
          const pos = holder.base.position ?? { x: 0.5, y: 0.5 };
          holder.base.position = { x: m.x ?? pos.x, y: m.y ?? pos.y };
        }
      },
      { coalesceKey: "canvas-move" },
    );
  };

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      onPointerUpInner(e);
    } finally {
      // 제스처 경계 — 어떤 early-return 경로로 빠져도 반드시 닫는다.
      // (리페어런트까지 이 안에서 일어나므로 "이동+네스팅" 이 undo 1건)
      store.getState().endGesture();
    }
  };

  const onPointerUpInner = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const overlay = rootRef.current!;
    releasePointer(overlay, e.pointerId);
    if (!d) return;
    dragRef.current = null;
    setGuides({ vx: [], hy: [] });
    setHud(null);

    if (d.mode === "camera") {
      store.getState().endCoalescing();
      return;
    }
    if (d.mode === "frameDraw") {
      const m = marquee;
      setMarquee(null);
      const liveScale = getPlayer()?.getScale() ?? d.scale;
      const toFrac = (r: Box) => ({
        x: r.x / liveScale / COMP_W,
        y: r.y / liveScale / COMP_H,
        w: r.w / liveScale / COMP_W,
        h: r.h / liveScale / COMP_H,
      });
      if (m && (m.w > 4 || m.h > 4)) {
        addFrameAt(store.getState().activeScene, toFrac(m));
      } else {
        // 클릭 = Figma 기본 100x100px frame (클릭점 중심)
        const w = 100 / COMP_W;
        const h = 100 / COMP_H;
        const cx = d.startX / liveScale / COMP_W;
        const cy = d.startY / liveScale / COMP_H;
        addFrameAt(store.getState().activeScene, { x: cx - w / 2, y: cy - h / 2, w, h });
      }
      store.getState().setUI({ tool: "select" });
      return;
    }
    if (d.mode === "marquee") {
      const m = marquee;
      setMarquee(null);
      if (m && (m.w > 3 || m.h > 3)) {
        // ⌘ 마퀴 = 딥 셀렉트 (Figma 실측 규칙): 사각형이 컨테이너를 "완전히"
        // 감싸면 컨테이너 자체를 선택하고 하강 중단, "부분"만 겹치면 내부로
        // 재귀 하강해 중첩 요소를 선택. 리프는 닿으면 선택. 빈 컨테이너는
        // 리프 취급(안 그러면 새 frame 을 ⌘마퀴로 잡을 방법이 없다).
        const hits = d.deep
          ? (() => {
              const doc0 = store.getState().doc;
              if (!doc0) return [] as ElementPath[];
              const encloses = (b: Box) =>
                m.x <= b.x && m.y <= b.y && m.x + m.w >= b.x + b.w && m.y + m.h >= b.y + b.h;
              const out: ElementPath[] = [];
              const visit = (el: SceneElementSpec, path: ElementPath) => {
                const b = boxes[path];
                if (!b || !boxIntersects(b, m)) return;
                const kids = hasChildren(el) ? (el.children ?? []) : [];
                if (kids.length > 0 && !encloses(b)) {
                  kids.forEach((k, i) => visit(k, `${path}.${i}`));
                  return;
                }
                out.push(path);
              };
              const els = doc0.scenes?.[store.getState().activeScene]?.elements ?? [];
              els.forEach((el, i) => visit(el, buildPath(store.getState().activeScene, [i])));
              return out;
            })()
          : topLevelPaths.filter((p) => boxIntersects(boxes[p], m));
        store.getState().select(hits, { additive: d.additive });
      }
      return;
    }
    store.getState().endCoalescing();

    // Figma 자동 네스팅 — leaf 하나를 드래그해 frame 박스 위에 놓으면 그 frame 으로
    // 리페어런트(좌표 유지 변환), frame 밖에 놓으면 최상위로 꺼낸다. (다중/컨테이너 제외)
    if (d.mode === "move" && d.targets.length === 1) {
      const curDoc = store.getState().doc;
      if (!curDoc) return;
      const oRect = overlay.getBoundingClientRect();
      const liveScale = getPlayer()?.getScale() ?? d.scale;
      const px = (e.clientX - oRect.left) / liveScale / COMP_W;
      const py = (e.clientY - oRect.top) / liveScale / COMP_H;
      const dragged = d.targets[0].path;
      const el = getElement(curDoc, dragged);
      if (!el || el.element === "group" || el.element === "frame") return;
      // 중첩 frame 포함 전체 탐색 (백로그 #15) — 측정된 오버레이 박스(진실)로
      // 히트테스트하고, 겹치면 가장 깊은 frame 을 선택한다.
      const ox = e.clientX - oRect.left;
      const oy = e.clientY - oRect.top;
      let target: ElementPath | null = null;
      let targetDepth = -1;
      for (const [fp, fbox] of Object.entries(boxesRef.current)) {
        const cand = getElement(curDoc, fp);
        if (!cand || cand.element !== "frame") continue;
        if (fp === dragged || isDescendantOf(fp, dragged)) continue;
        if (ox < fbox.x || ox > fbox.x + fbox.w || oy < fbox.y || oy > fbox.y + fbox.h) continue;
        const depth = parsePath(fp).indices.length;
        if (depth > targetDepth) {
          target = fp;
          targetDepth = depth;
        }
      }
      void px; void py;
      // 자동 네스팅은 frame 관계에만. 현재 부모가 group 이면 캔버스 드래그로
      // 절대 리페어런트하지 않는다 — group 자식을 옮기거나 키프레임을 REC 로
      // 찍는 순간 그 자식이 group 밖(최상위)으로 튕기거나 frame 안으로 빨려
      // 들어갔다 (실측 리포트: "키프레임 드래그했더니 그룹 밖으로"). group
      // 소속은 레이어/타임라인 패널에서만 바꾼다.
      const parentP = parentPath(dragged);
      const parentEl = parentP ? getElement(curDoc, parentP) : null;
      const inGroup = parentEl?.element === "group";
      const inFrame = parentEl?.element === "frame";
      if (!inGroup && (target !== null || inFrame)) {
        reparentElement(dragged, target); // 같은 부모면 내부에서 no-op
      }
    }
  };

  // Frame selection (⌥⌘G / 우클릭) — 선택 boxes(오버레이 px) 합집합 → 캔버스 fraction
  // bbox 로 frameSelection 실행. 단축키는 window 이벤트로 이 컴포넌트를 부른다.
  const runFrameSelection = React.useCallback(() => {
    const st = store.getState();
    const sel = st.selection;
    if (sel.length === 0) return;
    const liveScale = getPlayer()?.getScale() ?? 1;
    const bs = sel.map((p) => boxes[p]).filter((b): b is Box => !!b);
    if (bs.length === 0) return;
    const ub = unionBox(bs);
    if (!ub) return;
    frameSelection(sel, {
      x: ub.x / liveScale / COMP_W,
      y: ub.y / liveScale / COMP_H,
      w: ub.w / liveScale / COMP_W,
      h: ub.h / liveScale / COMP_H,
    });
  }, [boxes]);
  React.useEffect(() => {
    const h = () => runFrameSelection();
    window.addEventListener("scene24:frame-selection", h);
    return () => window.removeEventListener("scene24:frame-selection", h);
  }, [runFrameSelection]);

  // 캔버스 우클릭 메뉴 (Figma 식)
  const [ctxMenu, setCtxMenu] = React.useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    if (tool === "hand") return;
    e.preventDefault();
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    const hit = hitPath(e.clientX - oRect.left, e.clientY - oRect.top, false);
    const st = store.getState();
    if (hit && !st.selection.includes(hit)) st.select([hit]);
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool === "hand") return;
    const overlay = rootRef.current!;
    const oRect = overlay.getBoundingClientRect();
    const deep = hitPath(e.clientX - oRect.left, e.clientY - oRect.top, true);
    if (!deep) return;
    // Figma 식 2단계: 첫 더블클릭 = 깊은 선택만. 이미 그 요소가 선택된 상태에서
    // 다시 더블클릭하면 그때 텍스트 인라인 편집 진입. (이전엔 첫 더블클릭이 바로
    // 편집으로 들어가 "요소만 선택"이 cmd-클릭 없인 불가능했음 — 사용자 요청 반영)
    const st = store.getState();
    const alreadySelected = st.selection.length === 1 && st.selection[0] === deep;
    if (!alreadySelected) {
      st.select([deep]);
      return;
    }
    const el = doc ? getElement(doc, deep) : null;
    if (el?.element === "text") setEditingText(deep);
  };

  // --- 인라인 텍스트 편집 ---
  const [editingText, setEditingText] = React.useState<ElementPath | null>(null);

  // path → 엔진 DOM 노드 ([data-scene] 아래 data-el 인덱스 체인)
  const domNodeForPath = React.useCallback((path: ElementPath): HTMLElement | null => {
    const container = getPlayer()?.getContainerNode();
    const sceneNode = container ? activeSceneNode(container) : null;
    if (!sceneNode) return null;
    let scope: Element = sceneNode;
    let node: Element | null = null;
    for (const idx of parsePath(path).indices) {
      node = childDataEls(scope).find((k) => Number(k.getAttribute("data-el")) === idx) ?? null;
      if (!node) return null;
      scope = node;
    }
    return node as HTMLElement;
  }, []);

  // 편집 중엔 원본 글리프를 숨긴다(입력창과 겹침 방지). 엔진이 매 렌더마다
  // 인라인 style 을 다시 쓰므로 rAF 로 강제 유지, 종료 시 원복.
  React.useEffect(() => {
    if (!editingText) return;
    pause();
    let raf = 0;
    const tick = () => {
      const n = domNodeForPath(editingText);
      if (n && n.style.visibility !== "hidden") n.style.visibility = "hidden";
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      const n = domNodeForPath(editingText);
      if (n) n.style.visibility = "";
    };
  }, [editingText, domNodeForPath]);

  // 선택이 바뀌거나 요소가 사라지면 편집 종료.
  React.useEffect(() => {
    if (editingText && (!doc || !getElement(doc, editingText))) setEditingText(null);
  }, [editingText, doc]);

  // 텍스트 생성 직후 바로 타이핑 시작 (T 단축키/독 버튼이 쏘는 이벤트).
  // 측정(boxes)이 다음 프레임에 잡히므로 살짝 늦게 시작.
  React.useEffect(() => {
    const h = (e: Event) => {
      const path = (e as CustomEvent<{ path?: ElementPath }>).detail?.path;
      if (path) setTimeout(() => setEditingText(path), 60);
    };
    window.addEventListener("scene24:edit-text", h);
    return () => window.removeEventListener("scene24:edit-text", h);
  }, []);

  if (tool === "hand") {
    return <div ref={rootRef} className={s.overlay} style={{ pointerEvents: "none" }} />;
  }

  const selSet = new Set(selection);
  // 단일 비-그룹 선택 → 리사이즈/회전 핸들 표시
  const soloPath = selection.length === 1 ? selection[0] : null;
  const soloEl = soloPath && doc ? getElement(doc, soloPath) : null;
  const soloBox = soloPath ? boxes[soloPath] : null;
  const soloResizable = soloEl && !!soloBox && sizeParamsOf(soloEl) != null;
  const soloScaleOnly = soloEl?.element === "text" || soloEl?.element === "logo" || soloEl?.element === "group";
  // 회전 반영 박스 — AABB(측정) 로부터 회전 전 크기 역산 후 rotate(deg) 로 그림.
  const soloScale = getPlayer()?.getScale() ?? 1;
  const soloGeom =
    soloResizable && soloBox && soloEl
      ? (() => {
          const deg = ((soloEl as { base?: { rotate?: number } }).base?.rotate) ?? 0;
          const { w, h } = localSize(soloEl, soloBox, soloScale, deg);
          return { cx: soloBox.x + soloBox.w / 2, cy: soloBox.y + soloBox.h / 2, w0: w, h0: h, deg };
        })()
      : null;

  // Alt 거리 측정 — 요소 선택 + Alt held + 다른 요소 호버.
  const measurePair =
    !dragRef.current && altDown && soloBox && hovered && hovered !== soloPath && boxes[hovered]
      ? { a: soloBox, b: boxes[hovered] }
      : null;

  const cornerHandles: { h: Handle; cls: string; rot: string }[] = [
    { h: "tl", cls: s.hTL, rot: s.rotTL },
    { h: "tr", cls: s.hTR, rot: s.rotTR },
    { h: "bl", cls: s.hBL, rot: s.rotBL },
    { h: "br", cls: s.hBR, rot: s.rotBR },
  ];
  const edgeHandles: { h: Handle; cls: string }[] = [
    { h: "t", cls: s.hT },
    { h: "r", cls: s.hR },
    { h: "b", cls: s.hB },
    { h: "l", cls: s.hL },
  ];

  return (
    <div
      ref={rootRef}
      className={s.overlay}
      data-recording={recordKeyframes}
      style={tool === "frame" ? { cursor: "crosshair" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onPointerLeave={() => {
        if (!dragRef.current) store.getState().setHovered(null);
      }}
    >
      {/* 히트 확장 — 캔버스(콤프) 밖으로 나간 요소도 클릭/드래그되도록 오버레이
          이벤트 영역을 스테이지 전체로 넓힌다 (stage overflow:hidden 이 패널
          침범을 막는다). 좌표는 전부 오버레이 원점 기준 상대 계산이라 무영향. */}
      <div className={s.hitExtend} aria-hidden />
      {/* 우클릭 메뉴 (Figma 식) — 캔버스 줌/팬 transform 조상 안에선 position:fixed 가
          그 조상 기준으로 풀리므로 body 포털로 빼서 항상 커서 바로 오른쪽에 띄운다. */}
      {ctxMenu && createPortal((() => {
        const sel = store.getState().selection;
        const has = sel.length > 0;
        const canGroup = sel.length >= 2;
        // 단일 group 선택이면 Frame 전환 활성화
        const curDoc0 = store.getState().doc;
        const soleGroup = sel.length === 1 && !!curDoc0 && getElement(curDoc0, sel[0])?.element === "group";
        const soleKind = sel.length === 1 && curDoc0 ? getElement(curDoc0, sel[0])?.element : null;
        const solePreset = soleKind === "glow_card" || soleKind === "neon_pill";
        const close = () => setCtxMenu(null);
        // 주의: 포털이어도 React 이벤트는 오버레이(부모)로 버블된다. 메뉴 안의
        // pointerdown 이 오버레이 핸들러로 새면 selection 해제 + 포인터 캡처로
        // click 자체가 죽는다(메뉴 안 닫히고 실행도 안 되는 버그). 전파 차단 필수.
        const stop = (ev: React.SyntheticEvent) => ev.stopPropagation();
        // 액션보다 close 먼저 — 액션이 던져도 메뉴는 닫힌다.
        const run = (fn: () => void) => () => { close(); fn(); };
        return (
          <>
            <div
              className={s.ctxBackdrop}
              onPointerDown={(ev) => { ev.stopPropagation(); close(); }}
              onClick={stop}
              onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); close(); }}
            />
            <div
              className={s.ctxMenu}
              style={{ left: ctxMenu.x + 2, top: ctxMenu.y }}
              onPointerDown={stop}
              onPointerUp={stop}
              onDoubleClick={stop}
              onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); }}
            >
              <button className={s.ctxItem} disabled={!has} onClick={run(() => copyElements(sel))}>Copy <span className={s.ctxKey}>⌘C</span></button>
              <button className={s.ctxItem} onClick={run(() => pasteElements(activeScene))}>Paste <span className={s.ctxKey}>⌘V</span></button>
              <button className={s.ctxItem} disabled={!has} onClick={run(() => duplicateElements(sel))}>Duplicate <span className={s.ctxKey}>⌘D</span></button>
              <div className={s.ctxSep} />
              <button className={s.ctxItem} disabled={!has} onClick={run(() => reorderElements(sel, "front"))}>Bring to front <span className={s.ctxKey}>⌘]</span></button>
              <button className={s.ctxItem} disabled={!has} onClick={run(() => reorderElements(sel, "forward"))}>Bring forward <span className={s.ctxKey}>⌥⌘]</span></button>
              <button className={s.ctxItem} disabled={!has} onClick={run(() => reorderElements(sel, "backward"))}>Send backward <span className={s.ctxKey}>⌥⌘[</span></button>
              <button className={s.ctxItem} disabled={!has} onClick={run(() => reorderElements(sel, "back"))}>Send to back <span className={s.ctxKey}>⌘[</span></button>
              <div className={s.ctxSep} />
              <button className={s.ctxItem} disabled={!canGroup} onClick={run(() => groupElements(sel))}>Group selection <span className={s.ctxKey}>⌘G</span></button>
              <button className={s.ctxItem} disabled={!has} onClick={run(() => runFrameSelection())}>Frame selection <span className={s.ctxKey}>⌥⌘G</span></button>
              {soleGroup && <button className={s.ctxItem} onClick={run(() => convertGroupToFrame(sel[0]))}>Convert to Frame</button>}
              {solePreset && <button className={s.ctxItem} onClick={run(() => detachPresetElement(sel[0]))}>Detach to elements</button>}
              {sel.length === 1 && <button className={s.ctxItem} onClick={run(() => copyElementStyle(sel[0]))}>Copy style<span className={s.ctxKey}>⌥⌘C</span></button>}
              {sel.length >= 1 && hasStyleClipboard() && <button className={s.ctxItem} onClick={run(() => pasteElementStyle(sel))}>Paste style<span className={s.ctxKey}>⌥⌘V</span></button>}
              <div className={s.ctxSep} />
              <button className={s.ctxItem} data-danger disabled={!has} onClick={run(() => deleteElements(sel))}>Delete <span className={s.ctxKey}>⌫</span></button>
            </div>
          </>
        );
      })(), document.body)}

      {/* 인라인 텍스트 편집 — 요소 박스 위에 투명 입력창, 원본 글리프는 숨김 */}
      {/* 측정 박스 유무와 무관하게 편집 유지 — 빈 텍스트는 박스가 없는데,
          여기서 언마운트되면 캐럿이 사라지고 글자가 다시 생기는 순간 재마운트의
          autoFocus 가 포커스를 훔쳐 첫 글자를 덮어쓴다 (실측). */}
      {editingText && doc && (() => {
        const el = getElement(doc, editingText);
        if (el?.element !== "text") return null;
        const b = (el.base ?? {}) as {
          text?: string; fontSize?: number; fontWeight?: number; fontFamily?: string;
          color?: string; anchor?: string; letterSpacing?: number;
          position?: { x: number; y: number };
        };
        const sc = getPlayer()?.getScale() ?? 1;
        const fontPx = (Math.min(50, Math.max(0.5, b.fontSize ?? 4)) / 100) * COMP_W * sc;
        // 빈 텍스트는 엔진이 그릴 게 없어 측정 박스가 없다 — 스펙 위치에 캐럿
        // 크기의 박스를 합성해 textarea(=깜빡이는 캐럿)가 항상 뜨게 한다.
        // (없으면 box.x 에서 크래시 -> 오버레이 전체가 죽고, 복구 마운트의
        // autoFocus 가 인스펙터 타이핑 포커스를 뺏어 첫 글자를 덮어썼다 — 실측)
        const box =
          boxes[editingText] ??
          (() => {
            const pos = b.position ?? { x: 0.5, y: 0.5 };
            return {
              x: pos.x * COMP_W * sc - 1,
              y: pos.y * COMP_H * sc - fontPx * 0.55,
              w: 2,
              h: fontPx * 1.1,
            };
          })();
        // 세로 정렬 — 요소 박스는 이제 "폰트 메트릭 박스"(어센트+디센트, 내용
        // 무관)라서 textarea 는 half-leading 만 보정하면 글리프가 원래 자리에
        // 정확히 겹친다 (구 잉크 박스 시절의 어센트-잉크 차 보정을 남기면
        // 편집 진입 시 텍스트가 위로 뜬다 — 실측 리포트).
        const famE = b.fontFamily ?? doc.brandDefaults?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif";
        const mE = inkMetrics(b.text ?? "", famE, b.fontWeight ?? 500);
        const PAD_V = 2, PAD_H = 4;
        // 라인박스(1.1em) top → 폰트 박스 top 오프셋 (half-leading)
        const inkLead = mE
          ? ((1.1 - (mE.fbAsc + mE.fbDesc)) / 2) * fontPx
          : 0.05 * fontPx;
        const commit = () => {
          store.getState().endCoalescing();
          setEditingText(null);
        };
        return (
          <div
            key={editingText}
            className={s.inlineTextEditWrap}
            style={{
              left: box.x - PAD_H - 1,
              top: box.y - PAD_V - 1,
              width: Math.max(box.w + (PAD_H + 1) * 2, 14),
              height: box.h + (PAD_V + 1) * 2,
            }}
            onPointerDown={(ev) => ev.stopPropagation()}
            onDoubleClick={(ev) => ev.stopPropagation()}
            onContextMenu={(ev) => ev.stopPropagation()}
          >
            <textarea
              className={s.inlineTextEdit}
              style={{
                marginTop: PAD_V - inkLead,
                height: 1.1 * fontPx + Math.abs(inkLead) + PAD_V * 2,
                fontSize: fontPx,
                fontWeight: b.fontWeight ?? 500,
                fontFamily: famE,
                letterSpacing: b.letterSpacing ? `${b.letterSpacing}em` : undefined,
                color: b.color ?? "#FFFFFF",
                caretColor: b.color ?? "#FFFFFF",
                textAlign: b.anchor === "left" ? "left" : "center",
                padding: `0 ${PAD_H}px`,
              }}
              value={b.text ?? ""}
              autoFocus
              spellCheck={false}
              onFocus={(ev) => ev.currentTarget.select()}
              onChange={(ev) => {
                const v = ev.target.value;
                store.getState().updateDoc(
                  "Edit text",
                  (d) => {
                    const t = getElement(d, editingText);
                    if (t?.element === "text") (t.base as { text?: string }).text = v;
                  },
                  { coalesceKey: "inline-text-edit" },
                );
              }}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key === "Escape" || (ev.key === "Enter" && !ev.shiftKey)) {
                  ev.preventDefault();
                  commit();
                }
              }}
              onBlur={commit}
            />
          </div>
        );
      })()}

      {/* record 모드 경고 — 빨간 테두리 + REC 배지 (실수로 키 찍힘 방지 인지) */}
      {recordKeyframes && (
        <>
          <div className={s.recFrame} />
          <div className={s.recBadge}>● REC · drag to keyframe</div>
        </>
      )}

      {/* 호버 아웃라인 */}
      {hovered && !selSet.has(hovered) && boxes[hovered] && (
        <div
          className={s.hoverOutline}
          style={{ left: boxes[hovered].x, top: boxes[hovered].y, width: boxes[hovered].w, height: boxes[hovered].h }}
        />
      )}

      {/* 선택 아웃라인 (시각) — solo(리사이즈 대상) 는 회전 박스로 따로 그림 */}
      {selection.map((p) => {
        if (soloGeom && p === soloPath) return null;
        const b = boxes[p];
        if (!b) return null;
        const grp = doc ? isGroup(getElement(doc, p)) : false;
        const el = doc ? getElement(doc, p) : null;
        return (
          <div key={p} className={grp ? s.selOutlineGroup : s.selOutline} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
            {el && <span className={s.selLabel}>{elementLabel(el)}</span>}
          </div>
        );
      })}

      {/* solo 회전 아웃라인 (박스 자체가 요소 회전을 따라 돎 — Figma/AE 식) */}
      {soloGeom && soloPath && (
        <div
          className={s.selOutline}
          style={{
            left: soloGeom.cx - soloGeom.w0 / 2,
            top: soloGeom.cy - soloGeom.h0 / 2,
            width: soloGeom.w0,
            height: soloGeom.h0,
            transform: `rotate(${soloGeom.deg}deg)`,
            transformOrigin: "center",
          }}
        />
      )}
      {/* 라벨은 회전 안 함 — AABB 상단에 고정(가독성) */}
      {soloGeom && soloPath && soloEl && soloBox && (
        <span className={s.selLabel} style={{ left: soloBox.x, top: soloBox.y - 20 }}>
          {elementLabel(soloEl)}
        </span>
      )}

      {/* 조작 핸들 (단일 비-그룹 선택) — 회전 박스를 따라 돎 */}
      {soloGeom && soloPath && (
        <div
          className={s.handleLayer}
          style={{
            left: soloGeom.cx - soloGeom.w0 / 2,
            top: soloGeom.cy - soloGeom.h0 / 2,
            width: soloGeom.w0,
            height: soloGeom.h0,
            transform: `rotate(${soloGeom.deg}deg)`,
            transformOrigin: "center",
          }}
        >
          {/* 회전 히트존 — 코너 바깥 */}
          {cornerHandles.map(({ h, rot }) => (
            <span
              key={`rot-${h}`}
              className={`${s.rotZone} ${rot}`}
              onPointerDown={(e) => startRotate(e, soloPath)}
            />
          ))}
          {/* 코너 리사이즈 */}
          {cornerHandles.map(({ h, cls }) => (
            <span
              key={h}
              className={`${s.handle} ${cls}`}
              onPointerDown={(e) => startResize(e, h, soloPath)}
            />
          ))}
          {/* 변(엣지) 리사이즈 — 도형만(텍스트/로고는 균일 스케일이라 코너만) */}
          {!soloScaleOnly &&
            edgeHandles.map(({ h, cls }) => (
              <span
                key={h}
                className={`${s.handle} ${cls}`}
                onPointerDown={(e) => startResize(e, h, soloPath)}
              />
            ))}
        </div>
      )}

      {/* 마퀴 */}
      {marquee && (
        <div className={s.marquee} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}

      {/* 스마트 가이드 (px) */}
      {guides.vx.map((vx, i) => (
        <div key={`v${i}`} className={s.guideV} style={{ left: vx }} />
      ))}
      {guides.hy.map((hy, i) => (
        <div key={`h${i}`} className={s.guideH} style={{ top: hy }} />
      ))}

      {/* Alt 거리 측정 */}
      {measurePair && <MeasureBadges a={measurePair.a} b={measurePair.b} scale={getPlayer()?.getScale() ?? 1} />}

      {/* 치수/각도 HUD */}
      {hud && (
        <div className={s.hud} style={{ left: hud.x, top: hud.y }}>
          {hud.text}
        </div>
      )}
    </div>
  );
}

// 두 박스 사이 수평/수직 간격을 빨간 라인+라벨로. comp px 로 환산.
function MeasureBadges({ a, b, scale }: { a: Box; b: Box; scale: number }) {
  const items: React.ReactNode[] = [];
  const toComp = (px: number) => Math.round(px / scale);
  const ay0 = a.y,
    ay1 = a.y + a.h,
    by0 = b.y,
    by1 = b.y + b.h;
  const ax0 = a.x,
    ax1 = a.x + a.w,
    bx0 = b.x,
    bx1 = b.x + b.w;

  // 수평 간격 (x축으로 떨어져 있으면)
  if (bx0 > ax1 || bx1 < ax0) {
    const gap = bx0 > ax1 ? bx0 - ax1 : ax0 - bx1;
    const xL = bx0 > ax1 ? ax1 : bx1;
    const yMid = (Math.max(ay0, by0) + Math.min(ay1, by1)) / 2;
    const yy = Number.isFinite(yMid) ? yMid : (a.y + a.h / 2);
    items.push(<div key="hL" className={s.measureLine} style={{ left: xL, top: yy - 0.5, width: gap, height: 1 }} />);
    items.push(<div key="hLbl" className={s.measureLabel} style={{ left: xL + gap / 2, top: yy }}>{toComp(gap)}</div>);
  }
  // 수직 간격
  if (by0 > ay1 || by1 < ay0) {
    const gap = by0 > ay1 ? by0 - ay1 : ay0 - by1;
    const yT = by0 > ay1 ? ay1 : by1;
    const xMid = (Math.max(ax0, bx0) + Math.min(ax1, bx1)) / 2;
    const xx = Number.isFinite(xMid) ? xMid : (a.x + a.w / 2);
    items.push(<div key="vL" className={s.measureLine} style={{ left: xx - 0.5, top: yT, width: 1, height: gap }} />);
    items.push(<div key="vLbl" className={s.measureLabel} style={{ left: xx, top: yT + gap / 2 }}>{toComp(gap)}</div>);
  }
  return <>{items}</>;
}
