// presets/data/stat_counter.ts
// DATA preset. A big animated number for stat scenes ("10M+ users",
// "$2.4B revenue", "98%"). Wraps the stat_reveal atom(suffixMode static) and adds an
// optional caption line above the number. Sub-timings (count duration,
// fade tail, pop) are owned here so callers only set the value + label.
//
// Knobs are intentionally semantic where possible:
//   - pace: "fast" | "med" | "slow" controls the count speed
//   - emphasis: "soft" | "normal" | "strong" boosts font + glow
// Raw frame counts are not exposed.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";
import { mergeEffects } from "../shared/effects";
import { emphMultiplier } from "../shared/emphasis";

export type StatCounterKnobs = CommonKnobs & {
  to: number; // target value
  from?: number; // start value, default 0
  prefix?: string; // "$", "+" etc.
  suffix?: string; // "M+", "%", "K" etc.
  decimals?: number; // 0..6, default 0
  thousands?: boolean; // grouping separator, default true
  caption?: string; // optional label rendered above the number
  baseColor?: string;
  // Gradient across the number (the emphasis). 2+ hex stops. When set,
  // the digits render as a gradient instead of baseColor solid.
  gradient?: string[];
  pace?: "fast" | "med" | "slow"; // count speed
  // duration ignored — preset computes scene length from pace + tail
  duration?: number;
};

type PaceCfg = {
  countFrames: number; // count animation length
  tailFrames: number; // how long the final value lingers before scene ends
};

const PACE: Record<"fast" | "med" | "slow", PaceCfg> = {
  fast: { countFrames: 24, tailFrames: 18 },
  med: { countFrames: 40, tailFrames: 24 },
  slow: { countFrames: 60, tailFrames: 30 },
};

// Emphasis maps to a number font-size multiplier and a glow on/off. The
// scale-amplitude story used by punch/beat doesn't fit here because the
// counter's "pop" is baked into the atom itself.
const EMPHASIS_FONT_MUL: Record<"soft" | "normal" | "strong", number> = {
  soft: 0.85,
  normal: 1.0,
  strong: 1.18,
};

export function statCounter(knobs: StatCounterKnobs, ctx: PresetCtx): SceneSpec {
  const cfg = PACE[knobs.pace ?? "med"];
  const fps = 24;
  const fontMul = EMPHASIS_FONT_MUL[knobs.emphasis ?? "normal"];
  const fontSize = (knobs.fontSize ?? 10) * fontMul;
  const fontWeight = clampFontWeight(knobs.fontWeight, 700);
  const color = knobs.baseColor ?? "#FFFFFF";
  const brandFont = knobs.fontFamily ?? ctx.brand.fontFamily;
  const emphMul = emphMultiplier(knobs.emphasis);

  // Total scene = count + tail (pop already folded into intrinsic by the
  // atom). Caption sits inline above the counter, no extra timing.
  const totalFrames = cfg.countFrames + cfg.tailFrames;
  // Caption sits ABOVE the number with real breathing room. The number is
  // large (fontSize vw); its glyph box extends well above its center, so a
  // tight gap let the caption collide with the digits (user-reported). Push
  // the caption up and the number down so they read as two separate lines.
  const counterY = knobs.caption ? 0.6 : 0.5;
  const captionY = 0.32;

  // Glow is opt-in (effects.glow.enabled). When auto-color, halo follows
  // the digit color — fine because a counter is a single solid color.
  const resolvedFx = mergeEffects(undefined, knobs.effects, emphMul);

  const elements: TextElementSpec[] = [];

  if (knobs.caption) {
    const captionFontSize = Math.max(1.2, fontSize * 0.28);
    elements.push({
      element: "text",
      id: "caption",
      base: {
        text: knobs.caption,
        fontSize: captionFontSize,
        fontWeight: 500,
        color,
        letterSpacing: 0.06,
        position: { x: 0.5, y: captionY },
        ...(brandFont ? { fontFamily: brandFont } : {}),
      },
      // No motion layer — caption is a static label that holds for the scene.
    });
  }

  // Gradient emphasis on the number. A single static gradient (flow≈0) —
  // the seam-free cyclic fill is handled in ComposedText. 2+ stops needed.
  const grad = knobs.gradient && knobs.gradient.length >= 2;
  const counterColor = grad
    ? {
        timeline: [
          { fill: { type: "gradient" as const, stops: knobs.gradient!, angle: 95 } },
        ],
      }
    : undefined;

  elements.push({
    element: "text",
    id: "counter",
    base: {
      text: String(knobs.from ?? 0),
      fontSize,
      fontWeight,
      color,
      position: { x: 0.5, y: counterY },
      ...(brandFont ? { fontFamily: brandFont } : {}),
    },
    ...(counterColor ? { color: counterColor } : {}),
    layers: [
      // stat_reveal(suffixMode static)로 통일 — number_counter 대체.
      // 스케일 안착 + 착지 바운스가 아톰에 내장이라 별도 scale wrapper 불필요.
      {
        type: "stat_reveal",
        role: "in",
        props: {
          from: knobs.from ?? 0,
          to: knobs.to,
          countDuration: cfg.countFrames,
          countEasing: "easeOutExpo",
          prefix: knobs.prefix ?? "",
          suffix: knobs.suffix ?? "",
          suffixMode: "static",
          suffixScale: 1,
          decimals: knobs.decimals ?? 0,
          thousands: knobs.thousands !== false,
          baseColor: color,
          landColor: color,
          scaleFrom: 1.05,
          settleFrac: 0.5,
          landBounce: 0.12,
        },
      },
    ],
    effects: resolvedFx,
  });

  return {
    duration: totalFrames / fps,
    transition_out: "hard_cut",
    elements,
  };
}
