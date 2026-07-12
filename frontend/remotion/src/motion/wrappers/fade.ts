// wrappers/fade.ts
// Opacity ramp with optional motion-blur tail. Mode defaults to "in" for
// role=in/hold and "out" for role=out. Returns numeric channels (TEXT_MOTION_SPEC 0.1).

import { clamp, ease, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type FadeProps = {
  mode?: "in" | "out";
  duration?: number;
  blur?: number;
  easing?: EasingName;
};

export const fade: WrapperFn = (f, rawProps, _ctx, role, window) => {
  const p = rawProps as FadeProps;
  const mode = p.mode ?? (role === "out" ? "out" : "in");
  const defaultEasing: EasingName = mode === "out" ? "easeIn" : "easeOutExpo";
  const t = ease(f, p.duration ?? window, p.easing ?? defaultEasing);
  const v = mode === "out" ? 1 - t : t;
  const blurAmt = clamp(p.blur ?? 0, 0, 12);
  return {
    opacity: v,
    blur: blurAmt > 0 ? (1 - v) * blurAmt : 0,
  };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as FadeProps;
  return Math.max(1, p.duration ?? 18);
}

export const name = "fade";
export const fn = fade;
export const labPreset = {
  role: "in" as const,
  props: { duration: 18, easing: "easeOutExpo", blur: 6 } as Record<string, unknown>,
};
