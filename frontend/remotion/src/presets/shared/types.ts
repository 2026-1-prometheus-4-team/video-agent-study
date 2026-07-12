// presets/shared/types.ts
// Cross-preset types. Anything a preset function consumes via PresetCtx or
// returns lives here; per-preset Knobs stay next to their function.

import { clamp } from "../../motion/core/easing";
import type { Emphasis } from "./emphasis";
import type { EffectsOverride } from "./effects";

export type Brand = {
  background?: string;
  colors?: string[];
  fontFamily?: string;
};

export type PresetCtx = { brand: Brand };

// Safe knobs shared by every preset. Nothing here can change layer wiring
// or timing — only typographic + effect strength surface. fontSize/Weight
// are clamped at the renderer; emphasis is mapped to scale + glow multipliers
// inside each preset; effects merges into the preset's baked defaults.
export type CommonKnobs = {
  fontSize?: number; // vw, clamped 0.5..20 at render time
  fontWeight?: number; // 100..900
  // Per-scene fontFamily override. Defaults to brand.fontFamily when
  // absent. Use to swap a brand wordmark font (e.g. Syne) for the
  // finale scene only while keeping the body font everywhere else.
  fontFamily?: string;
  emphasis?: Emphasis;
  effects?: EffectsOverride;
};

// fontWeight passes straight to CSS; browsers tolerate junk values, but per
// our "clamp at the boundary" rule we snap it to the legal range here.
export function clampFontWeight(
  w: number | undefined,
  fallback: number,
): number {
  if (w === undefined) return fallback;
  return Math.round(clamp(w, 100, 900));
}
