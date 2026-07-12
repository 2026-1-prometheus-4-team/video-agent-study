// presets/hero/hero_zoom.ts
// HERO preset. Final brand reveal: large text, looping multi-stop gradient
// flowing across the letters, scale-up in, then scale-down + slide-out.
// Source: specs/explore.json.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import type { ColorEntry } from "../../motion/color/engine";
import { clampFontWeight, type CommonKnobs, type PresetCtx } from "../shared/types";
import { applyEmphasisToScale, emphMultiplier } from "../shared/emphasis";
import { mergeEffects, type ResolvedEffects } from "../shared/effects";
import { rotateStops } from "../shared/helpers";

export type HeroZoomKnobs = CommonKnobs & {
  text: string;
  gradientStops?: string[]; // base colors; rotated 3x for the looping timeline
  flowSpeed?: number;
  exitDir?: "left" | "right";
  baseColor?: string;
  duration: number;
};

const BASE_EFFECTS: ResolvedEffects = {
  glow: { enabled: true, color: "auto", intensity: 0.6, radius: 50, breath: true },
  motionBlur: { enabled: true, amount: 0.6, maxBlur: 50 },
};

export function heroZoom(knobs: HeroZoomKnobs, ctx: PresetCtx): SceneSpec {
  const stops = knobs.gradientStops ?? ctx.brand.colors ?? ["#FFFFFF", "#FFFFFF"];
  const timeline: ColorEntry[] = [
    { fill: { type: "gradient", stops: rotateStops(stops, 0), angle: 95 }, hold: 8, transition: 14 },
    { fill: { type: "gradient", stops: rotateStops(stops, 1), angle: 95 }, hold: 8, transition: 14 },
    { fill: { type: "gradient", stops: rotateStops(stops, 2), angle: 95 }, hold: 6, transition: 12 },
  ];
  const toX = (knobs.exitDir ?? "left") === "left" ? -0.4 : 0.4;
  const mul = emphMultiplier(knobs.emphasis);

  // In-scale peak. The signature entrance overshoots to 1.7 (×emphasis mul),
  // which clips long brand lines: "Your SaaS Brand" at fontSize 9 already
  // spans the viewport, so 1.875× runs off both edges. Auto-fit the font so
  // the text fits AT PEAK regardless of the LLM's fontSize — the knob is a
  // hint, the fit is the guarantee. 0.55 ≈ average glyph width in vw units;
  // 90 leaves a ~10vw safety margin.
  const peakScale = 1 + (1.7 - 1) * mul;
  const requestedFontSize = knobs.fontSize ?? 13;
  const chars = Math.max(1, knobs.text.length);
  const maxFontSize = 90 / (chars * 0.55 * peakScale);
  const fittedFontSize = Math.min(requestedFontSize, maxFontSize);

  const layers = applyEmphasisToScale(
    [
      { type: "scale", role: "in", props: { from: 0.6, to: 1.7, duration: 16, easing: "easeOutExpo" } },
      { type: "blur", role: "in", props: { from: 18, to: 0, duration: 12, easing: "easeOut" } },
      { type: "scale", role: "out", props: { from: 1.0, to: 0.2, duration: 18, easing: "easeIn" } },
      { type: "move", role: "out", props: { fromX: 0, toX, duration: 8, easing: "easeIn" } },
    ],
    mul,
  );

  const fontFamily = knobs.fontFamily ?? ctx.brand.fontFamily;
  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.text,
      fontSize: fittedFontSize,
      fontWeight: clampFontWeight(knobs.fontWeight, 700),
      color: knobs.baseColor ?? "#FFFFFF",
      ...(fontFamily ? { fontFamily } : {}),
    },
    color: { timeline, loop: true, flowSpeed: knobs.flowSpeed ?? -2.5 },
    layers,
    effects: mergeEffects(BASE_EFFECTS, knobs.effects, mul),
  };
  return {
    duration: knobs.duration,
    transition_out: "hard_cut",
    elements: [element],
  };
}
