// wrappers/index.ts
// Type A wrapper registry + channel composer. Each wrapper is a pure
// function (localFrame, props, ctx, role, window) -> Partial<Channels>.
// Channels (TEXT_MOTION_SPEC 0.1):
//   x, y       : px, summed across layers
//   scale      : multiplied
//   rotate     : deg, summed
//   opacity    : multiplied
//   blur       : px, summed
// Final element style is assembled by the caller:
//   transform = translate(x,y) rotate(r) scale(s)
//   filter    = blur(b)
//   opacity   = opacity
//
// Atoms self-register: each *.ts file in this folder is scanned at build
// time via require.context. A file participates by exporting `name`,
// `fn`, and `labPreset`. Files without `name` are silently skipped (so
// shared utilities can live in the folder without polluting the registry).

import { type Role, type TimedLayer } from "../core/timing";

export type Channels = {
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
  blur: number;
  // 3D Y축 회전(deg). rotateY != 0 이면 channelsToCss 가 perspective 를 자동으로 건다.
  rotateY: number;
  // Element-fraction transform-origin (0..1, default 0.5). Wrappers that
  // want to pivot scale/rotate off-center (e.g. zoom_cut's focal point)
  // emit these; otherwise the element scales about its centre.
  originX: number;
  originY: number;
  // 소프트 마스크 스윕 (masked_reveal) — 그라디언트 마스크가 요소를 쓸며
  // 드러낸다/가린다. progress 0(전부 가림)..1(전부 보임), feather 는 요소 폭
  // 대비 부드러운 경계 폭, dir 1 = 왼->오. undefined = 마스크 없음.
  maskProgress?: number;
  maskFeather?: number;
  maskDir?: number;
};

export type WrapperCtx = {
  width: number;
  height: number;
  fps: number;
};

export type WrapperFn = (
  localFrame: number,
  props: Record<string, unknown>,
  ctx: WrapperCtx,
  role: Role,
  window: number,
) => Partial<Channels>;

export type LabPreset = {
  role: "in" | "hold" | "out" | "afterIn";
  props: Record<string, unknown>;
};

export type IntrinsicDurationFn = (
  props: Record<string, unknown>,
  ctx: { fps: number; unitCount: number },
) => number;

type WrapperAtomModule = {
  name?: unknown;
  fn?: unknown;
  labPreset?: unknown;
  intrinsicDuration?: unknown;
};

function buildRegistry(): {
  fns: Record<string, WrapperFn>;
  presets: Record<string, LabPreset>;
  intrinsic: Record<string, IntrinsicDurationFn>;
} {
  const fns: Record<string, WrapperFn> = {};
  const presets: Record<string, LabPreset> = {};
  const intrinsic: Record<string, IntrinsicDurationFn> = {};
  const ctx = require.context("./", false, /^\.\/(?!index).*\.ts$/);
  for (const key of ctx.keys()) {
    const mod = ctx(key) as WrapperAtomModule;
    if (typeof mod.name !== "string") continue;
    if (typeof mod.fn !== "function") continue;
    fns[mod.name] = mod.fn as WrapperFn;
    if (mod.labPreset && typeof mod.labPreset === "object") {
      presets[mod.name] = mod.labPreset as LabPreset;
    }
    if (typeof mod.intrinsicDuration === "function") {
      intrinsic[mod.name] = mod.intrinsicDuration as IntrinsicDurationFn;
    }
  }
  return { fns, presets, intrinsic };
}

const REGISTRY = buildRegistry();

export const WRAPPERS: Record<string, WrapperFn> = REGISTRY.fns;
export const WRAPPER_LAB_PRESETS: Record<string, LabPreset> = REGISTRY.presets;
export const WRAPPER_INTRINSIC: Record<string, IntrinsicDurationFn> = REGISTRY.intrinsic;

const IDENTITY: Channels = {
  x: 0,
  y: 0,
  scale: 1,
  rotate: 0,
  opacity: 1,
  blur: 0,
  rotateY: 0,
  originX: 0.5,
  originY: 0.5,
};

