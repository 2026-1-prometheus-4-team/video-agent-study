// elementKeyframes.ts — 요소 속성 키프레임 편집 헬퍼 (camera.ts 의 요소판).
// 타임라인 채널 lane + 인스펙터 스톱워치 + 캔버스 record 공용. 전부 store.updateDoc 경유.
//
// 설계:
//  - 엔진 sampleElementKeyframes 는 채널별 독립 보간(한 키가 정의한 채널만 그 채널에
//    기여). 그래서 에디터는 "단일 채널 엔트리"로만 쓴다 → 채널 lane 에서 X 키를
//    Y 와 독립으로 드래그 가능. 같은 프레임의 다른 채널은 그냥 별도 엔트리.
//  - 배열은 에디터에서 정렬하지 않는다(push/splice 만) → 배열 인덱스가 안정적이라
//    카메라의 "정렬 후 재선택" 로직이 불필요. 정렬은 엔진 샘플/타임라인 렌더 시점에만.
//  - 값 캡처(add/arm 시 현재 보간값): x/y 는 base.position 폴백, 나머지는 IDENTITY.

"use client";

import { useEditor } from "./store";
import { sampleElementKeyframes, type ElementKeyframe } from "@engine/motion/keyframes";
import { getElement, type ElementPath } from "./specPath";
import { pause } from "./playerBridge";

export type KfChannel = "x" | "y" | "scale" | "rotate" | "opacity" | "blur" | "rotateX" | "rotateY" | "progress" | "w" | "h" | "z" | "color";
export const KF_CHANNELS: KfChannel[] = ["x", "y", "scale", "rotate", "opacity", "blur", "rotateX", "rotateY", "progress", "w", "h", "z", "color"];
/** 요소별 사용 가능한 채널. progress 는 경로가 붙은 요소에서만 의미가 있다:
 *  motionPath(모든 요소 공통 — AE paste path to position 등가) 또는
 *  그룹 layout(path/orbit). 그룹은 그 외 채널 미지원. */
export function channelsForElement(el: { element?: string; layout?: { type?: string }; motionPath?: unknown } | null | undefined): KfChannel[] {
  const hasPath = !!el?.motionPath || el?.layout?.type === "path" || el?.layout?.type === "orbit";
  // 그룹도 공통 transform 채널 전부 + opacity (엔진 FrameGroup 이 gch.opacity 로
  // 소비 — SceneRenderer 참조) + 경로 있으면 progress
  if (el?.element === "group") {
    const base: KfChannel[] = ["x", "y", "scale", "rotate", "rotateX", "rotateY", "z", "opacity", "blur"];
    return hasPath ? [...base, "progress"] : base;
  }
  // preset element (neon_pill/glow_card/glow_menu) — presetTransform 이 소비하는
  // 채널만 (x/y/scale/rotate/opacity/blur). 3D/w/h/progress 는 엔진이 안 읽는다.
  if (el?.element === "neon_pill" || el?.element === "glow_card" || el?.element === "glow_menu") {
    return ["x", "y", "scale", "rotate", "rotateX", "rotateY", "opacity", "blur"];
  }
  // edge_light — 스침광 위치가 progress 채널 (한 바퀴 = +1, 랩 키로 회전)
  if (el?.element === "edge_light") {
    return ["x", "y", "scale", "rotate", "rotateX", "rotateY", "opacity", "blur", "progress"];
  }
  let chans = hasPath ? KF_CHANNELS : KF_CHANNELS.filter((c) => c !== "progress");
  // color 채널은 텍스트만 (엔진 ComposedText 가 baseColor 오버라이드로 소비)
  if (el?.element !== "text") chans = chans.filter((c) => c !== "color");
  // gooey 위치는 base.fromShape 전용 — 엔진이 kf.x/y 를 소비하지 않는다 (감사 #18).
  if (el?.element === "gooey") chans = chans.filter((c) => c !== "x" && c !== "y");
  // logo 는 blur 채널 미소비 (ComposedLogo 는 blur 합성 경로 없음)
  if (el?.element === "logo") chans = chans.filter((c) => c !== "blur");
  // w/h 채널은 엔진이 frame 에서만 소비 (FrameBox kf.w/kf.h).
  if (el?.element !== "frame") chans = chans.filter((c) => c !== "w" && c !== "h");
  return chans;
}

