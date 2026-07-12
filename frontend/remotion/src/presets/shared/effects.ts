// presets/shared/effects.ts
// Safe surface for effect overrides. The motion engine's GlowSpec and
// MotionBlurSpec accept many wiring fields (timeline, wordIdx, color, etc.)
// that the LLM has no business setting. We only expose enabled/intensity/
// radius/amount/maxBlur — everything else stays preset-controlled.

import { clamp } from "../../motion/core/easing";
import type { GlowSpec } from "../../motion/effects/glow";
import type { MotionBlurSpec } from "../../motion/effects/motionBlur";

export type GlowOverride = {
  enabled?: boolean;
  intensity?: number; // 0..1
  radius?: number; // px, 4..120
  color?: string; // "auto" tracks the letter color, hex pins the halo color
};

export type MotionBlurOverride = {
  enabled?: boolean;
  amount?: number; // 0..1.5
  maxBlur?: number; // px, 4..200
};

export type EffectsOverride = {
  glow?: GlowOverride;
  motionBlur?: MotionBlurOverride;
};

// Same shape ComposedText accepts on TextElementSpec.effects.
export type ResolvedEffects = {
  glow?: GlowSpec;
  motionBlur?: MotionBlurSpec;
};

// Merge a preset's baked-in effects with the LLM's override and apply an
// emphasis multiplier to intensity-like values. All numerics are clamped at
// the boundary so out-of-range knobs can't blow up rendering.
export function mergeEffects(
  base: ResolvedEffects | undefined,
  override: EffectsOverride | undefined,
  emphasisMul: number,
): ResolvedEffects {
  const out: ResolvedEffects = {};

  // glow
  const bg = base?.glow;
  const og = override?.glow;
  if (bg || og) {
    const enabled = og?.enabled ?? bg?.enabled ?? false;
    if (enabled) {
      const baseI = bg?.intensity ?? 0.6;
      const overrideI = og?.intensity;
      const intensity =
        overrideI !== undefined ? clamp(overrideI, 0, 1) : baseI;
      const radius =
        og?.radius !== undefined
          ? clamp(og.radius, 4, 120)
          : bg?.radius;
      out.glow = {
        ...bg,
        enabled: true,
        intensity: clamp(intensity * emphasisMul, 0, 1),
        radius,
        color: og?.color ?? bg?.color,
      };
    } else if (bg) {
      out.glow = { ...bg, enabled: false };
    }
  }

  // motionBlur
  const bm = base?.motionBlur;
  const om = override?.motionBlur;
  if (bm || om) {
    const enabled = om?.enabled ?? bm?.enabled ?? false;
    if (enabled) {
      const baseA = bm?.amount ?? 0.5;
      const overrideA = om?.amount;
      const amount =
        overrideA !== undefined ? clamp(overrideA, 0, 1.5) : baseA;
      const maxBlur =
        om?.maxBlur !== undefined
          ? clamp(om.maxBlur, 4, 200)
          : bm?.maxBlur;
      out.motionBlur = {
        ...bm,
        enabled: true,
        amount: clamp(amount * emphasisMul, 0, 1.5),
        maxBlur,
      };
    } else if (bm) {
      out.motionBlur = { ...bm, enabled: false };
    }
  }

  return out;
}
