// wrappers/scale.ts
// Uniform scale (from -> to). Defaults: 0.9 -> 1 on entry, 1 -> 1 on exit.
// Returns scale channel (multiplied across layers) and optionally an
// origin override (transform-origin in element fractions 0..1).
//
// The clamp range (0.001..200) covers literal 1-pixel "dot" starts at the
// low end (zoom_cut's emergeText pin-emerges from sub-px) and screen-
// overflowing zooms at the high end (zoom_cut's fromText grows to 100x+).
// The 0.001 floor stops div-by-zero blow-ups while still letting a 633px-
// wide text render as a single pixel (1/633 ≈ 0.0016).
//
// Resolved-pixel start: when both `startPx` and `referenceVw` are set,
// `from` is overridden by `startPx / (ctx.width * referenceVw / 100)`.
// referenceVw is the caller's estimate of the element's rendered width
// in viewport-width units (vw). This lets a preset say "start as a 1-px
// dot" without knowing the canvas resolution. Explicit `from` is still
// respected when startPx/referenceVw aren't both provided.

import { clamp, clamp01, ease, lerp, type EasingName } from "../core/easing";
import type { Channels, WrapperFn } from "./index";

export type ScaleProps = {
  from?: number;
  to?: number;
  // Pivot point as element fractions (0..1, default 0.5/0.5 = centre).
  // The legacy named values "left"|"center"|"right" still work for the
  // horizontal pivot — kept for backward compatibility but {x,y} is the
  // canonical form. ComposedText reads originX/originY from the channels
  // and sets transform-origin so scale grows out of that point.
  origin?: { x: number; y: number } | "center" | "left" | "right";
  duration?: number;
  easing?: EasingName;
  // Hold at `from` for the first `dwellFrac` (0..1) of duration, then ease
  // from->to over the rest. Lets one layer do "stay still, THEN move"
  // without a delayed sibling (which can blank a single-layer element
  // before its window starts). Used by zoom_cut's read-then-zoom hold.
  dwellFrac?: number;
  // Pixel-resolved start. When both startPx and referenceVw are set, `from`
  // is computed as startPx / (canvas.width * referenceVw / 100) so the
  // element starts at literally startPx pixels regardless of fontSize.
  startPx?: number;
  referenceVw?: number;
};

function resolveOrigin(o: ScaleProps["origin"]): { x: number; y: number } {
  if (!o || o === "center") return { x: 0.5, y: 0.5 };
  if (o === "left") return { x: 0, y: 0.5 };
  if (o === "right") return { x: 1, y: 0.5 };
  return { x: clamp01(o.x), y: clamp01(o.y) };
}

const SCALE_MIN = 0.001;
// 200x ceiling. zoom_cut runs its front word up to ~zoomScale by scene
// end (easeInBoost normalises to f(1)=1 exactly), and zoomScale defaults
// to 50 with knob clamp at 200. Past that is almost certainly a spec
// mistake — and the rasteriser starts producing artefacts.
const SCALE_MAX = 200;

export const scale: WrapperFn = (f, rawProps, ctx, role, window) => {
  const p = rawProps as ScaleProps;
  const dur = p.duration ?? window;
  // dwellFrac: hold at `from` for the first fraction, then ease over the
  // remainder. Remap the local frame so f<dwell -> t=0 (stays at `from`).
  const dwell = clamp01(p.dwellFrac ?? 0) * dur;
  const t =
    dwell > 0
      ? ease(Math.max(0, f - dwell), Math.max(1, dur - dwell), p.easing ?? "easeInOut")
      : ease(f, dur, p.easing ?? "easeInOut");
  let fromRaw: number;
  if (p.startPx !== undefined && p.referenceVw !== undefined) {
    const referencePx = (ctx.width * p.referenceVw) / 100;
    fromRaw = referencePx > 0 ? p.startPx / referencePx : (p.from ?? 0.9);
  } else {
    fromRaw = p.from ?? (role === "in" ? 0.9 : 1);
  }
  const from = clamp(fromRaw, SCALE_MIN, SCALE_MAX);
  const to = clamp(p.to ?? 1, SCALE_MIN, SCALE_MAX);
  const origin = resolveOrigin(p.origin);
  const out: Partial<Channels> = { scale: lerp(from, to, t) };
  // Only emit origin when the spec explicitly asked for one — otherwise
  // we'd clobber centred defaults that other wrappers expect.
  if (p.origin !== undefined) {
    out.originX = origin.x;
    out.originY = origin.y;
  }
  return out;
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as ScaleProps;
  return Math.max(1, p.duration ?? 18);
}

export const name = "scale";
export const fn = scale;
export const labPreset = {
  role: "in" as const,
  props: { duration: 18, easing: "easeOutExpo", from: 0.6, to: 1 } as Record<string, unknown>,
};