// 채널별 라벨 + 다이아몬드 색 (타임라인 lane / 인스펙터 스톱워치 공용).
export const CHANNEL_META: Record<KfChannel, { label: string; short: string; color: string }> = {
  x: { label: "X position", short: "X", color: "#F87171" },
  y: { label: "Y position", short: "Y", color: "#FB923C" },
  scale: { label: "Scale", short: "S", color: "#34D399" },
  rotate: { label: "Rotation", short: "R", color: "#60A5FA" },
  opacity: { label: "Opacity", short: "O", color: "#C084FC" },
  blur: { label: "Blur", short: "B", color: "#22D3EE" },
  rotateX: { label: "3D tilt X", short: "TX", color: "#2DD4BF" },
  rotateY: { label: "3D pan Y", short: "PY", color: "#FBBF24" },
  progress: { label: "Path progress", short: "PG", color: "#F472B6" },
  w: { label: "Width", short: "W", color: "#38BDF8" },
  h: { label: "Height", short: "H", color: "#818CF8" },
  z: { label: "Depth Z", short: "Z", color: "#A3E635" },
  color: { label: "Color", short: "C", color: "#F9A8D4" },
};


/** 채널 값 존재 판정 — color 는 string, 나머지는 number. */
export function hasChanValue(k: Record<string, unknown>, c: KfChannel): boolean {
  return c === "color" ? typeof k[c] === "string" : typeof k[c] === "number";
}

function store() {
  return useEditor.getState();
}

type LeafWithKf = {
  element: string;
  base?: { position?: { x: number; y: number }; rotateX?: number; rotateY?: number };
  keyframes?: ElementKeyframe[];
};

export function getElementKeyframes(el: unknown): ElementKeyframe[] {
  const kfs = (el as LeafWithKf | null)?.keyframes;
  return Array.isArray(kfs) ? kfs : [];
}

/** 채널 c 를 정의한 엔트리들 {kf, index} (원배열 인덱스 포함, 프레임순 정렬). */
export function channelKeys(
  el: unknown,
  c: KfChannel,
): { kf: ElementKeyframe; index: number }[] {
  const kfs = getElementKeyframes(el);
  return kfs
    .map((kf, index) => ({ kf, index }))
    .filter(({ kf }) => hasChanValue(kf as unknown as Record<string, unknown>, c))
    .sort((a, b) => a.kf.frame - b.kf.frame);
}

/** 요소가 채널 c 를 애니메이트 중인가(스톱워치 켜짐). */
export function isChannelArmed(el: unknown, c: KfChannel): boolean {
  return channelKeys(el, c).length > 0;
}

// 현재 프레임의 채널 값(보간). x/y 는 base.position 폴백.
function sampledChannel(el: LeafWithKf, c: KfChannel, frame: number): number {
  const s = sampleElementKeyframes(el.keyframes, frame);
  const pos = el.base?.position ?? { x: 0.5, y: 0.5 };
  if (c === "x") return s.x ?? pos.x;
  if (c === "y") return s.y ?? pos.y;
  if (c === "rotateX") return s.rotateX ?? el.base?.rotateX ?? 0;
  if (c === "rotateY") return s.rotateY ?? el.base?.rotateY ?? 0;
  if (c === "progress") return s.progress ?? 0;
  if (c === "w") return s.w ?? (el.base as { width?: number } | undefined)?.width ?? 40;
  if (c === "h") return s.h ?? (el.base as { height?: number } | undefined)?.height ?? 30;
  if (c === "z") return s.z ?? (el.base as { z?: number } | undefined)?.z ?? 0;
  return s[c] as number;
}

function round(c: KfChannel, v: number): number {
  // 위치/스케일/투명도는 소수 4자리, 각도는 2자리.
  return Number(v.toFixed(c === "rotate" || c === "rotateX" || c === "rotateY" ? 2 : 4));
}

