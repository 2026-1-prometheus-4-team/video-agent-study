// wrappers/move.ts
// Translate (from -> to) in normalized screen units (-0.5 .. 0.5),
// scaled to pixels via ctx.width/height. Returns x/y channels.
// Velocity-linked motion blur is applied by effects/motionBlur (channel-delta).

import { clamp, ease, lerp, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type MoveProps = {
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  duration?: number;
  easing?: EasingName;
};

export const move: WrapperFn = (f, rawProps, ctx, _role, window) => {
  const p = rawProps as MoveProps;
  const t = ease(f, p.duration ?? window, p.easing ?? "easeOutExpo");
  const fromX = clamp(p.fromX ?? 0, -0.5, 0.5);
  const fromY = clamp(p.fromY ?? 0, -0.5, 0.5);
  const toX = clamp(p.toX ?? 0, -0.5, 0.5);
  const toY = clamp(p.toY ?? 0, -0.5, 0.5);
  return {
    x: lerp(fromX, toX, t) * ctx.width,
    y: lerp(fromY, toY, t) * ctx.height,
  };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as MoveProps;
  return Math.max(1, p.duration ?? 18);
}

export const name = "move";
export const fn = move;
export const labPreset = {
  role: "in" as const,
  props: { duration: 18, easing: "easeOutExpo", fromX: -0.2, toX: 0 } as Record<string, unknown>,
};
