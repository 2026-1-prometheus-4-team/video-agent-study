// presets/shared/emphasis.ts
// "emphasis" is a single shorthand for nudging a preset's overall punch
// without exposing raw scale/easing knobs. soft = gentler motion + dimmer
// glow; strong = exaggerated. Each preset wires the multiplier into its own
// scale layers and effect intensities.

import type { MotionLayer } from "../../motion/core/timing";

export type Emphasis = "soft" | "normal" | "strong";

const EMPHASIS_MUL: Record<Emphasis, number> = {
  soft: 0.75,
  normal: 1.0,
  strong: 1.25,
};

export function emphMultiplier(e: Emphasis | undefined): number {
  return EMPHASIS_MUL[e ?? "normal"];
}

// Multiply each scale layer's from/to distance-from-1 by `mul`. Strong
// (mul=1.25) makes the pop bigger; soft (mul=0.75) makes it gentler.
// Clamped to >=0.05 so we never collapse text to zero visibility.
export function applyEmphasisToScale(
  layers: MotionLayer[],
  mul: number,
): MotionLayer[] {
  if (mul === 1.0) return layers;
  return layers.map((l) => {
    if (l.type !== "scale") return l;
    const props = (l.props ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...props };
    for (const key of ["from", "to"] as const) {
      const v = props[key];
      if (typeof v === "number") {
        next[key] = Math.max(0.05, 1 + (v - 1) * mul);
      }
    }
    return { ...l, props: next };
  });
}
