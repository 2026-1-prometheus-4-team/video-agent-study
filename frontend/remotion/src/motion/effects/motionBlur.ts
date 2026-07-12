// effects/motionBlur.ts
// Velocity-linked motion blur, axis-separated. Returns per-axis blur
// radii (px) computed from the per-frame channel deltas. CSS filter:
// blur() is rotationally symmetric, so a horizontal sweep would smear
// in all directions; using an SVG feGaussianBlur with two stdDeviation
// values lets us draw the streak only along the direction of motion.

import { clamp } from "../core/easing";
import { composeChannels, type WrapperCtx } from "../wrappers";
import type { TimedLayer } from "../core/timing";

export type MotionBlurSpec = {
  enabled?: boolean;
  amount?: number;
  maxBlur?: number;
};

export function motionBlurDirectional(
  spec: MotionBlurSpec | undefined,
  wrappers: TimedLayer[],
  frame: number,
  ctx: WrapperCtx,
): { x: number; y: number } {
  if (!spec || spec.enabled === false) return { x: 0, y: 0 };
  const amount = clamp(spec.amount ?? 0.5, 0, 1.5);
  const maxBlur = clamp(spec.maxBlur ?? 20, 4, 200);
  const cur = composeChannels(wrappers, frame, ctx);
  const prev = composeChannels(wrappers, frame - 1, ctx);
  const dx = Math.abs(cur.x - prev.x);
  const dy = Math.abs(cur.y - prev.y);
  return {
    x: Math.min(maxBlur, dx * amount),
    y: Math.min(maxBlur, dy * amount),
  };
}
