// presets/hook/punch.ts
// HOOK preset. Short attention grab — color sweeps across the letters
// (letterOffsetFrames -1 creates the per-letter wave), then settles on the
// last palette entry as solid. Source: specs/hey-tweak.json.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import type { ColorEntry } from "../../motion/color/engine";
import { clampFontWeight, type CommonKnobs, type PresetCtx } from "../shared/types";
import { applyEmphasisToScale, emphMultiplier } from "../shared/emphasis";
import { mergeEffects, type ResolvedEffects } from "../shared/effects";

export type PunchKnobs = CommonKnobs & {
  text: string;
  palette?: string[]; // 2+ colors; consecutive pairs become 2-stop gradients
  baseColor?: string; // text fill underneath (matters when palette ends on solid)
  duration: number;
};

function punchTimeline(palette: string[]): ColorEntry[] {
  const colors = palette.length >= 2
    ? palette
    : [palette[0] ?? "#FFFFFF", palette[0] ?? "#FFFFFF"];
  const entries: ColorEntry[] = [];
  for (let i = 0; i < colors.length - 1; i++) {
    entries.push({
      fill: { type: "gradient", stops: [colors[i], colors[i + 1]] },
      transition: 5,
    });
  }
  entries.push({
    fill: { type: "solid", value: colors[colors.length - 1] },
    hold: 4,
  });
  return entries;
}

const BASE_EFFECTS: ResolvedEffects = {
  glow: { enabled: true, color: "auto", intensity: 0.7, radius: 34, breath: true },
};

export function punch(knobs: PunchKnobs, ctx: PresetCtx): SceneSpec {
  const palette = knobs.palette ?? ctx.brand.colors ?? ["#FFFFFF"];
  const mul = emphMultiplier(knobs.emphasis);
  const layers = applyEmphasisToScale(
    [
      { type: "move", role: "in", props: { fromX: -0.02, toX: 0, duration: 12, easing: "easeOut" } },
      { type: "scale", role: "out", props: { from: 1.0, to: 0.4, duration: 8, easing: "easeIn" } },
    ],
    mul,
  );

  const fontFamily = knobs.fontFamily ?? ctx.brand.fontFamily;
  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.text,
      fontSize: knobs.fontSize ?? 10,
      fontWeight: clampFontWeight(knobs.fontWeight, 700),
      color: knobs.baseColor ?? "#FFFFFF",
      ...(fontFamily ? { fontFamily } : {}),
    },
    color: { timeline: punchTimeline(palette), letterOffsetFrames: -1 },
    layers,
    effects: mergeEffects(BASE_EFFECTS, knobs.effects, mul),
  };
  return {
    duration: knobs.duration,
    transition_out: "hard_cut",
    elements: [element],
  };
}
