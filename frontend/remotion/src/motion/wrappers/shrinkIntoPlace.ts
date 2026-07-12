// wrappers/shrinkIntoPlace.ts
// Hero word collapses into its sentence position. scale fromScale -> 1,
// position (fromX, fromY) -> (0,0) on a single curve (TEXT_MOTION_SPEC 1.5).

import { clamp, ease, lerp, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type ShrinkIntoPlaceProps = {
  fromScale?: number;
  fromX?: number;
  fromY?: number;
  duration?: number;
  easing?: EasingName;
};

export const shrinkIntoPlace: WrapperFn = (f, rawProps, ctx, _role, window) => {
  const p = rawProps as ShrinkIntoPlaceProps;
  const t = ease(f, p.duration ?? Math.min(window, 16), p.easing ?? "easeInOut");
  const fromScale = clamp(p.fromScale ?? 2.5, 1.5, 4);
  const fromX = clamp(p.fromX ?? 0, -0.3, 0.3);
  const fromY = clamp(p.fromY ?? 0, -0.3, 0.3);
  const s = lerp(fromScale, 1, t);
  const x = lerp(fromX, 0, t) * ctx.width;
  const y = lerp(fromY, 0, t) * ctx.height;
  return { scale: s, x, y };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as ShrinkIntoPlaceProps;
  return Math.max(1, p.duration ?? 16);
}

export const name = "shrink_into_place";
export const fn = shrinkIntoPlace;
export const labPreset = {
  role: "in" as const,
  props: { duration: 16, easing: "easeInOut", fromScale: 2.2 } as Record<string, unknown>,
};