export function composeChannels(
  layers: TimedLayer[],
  frame: number,
  ctx: WrapperCtx,
): Channels {
  const out: Channels = { ...IDENTITY };
  for (const layer of layers) {
    const fn = WRAPPERS[layer.type];
    if (!fn) continue;
    const local = frame - layer.startFrame;
    if (local < 0) continue;
    const c = fn(local, layer.props ?? {}, ctx, layer.role, layer.window);
    if (typeof c.x === "number") out.x += c.x;
    if (typeof c.y === "number") out.y += c.y;
    if (typeof c.scale === "number") out.scale *= c.scale;
    if (typeof c.rotate === "number") out.rotate += c.rotate;
    if (typeof c.opacity === "number") out.opacity *= c.opacity;
    if (typeof c.blur === "number") out.blur += c.blur;
    if (typeof c.rotateY === "number") out.rotateY += c.rotateY;
    // origin overrides — last wrapper to set it wins. Use case is one
    // scale wrapper pinning the zoom pivot; nothing else touches origin.
    if (typeof c.originX === "number") out.originX = c.originX;
    if (typeof c.originY === "number") out.originY = c.originY;
    // 마스크 스윕 — 마지막 wrapper 가 이긴다 (마스크 wrapper 는 보통 1개)
    if (typeof c.maskProgress === "number") out.maskProgress = c.maskProgress;
    if (typeof c.maskFeather === "number") out.maskFeather = c.maskFeather;
    if (typeof c.maskDir === "number") out.maskDir = c.maskDir;
  }
  return out;
}

// Helper used by ComposedText to render channels as CSS.
// flat=true 는 curve3d 클론 내부용: translate/scale 2D 프리미티브로 내보내
// 요소별 GPU 레이어 승격을 막는다. 곡면 셀 클론이 수십~수백 개일 때 클론마다
// 큰 스팬 텍스처가 잡히면 Chromium 레이어 메모리 상한에서 콘텐츠가 조용히
// 드랍된다(2026-07-09 실측). 시각 결과는 동일(z=0).
export function channelsToCss(ch: Channels, flat?: boolean): {
  transform: string;
  transformOrigin?: string;
  filter?: string;
  opacity: number;
  /** 소프트 마스크 스윕 CSS (maskImage/-webkit- 동일 적용). */
  maskImage?: string;
} {
  // translate3d/scale3d (not 2D translate/scale) so the element animates on
  // its own GPU layer: the browser rasterises once and composites the texture
  // instead of re-rasterising every frame. Without this, the per-frame scale/
  // translate makes glyph edges shimmer as sub-pixel anti-aliasing drifts.
  // Same lesson already applied in ComposedLogo/letterScatter.
  const parts: string[] = [];
  // perspective must lead the transform list so rotateY reads as 3D depth.
  if (ch.rotateY !== 0) parts.push("perspective(900px)");
  if (ch.x !== 0 || ch.y !== 0)
    parts.push(
      flat
        ? `translate(${ch.x.toFixed(1)}px, ${ch.y.toFixed(1)}px)`
        : `translate3d(${ch.x.toFixed(1)}px, ${ch.y.toFixed(1)}px, 0)`,
    );
  if (ch.rotate !== 0) parts.push(`rotate(${ch.rotate.toFixed(2)}deg)`);
  if (ch.rotateY !== 0) parts.push(`rotateY(${ch.rotateY.toFixed(2)}deg)`);
  if (ch.scale !== 1)
    parts.push(
      flat
        ? `scale(${ch.scale.toFixed(4)})`
        : `scale3d(${ch.scale.toFixed(4)}, ${ch.scale.toFixed(4)}, 1)`,
    );
  const originX = (ch.originX * 100).toFixed(2);
  const originY = (ch.originY * 100).toFixed(2);
  const transformOrigin =
    ch.originX === 0.5 && ch.originY === 0.5 ? undefined : `${originX}% ${originY}%`;
  // 마스크 스윕 — front 가 -feather 에서 1+feather 까지 이동하는 소프트 경계.
  // p=1 이면 마스크 자체를 제거(완전 표시, 합성 비용 0).
  let maskImage: string | undefined;
  if (ch.maskProgress != null && ch.maskProgress < 1) {
    const feather = Math.max(0.02, Math.min(1, ch.maskFeather ?? 0.35));
    const dir = (ch.maskDir ?? 1) >= 0 ? "90deg" : "270deg";
    const front = ch.maskProgress * (1 + feather);
    const solid = Math.max(0, (front - feather) * 100);
    const edge = Math.max(solid + 0.01, front * 100);
    maskImage = `linear-gradient(${dir}, #000000 ${solid.toFixed(2)}%, transparent ${edge.toFixed(2)}%)`;
  }
  return {
    transform: parts.join(" "),
    transformOrigin,
    filter: ch.blur > 0 ? `blur(${ch.blur.toFixed(2)}px)` : undefined,
    opacity: ch.opacity,
    maskImage,
  };
}