/** el.keyframes 안전 확보(draft 용). */
function ensureKf(el: LeafWithKf): ElementKeyframe[] {
  if (!Array.isArray(el.keyframes)) el.keyframes = [];
  return el.keyframes;
}

/**
 * 채널 c 의 프레임에 키 upsert(현재 보간값 캡처 → 튀지 않음). 단일 채널 엔트리.
 * 반환: 그 엔트리의 배열 인덱스.
 */
export function addElementKeyframeAt(path: ElementPath, c: KfChannel, localFrame: number): number {
  pause(); // AE 식 — 재생 중 키 편집이면 즉시 정지
  const el = store().doc ? (getElement(store().doc!, path) as LeafWithKf | null) : null;
  // 그룹은 progress(경로 진행) 채널만 키프레임 가능.
  if (!el) return -1;
  const frame = Math.max(0, Math.round(localFrame));
  // color 는 문자열 채널 — 현재 보간색(키 없으면 base.color) 캡처
  const value: number | string =
    c === "color"
      ? (sampleElementKeyframes(el.keyframes, frame).color ?? ((el.base as { color?: string } | undefined)?.color ?? "#FFFFFF"))
      : round(c, sampledChannel(el, c, frame));
  store().updateDoc("Add keyframe", (draft) => {
    const d = getElement(draft, path) as LeafWithKf | null;
    if (!d) return;
    const kfs = ensureKf(d);
    // 같은 채널+프레임 엔트리가 있으면 갱신, 없으면 새 단일 채널 엔트리.
    const dup = kfs.findIndex((k) => k.frame === frame && hasChanValue(k as unknown as Record<string, unknown>, c));
    if (dup >= 0) (kfs[dup] as Record<string, unknown>)[c] = value;
    else kfs.push({ frame, [c]: value, easing: "easeInOut" } as unknown as ElementKeyframe);
  });
  return channelKeyIndexAt(path, c, frame);
}


