// presets/beat/beat.ts
// BEAT preset. Single staccato word: fade + slight slide in, then a fast
// scale-up + blur on the way out. Chain 2-3 in a row for a chant rhythm.
// No color knob (kept monochrome on purpose). Source: specs/to.json.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import { clampFontWeight, type CommonKnobs, type PresetCtx } from "../shared/types";
import { applyEmphasisToScale, emphMultiplier } from "../shared/emphasis";
import { mergeEffects } from "../shared/effects";

export type BeatKnobs = CommonKnobs & {
  /** Optional per-scene background override. Use to flip a beat onto a
   *  dark canvas for an accent / emphasis break in the middle of an
   *  otherwise light-theme sequence (or vice versa). */
  background?: string;
  text: string;
  baseColor?: string;
  duration: number;
};

export function beat(knobs: BeatKnobs, ctx: PresetCtx): SceneSpec {
  const mul = emphMultiplier(knobs.emphasis);
  const layers = applyEmphasisToScale(
    [
      { type: "fade", role: "in", props: { duration: 10 } },
      { type: "move", role: "in", props: { fromX: 0.04, toX: 0, duration: 30, easing: "easeOutExpo" } },
      {
        type: "scale",
        role: "afterIn",
        props: { from: 1.0, to: 2.2, duration: 8, easing: "easeInAccel", lead: -4 },
      },
      {
        type: "blur",
        role: "afterIn",
        props: { from: 0, to: 5, duration: 8, easing: "easeInAccel", lead: -4 },
      },
    ],
    mul,
  );

  const fontFamily = knobs.fontFamily ?? ctx.brand.fontFamily;
  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.text,
      fontSize: knobs.fontSize ?? 5,
      fontWeight: clampFontWeight(knobs.fontWeight, 600),
      color: knobs.baseColor ?? "#FFFFFF",
      ...(fontFamily ? { fontFamily } : {}),
    },
    layers,
    effects: mergeEffects(undefined, knobs.effects, mul),
  };
  return {
    duration: knobs.duration,
    transition_out: "hard_cut",
    ...(knobs.background ? { background: { color: knobs.background } } : {}),
    elements: [element],
  };
}
