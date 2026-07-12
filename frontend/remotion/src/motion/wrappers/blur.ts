// wrappers/blur.ts
// CSS blur(from -> to) in pixels. Defaults flip with role: in = 12 -> 0,
// out = 0 -> 12. Returns blur channel (summed across layers).

import { clamp, ease, lerp, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type BlurProps = {
  from?: number;
  to?: number;
  duration?: number;
  easing?: EasingName;
};

export const blur: WrapperFn = (f, rawProps, _ctx, role, window) => {
  const p = rawProps as BlurProps;
  const t = ease(f, p.duration ?? window, p.easing);
  const from = clamp(p.from ?? (role === "out" ? 0 : 12), 0, 30);
  const to = clamp(p.to ?? (role === "out" ? 12 : 0), 0, 30);
  return { blur: lerp(from, to, t) };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as BlurProps;
  return Math.max(1, p.duration ?? 18);
}

export const name = "blur";
export const fn = blur;
export const labPreset = {
  role: "in" as const,
  props: { duration: 18, easing: "easeOutExpo" } as Record<string, unknown>,
};
