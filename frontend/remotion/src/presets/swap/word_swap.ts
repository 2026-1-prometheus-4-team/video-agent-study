// presets/swap/word_swap.ts
// TRANSITION preset. Two text elements share one scene: A scatters out
// (mode:"out") and B reassembles (mode:"in") with B.delay pinned to A's
// fadeEnd so the swap is tangent — no overlap frame, no blank frame.
//
// Caller picks fromText/toText and (optionally) pace. Sub-timings
// (stagger, scatterHold, fade, durations) are LOCKED inside the preset
// because they only work as a balanced set: changing one in isolation
// re-opens the overlap/blank gap.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";

export type WordSwapKnobs = CommonKnobs & {
  fromText: string;
  toText: string;
  pace?: "fast" | "med" | "slow"; // overall swap speed
  baseColor?: string;
  spread?: number; // 0..1, scatter distance
  seed?: number;
  // Seconds to display fromText at an oversized scale before it scatters.
  // The word fades from INTRO_SCALE (~1.3) down to 1.0 across this window,
  // then the scatter begins. Default 0 (no intro hold, scatter starts at
  // frame 0).
  holdSeconds?: number;
  // duration is ignored — the preset computes scene length from pace and
  // the longer of the two words. Listed for type compatibility only.
  duration?: number;
};

const FADE_FRAMES = 1; // hard cut between A end and B start
// Whole-element scale shrinks during A's scatter and recovers during B's
// assembly. The dip puts both words at minimum scale right at the swap
// frame, so the moment-of-change has less visual mass — softens the
// otherwise abrupt formation swap. Easing endpoints meet at SCALE_MIN.
const SCALE_MIN = 0.85;
// Oversized scale during the optional intro hold (holdSeconds > 0). The
// word presents at INTRO_SCALE, shrinks to 1.0 across the hold window,
// THEN scatters.
const INTRO_SCALE = 1.3;

type PaceCfg = {
  stagger: number;
  outDuration: number;
  inDuration: number;
  scatterHold: number;
};

// stagger 0: all letters launch together and fade together. Per-letter
// rhythm was rejected as "letters going one by one." Visual variety
// still comes from per-letter axis/direction (each letter takes its own
// cardinal axis), not from staggered timing.
const PACE: Record<"fast" | "med" | "slow", PaceCfg> = {
  fast: { stagger: 0, outDuration: 8, inDuration: 12, scatterHold: 0 },
  med: { stagger: 0, outDuration: 12, inDuration: 16, scatterHold: 0 },
  slow: { stagger: 0, outDuration: 16, inDuration: 20, scatterHold: 0 },
};

function letterCount(text: string): number {
  return text.replace(/\s/g, "").length;
}

export function wordSwap(knobs: WordSwapKnobs, ctx: PresetCtx): SceneSpec {
  const cfg = PACE[knobs.pace ?? "med"];
  const fps = 24;
  const fontSize = knobs.fontSize ?? 8;
  const fontWeight = clampFontWeight(knobs.fontWeight, 700);
  const color = knobs.baseColor ?? "#FFFFFF";
  const spread = knobs.spread ?? 1.0;
  const seed = knobs.seed ?? 7;

  const fromN = letterCount(knobs.fromText);
  const toN = letterCount(knobs.toText);

  // Intro hold: fromText sits at INTRO_SCALE, shrinks to 1.0 across
  // holdFrames, THEN the scatter begins.
  const holdFrames = Math.max(0, Math.round((knobs.holdSeconds ?? 0) * fps));

  // Hand-off lands at A's global fadeEnd. letterScatter "out" fades all
  // letters in sync at (preHold + lastLetterEnd), so by that frame +
  // fadeFrames every A letter is at opacity 0. B starts there. Zero
  // co-existence, zero blank, and A doesn't disappear "one letter at a
  // time" because the fade is global.
  const bDelay = Math.ceil(
    holdFrames +
      Math.max(0, fromN - 1) * cfg.stagger +
      cfg.outDuration +
      FADE_FRAMES,
  );

  // B's "in" intrinsic (frame at which the last letter reaches home).
  const toIntrinsic = Math.max(0, toN - 1) * cfg.stagger + cfg.inDuration;
  const totalFrames = bDelay + Math.ceil(toIntrinsic) + 4;

  // pick a different seed for B so its scatter pattern differs from A's
  const seedB = seed + 100;
  const brandFont = knobs.fontFamily ?? ctx.brand.fontFamily;

  const elementA: TextElementSpec = {
    element: "text",
    id: "from",
    base: {
      text: knobs.fromText,
      fontSize,
      fontWeight,
      color,
      ...(brandFont ? { fontFamily: brandFont } : {}),
    },
    layers: [
      {
        type: "letter_scatter",
        role: "in",
        props: {
          mode: "out",
          spread,
          seed,
          stagger: cfg.stagger,
          duration: cfg.outDuration,
          scatterHold: cfg.scatterHold,
          fadeFrames: FADE_FRAMES,
          easing: "easeOut",
          preHold: holdFrames,
        },
      },
      // (1) Intro shrink: oversized → normal during the hold window. Only
      //     contributes when holdFrames > 0; otherwise it lerps 1→1 and is
      //     a no-op (but harmless).
      {
        type: "scale",
        role: "in",
        props: {
          from: holdFrames > 0 ? INTRO_SCALE : 1,
          to: 1,
          duration: Math.max(1, holdFrames),
          easing: "easeOutQuart",
        },
      },
      // (2) Scatter dip: normal → SCALE_MIN across the scatter window so
      //     A meets B at SCALE_MIN at the swap. Multiplies with (1) so
      //     after holdFrames the running scale is 1*1=1, then dips.
      {
        type: "scale",
        role: "in",
        props: {
          from: 1,
          to: SCALE_MIN,
          duration: bDelay - holdFrames,
          easing: "easeInOut",
          delay: holdFrames,
        },
      },
    ],
  };

  const elementB: TextElementSpec = {
    element: "text",
    id: "to",
    base: {
      text: knobs.toText,
      fontSize,
      fontWeight,
      color,
      ...(brandFont ? { fontFamily: brandFont } : {}),
    },
    layers: [
      {
        type: "letter_scatter",
        role: "in",
        props: {
          mode: "in",
          spread,
          seed: seedB,
          stagger: cfg.stagger,
          duration: cfg.inDuration,
          easing: "easeOutQuart",
          delay: bDelay,
        },
      },
      // Recovery to full scale during assembly. Starts at SCALE_MIN
      // (same value A finished at) so the size is continuous across
      // the swap frame.
      {
        type: "scale",
        role: "in",
        props: {
          from: SCALE_MIN,
          to: 1,
          duration: Math.ceil(toIntrinsic),
          easing: "easeOutQuart",
          delay: bDelay,
        },
      },
    ],
  };

  return {
    duration: totalFrames / fps,
    transition_out: "hard_cut",
    elements: [elementA, elementB],
  };
}