/** color 채널 키 upsert — 값이 hex 문자열이라 숫자 upsert 와 분리. */
export function upsertColorKey(path: ElementPath, localFrame: number, hex: string, live: boolean) {
  const frame = Math.max(0, Math.round(localFrame));
  store().updateDoc(
    "Color keyframe",
    (draft) => {
      const d = getElement(draft, path) as LeafWithKf | null;
      if (!d) return;
      const kfs = ensureKf(d);
      const dup = kfs.findIndex((k) => k.frame === frame && typeof (k as { color?: string }).color === "string");
      if (dup >= 0) (kfs[dup] as { color?: string }).color = hex;
      else kfs.push({ frame, color: hex, easing: "easeInOut" } as unknown as ElementKeyframe);
    },
    { coalesceKey: live ? `el-kf-${path}-color-${frame}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 스톱워치 켜기 = 채널이 아직 없으면 현재 프레임에 첫 키 생성. */
export function armChannel(path: ElementPath, c: KfChannel, localFrame: number): number {
  const el = store().doc ? (getElement(store().doc!, path) as LeafWithKf | null) : null;
  if (!el) return -1;
  if (isChannelArmed(el, c)) return channelKeys(el, c)[0]?.index ?? -1;
  return addElementKeyframeAt(path, c, localFrame);
}

/** 채널 루프(AE loopOut) 설정 — 그 채널의 "마지막 키"에 loop 를 선언한다. */
export function setChannelLoop(path: ElementPath, c: KfChannel, mode?: string) {
  store().updateDoc("Channel loop", (draft) => {
    const d = getElement(draft, path) as LeafWithKf | null;
    if (!d || !Array.isArray(d.keyframes)) return;
    const pts = d.keyframes
      .filter((k) => hasChanValue(k as unknown as Record<string, unknown>, c))
      .sort((a, b) => a.frame - b.frame);
    if (!pts.length) return;
    for (const k of pts) delete k.loop;
    if (mode) pts[pts.length - 1].loop = mode as "cycle" | "pingpong" | "continue";
  });
}

/** 스톱워치 끄기 = 그 채널 값을 모든 엔트리에서 제거. 빈 엔트리(frame 만) 정리.
 *  bakeFrame 을 주면 AE 처럼 "끄는 순간의 보간값"을 base 정적 값으로 구워
 *  화면이 튀지 않는다 (Time-Vary 스톱워치 OFF 시멘틱). */
export function disarmChannel(path: ElementPath, c: KfChannel, bakeFrame?: number) {
  store().updateDoc("Remove keyframes", (draft) => {
    const d = getElement(draft, path) as LeafWithKf | null;
    if (!d || !Array.isArray(d.keyframes)) return;
    if (bakeFrame != null) {
      const s = sampleElementKeyframes(d.keyframes, Math.max(0, Math.round(bakeFrame)));
      if (!d.base) (d as { base?: unknown }).base = {};
      const base = d.base as Record<string, unknown> & { position?: { x: number; y: number } };
      // base.opacity 는 엔진이 소비하는 타입만 (텍스트/로고는 base.opacity 미소비)
      const opacityCapable = ["shape", "image", "video", "frame", "group"].includes(d.element);
      if (c === "x" && s.x != null) base.position = { ...(base.position ?? { x: 0.5, y: 0.5 }), x: round("x", s.x) };
      else if (c === "y" && s.y != null) base.position = { ...(base.position ?? { x: 0.5, y: 0.5 }), y: round("y", s.y) };
      else if (c === "scale") base.scale = round("scale", ((base.scale as number | undefined) ?? 1) * s.scale);
      else if (c === "rotate") base.rotate = round("rotate", ((base.rotate as number | undefined) ?? 0) + s.rotate);
      else if (c === "opacity" && opacityCapable) base.opacity = round("opacity", ((base.opacity as number | undefined) ?? 1) * s.opacity);
      else if (c === "blur") base.blur = round("blur", ((base.blur as number | undefined) ?? 0) + s.blur);
      else if (c === "rotateX" && s.rotateX != null) base.rotateX = round("rotateX", s.rotateX);
      else if (c === "rotateY" && s.rotateY != null) base.rotateY = round("rotateY", s.rotateY);
      else if (c === "z" && s.z != null) base.z = round("z", s.z);
      else if (c === "w" && s.w != null) (base as { width?: number }).width = round("w", s.w);
      else if (c === "h" && s.h != null) (base as { height?: number }).height = round("h", s.h);
      else if (c === "color" && s.color != null && d.element === "text") (base as { color?: string }).color = s.color;
      // progress 는 base 대응 없음 — bake 생략
    }
    for (const kf of d.keyframes) delete kf[c];
    d.keyframes = d.keyframes.filter(
      (kf) => typeof kf.x === "number" || typeof kf.y === "number" || typeof kf.scale === "number" || typeof kf.rotate === "number" || typeof kf.opacity === "number" || typeof kf.blur === "number" || typeof kf.z === "number" || typeof kf.rotateX === "number" || typeof kf.rotateY === "number" || typeof kf.progress === "number" || typeof (kf as { w?: number }).w === "number" || typeof (kf as { h?: number }).h === "number" || typeof (kf as { color?: string }).color === "string",
    );
    if (d.keyframes.length === 0) delete d.keyframes;
  });
  clearSelIfChannel(path, c);
}

/**
 * 인스펙터에서 armed 채널 값 편집 → 현재 프레임에 upsert(캡처 아닌 지정값).
 * live 면 coalesce.
 */
export function upsertChannelKey(
  path: ElementPath,
  c: KfChannel,
  localFrame: number,
  value: number,
  live: boolean,
) {
  pause(); // AE 식 — 재생 중 값 편집이면 즉시 정지
  const frame = Math.max(0, Math.round(localFrame));
  const v = round(c, value);
  store().updateDoc(
    "Edit keyframe",
    (draft) => {
      const d = getElement(draft, path) as LeafWithKf | null;
      if (!d) return;
      const kfs = ensureKf(d);
      const dup = kfs.findIndex((k) => k.frame === frame && hasChanValue(k as unknown as Record<string, unknown>, c));
      if (dup >= 0) (kfs[dup] as Record<string, unknown>)[c] = v;
      else kfs.push({ frame, [c]: v, easing: "easeInOut" });
    },
    { coalesceKey: live ? `el-kf-${path}-${c}-${frame}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/**
 * 캔버스 record: 현재 프레임의 각 채널 값에 델타 적용해 upsert(움직인 축만).
 * dx/dy = 위치 fraction 델타, dRotate = 각도 델타, scaleMul = 스케일 배수(누적 곱).
 */
export function applyElementDelta(
  path: ElementPath,
  localFrame: number,
  delta: { x?: number; y?: number; rotate?: number; scaleMul?: number },
  live: boolean,
) {
  pause(); // AE 식 — 재생 중 캔버스 조작이면 즉시 정지
  const el = store().doc ? (getElement(store().doc!, path) as LeafWithKf | null) : null;
  if (!el) return; // 그룹도 x/y/rotate/scale 채널을 가진다 (FrameGroup 소비)
  const frame = Math.max(0, Math.round(localFrame));
  const writes: [KfChannel, number][] = [];
  if (delta.x !== undefined) writes.push(["x", delta.x]);
  if (delta.y !== undefined) writes.push(["y", delta.y]);
  if (delta.rotate !== undefined) writes.push(["rotate", delta.rotate]);
  if (delta.scaleMul !== undefined) writes.push(["scale", delta.scaleMul]);
  if (writes.length === 0) return;
  store().updateDoc(
    "Record keyframe",
    (draft) => {
      const d = getElement(draft, path) as LeafWithKf | null;
      if (!d) return;
      const kfs = ensureKf(d);
      for (const [c, val] of writes) {
        const v = round(c, val);
        const dup = kfs.findIndex((k) => k.frame === frame && hasChanValue(k as unknown as Record<string, unknown>, c));
        if (dup >= 0) {
          (kfs[dup] as Record<string, unknown>)[c] = v;
          continue;
        }
        // 변화 없는 채널엔 새 키를 만들지 않는다 — 현재 보간값과 같으면
        // 이 프레임에 키를 찍어도 모션이 안 바뀌고 쓸데없는 키만 쌓인다
        // (실측: REC 드래그에서 안 움직인 축까지 키가 찍히던 문제).
        if (v === round(c, sampledChannel(d, c, frame))) continue;
        kfs.push({ frame, [c]: v, easing: "easeInOut" });
      }
    },
    { coalesceKey: live ? `el-rec-${path}-${frame}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 키 프레임 이동(드래그). 정렬 안 함 → 배열 인덱스 안정. */
export function moveElementKeyframe(path: ElementPath, kfIndex: number, newFrame: number, live: boolean) {
  const frame = Math.max(0, Math.round(newFrame));
  store().updateDoc(
    "Move keyframe",
    (draft) => {
      const d = getElement(draft, path) as LeafWithKf | null;
      if (!d || !Array.isArray(d.keyframes)) return;
      const kf = d.keyframes[kfIndex];
      if (kf) kf.frame = frame;
    },
    { coalesceKey: live ? `el-kf-move-${path}-${kfIndex}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 여러 키프레임 통째 이동 (AE 다중 선택 드래그) — 드래그 시작 스냅샷
 *  (frame0) + delta 로 매 move 마다 절대 계산 (누적 오차/이중 이동 방지).
 *  요소별 씬 길이 클램프는 호출부가 df 를 이미 제한했다고 가정하고 0 만 막는다. */
export function moveElementKeyframesBulk(
  entries: { path: ElementPath; kfIndex: number; frame0: number }[],
  df: number,
  live: boolean,
) {
  store().updateDoc(
    "Move keyframes",
    (draft) => {
      for (const en of entries) {
        const d = getElement(draft, en.path) as LeafWithKf | null;
        if (!d || !Array.isArray(d.keyframes)) continue;
        const kf = d.keyframes[en.kfIndex];
        if (kf) kf.frame = Math.max(0, Math.round(en.frame0 + df));
      }
    },
    { coalesceKey: live ? "el-kf-bulk-move" : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 한 엔트리(다이아몬드) 삭제. */
export function deleteElementKeyframe(path: ElementPath, kfIndex: number) {
  store().updateDoc("Delete keyframe", (draft) => {
    const d = getElement(draft, path) as LeafWithKf | null;
    if (!d || !Array.isArray(d.keyframes)) return;
    d.keyframes.splice(kfIndex, 1);
    if (d.keyframes.length === 0) delete d.keyframes;
  });
  useEditor.setState((st) => ({ ui: { ...st.ui, selectedElKeyframe: null } }));
}

/** 여러 키프레임 삭제 (다중 선택 우클릭) — path 별로 내림차순 splice (인덱스 안정). */
export function deleteElementKeyframesBulk(entries: { path: ElementPath; kfIndex: number }[]) {
  store().updateDoc("Delete keyframes", (draft) => {
    const byPath = new Map<string, number[]>();
    for (const en of entries) {
      if (!byPath.has(en.path)) byPath.set(en.path, []);
      byPath.get(en.path)!.push(en.kfIndex);
    }
    for (const [p, idxs] of byPath) {
      const d = getElement(draft, p) as LeafWithKf | null;
      if (!d || !Array.isArray(d.keyframes)) continue;
      for (const i of [...idxs].sort((a, b) => b - a)) d.keyframes.splice(i, 1);
      if (d.keyframes.length === 0) delete d.keyframes;
    }
  });
  useEditor.setState((st) => ({ ui: { ...st.ui, kfMultiSel: [], selectedElKeyframe: null } }));
}

/** 키프레임 한 채널 값 편집(패널 인라인). live 면 스크럽 중 히스토리 합침. */
export function setElementKeyframeValue(
  path: ElementPath,
  kfIndex: number,
  channel: KfChannel,
  value: number,
  live: boolean,
) {
  store().updateDoc(
    "Edit keyframe value",
    (draft) => {
      const d = getElement(draft, path) as LeafWithKf | null;
      if (!d || !Array.isArray(d.keyframes)) return;
      const kf = d.keyframes[kfIndex] as Record<string, unknown> | undefined;
      if (kf) kf[channel] = value;
    },
    { coalesceKey: live ? `el-kf-val-${path}-${kfIndex}-${channel}` : undefined },
  );
  if (!live) store().endCoalescing();
}

/** 키프레임 한 필드(예: easing) 수정. */
export function updateElementKeyframe(
  path: ElementPath,
  kfIndex: number,
  patch: Partial<ElementKeyframe>,
) {
  store().updateDoc("Edit keyframe", (draft) => {
    const d = getElement(draft, path) as LeafWithKf | null;
    if (!d || !Array.isArray(d.keyframes)) return;
    const kf = d.keyframes[kfIndex];
    if (kf) Object.assign(kf, patch);
  });
}

export function selectElementKeyframe(path: ElementPath, channel: KfChannel, kfIndex: number) {
  // 키프레임 선택 = 그 키를 가진 요소도 선택 — 캔버스 오버레이/인스펙터가
  // 어떤 요소의 키인지 즉시 보여준다 (사용자 요구: 트랙/캔버스 동기 선택).
  const st0 = useEditor.getState();
  if (st0.selection.length !== 1 || st0.selection[0] !== path) st0.select([path]);
  useEditor.setState((st) => ({ ui: { ...st.ui, selectedElKeyframe: { path, channel, kfIndex } } }));
}

// --- helpers ---
function channelKeyIndexAt(path: ElementPath, c: KfChannel, frame: number): number {
  const el = store().doc ? getElement(store().doc!, path) : null;
  const kfs = getElementKeyframes(el);
  return kfs.findIndex((k) => k.frame === frame && hasChanValue(k as unknown as Record<string, unknown>, c));
}

function clearSelIfChannel(path: ElementPath, c: KfChannel) {
  const sel = store().ui.selectedElKeyframe;
  if (sel && sel.path === path && sel.channel === c) {
    useEditor.setState((st) => ({ ui: { ...st.ui, selectedElKeyframe: null } }));
  }
}
