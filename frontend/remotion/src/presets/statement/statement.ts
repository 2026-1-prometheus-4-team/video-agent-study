// presets/statement/statement.ts
// STATEMENT preset. Reveals a full sentence word-by-word with a smooth
// reflow, spotlighting one word with a looping highlight gradient, then
// erases on exit. Main message carrier. Source: specs/dream.json.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import type { ColorEntry } from "../../motion/color/engine";
import { clampFontWeight, type CommonKnobs, type PresetCtx } from "../shared/types";
import { applyEmphasisToScale, emphMultiplier } from "../shared/emphasis";
import { mergeEffects } from "../shared/effects";
import { countWords, cycleGradientStops, highlightAt } from "../shared/helpers";

export type StatementKnobs = CommonKnobs & {
  text: string;
  highlightWord?: number; // 0-based word index; <0 = no highlight
  highlightCycle?: string[]; // colors the highlight gradient cycles through
  exitSpeed?: "slow" | "med" | "fast"; // erase wordGap
  // Reveal rhythm. "uniform" = every word lands on the same beat.
  // "punctuate" = first and last words hold for a beat, middle words rush
  // by; reads as "anchor - filler - landing" and keeps medium-length
  // sentences from feeling monotone.
  pacing?: "uniform" | "punctuate";
  baseColor?: string;
  duration: number;
};

const EXIT_WORD_GAP: Record<"slow" | "med" | "fast", number> = {
  slow: 5,
  med: 3,
  fast: 2,
};

type PacingGaps = { firstGap: number; wordGap: number; lastGap?: number };

// pacing maps to concrete typewriter gap numbers. LLM picks the shape;
// the actual frame counts are owned here.
function pacingGaps(pacing: "uniform" | "punctuate" | undefined): PacingGaps {
  switch (pacing ?? "uniform") {
    case "punctuate":
      // anchor(첫 단어 hold) -> 중간 단어 rush -> landing(마지막 hold). Base44식 속도감.
      return { firstGap: 9, wordGap: 3, lastGap: 15 };
    case "uniform":
    default:
      return { firstGap: 10, wordGap: 8 };
  }
}

export function statement(knobs: StatementKnobs, ctx: PresetCtx): SceneSpec {
  const words = countWords(knobs.text);
  const highlightIdx = knobs.highlightWord ?? -1;
  const cycle = knobs.highlightCycle ?? ctx.brand.colors ?? ["#FFFFFF"];
  const stopSets = cycleGradientStops(cycle);
  const timeline: ColorEntry[] = stopSets.map((stops, i) => ({
    fill: {
      type: "palette",
      values: highlightAt(words, highlightIdx, stops),
      unit: "word",
    },
    hold: i === 0 ? 12 : 8,
    transition: 8,
  }));
  const exitGap = EXIT_WORD_GAP[knobs.exitSpeed ?? "med"];
  const mul = emphMultiplier(knobs.emphasis);
  const gaps = pacingGaps(knobs.pacing);

  const layers = applyEmphasisToScale(
    [
      {
        type: "typewriter",
        role: "in",
        props: {
          unit: "word",
          cursor: "none",
          firstGap: gaps.firstGap,
          wordGap: gaps.wordGap,
          lastGap: gaps.lastGap,
          revealGap: { from: 1.8, duration: 10, easing: "easeOut" },
          revealMove: { y: 0.18, duration: 10, easing: "easeOut" },
          reflow: "smooth",
          reflowSmoothing: 12,
          reflowLead: 5,
        },
      },
      {
        type: "scale",
        role: "afterIn",
        props: { from: 1.0, to: 0.8, duration: 52, easing: "easeIn" },
      },
      {
        type: "move",
        role: "out",
        props: { fromX: 0, toX: -0.06, duration: 24, easing: "easeInOut" },
      },
      {
        type: "typewriter",
        role: "out",
        props: {
          unit: "word",
          mode: "erase",
          eraseFrom: "left",
          wordGap: exitGap,
          delay: 40,
          cursor: "none",
          reflow: "smooth",
          reflowSmoothing: 12,
        },
      },
    ],
    mul,
  );

  // statement has no baked effects. Auto-route glow to the highlight word
  // via wordIdx — the renderer keeps the element-wide clone path but tags
  // the clones with a scoped mask so only the highlight word's pixels
  // contribute to the blur. Halo is the actual rendered gradient (no per-
  // letter color sampling), so chroma is preserved AND it only covers the
  // highlighted word, not the whole sentence.
  const resolved = mergeEffects(undefined, knobs.effects, mul);
  if (resolved.glow?.enabled && highlightIdx >= 0) {
    resolved.glow = { ...resolved.glow, wordIdx: highlightIdx };
  }

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
    color: { timeline, loop: true },
    layers,
    effects: resolved,
  };
  return {
    duration: knobs.duration,
    transition_out: "hard_cut",
    elements: [element],
  };
}
