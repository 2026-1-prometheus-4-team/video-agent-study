// presets/hook/roll.ts
// HOOK preset. Single-word vertical-slot-machine reveal — each glyph is
// its own reel that spins in alternating directions and locks onto its
// target letter, then PUNCHES UP and out (scale + blur) so the cut to
// the next scene reads as a "zoom-through" transition rather than a
// jarring interruption.
//
// Two modes for two pacing feels:
//
//   mode="stagger" (default) — reels stop sequentially left→right with
//     a snappy easeOutQuad tail. Slot-machine / roulette feel. Use for
//     emphasis, hits, hype beats.
//
//   mode="together" — all reels stop at the same frame with a long
//     cubic coast tail (the last ~16 frames the glyphs barely move
//     before locking). Ball-rolling / breather feel. Use for relaxed
//     reveals, slow-paced sections.
//
// DEFENSIVE PACING (the key LLM-resilience pattern):
//   * The preset computes its own intrinsic minimum (frames needed
//     for letter_roll to fully settle + exit).
//   * `duration` knob is a HINT, not a hard floor. If the LLM passes
//     a duration shorter than intrinsic, the preset CLAMPS UP — the
//     scene gets the time it needs and the animation never cuts off
//     mid-settle. If the duration is longer, the extra time becomes
//     dwell at scale 1 before the exit kicks in.
//   * The atom's internal `duration` knob is recomputed so the settle
//     frame aligns with sceneFrames - exitFrames exactly. No dead
//     space between settle and exit.
//   * Exit animation is baked: scale 1→1.25 + blur 0→8 over the last
//     8 frames. Gives every cut a "punch up" out-feel without needing
//     scene-to-scene coordination.
//
// CEMENTED — NOT exposed to the LLM:
//   * letterSpacing (-0.02em) — the tight kerning is integral to the
//     "stacked block" reel look.
//   * Exit shape and duration — punch-up + blur is the signature.
//   * All letter_roll structural knobs (rollSpeed, freeFrac, easePow,
//     stagger, blurFactor, seed, firstDir, charset).
//
// EXPOSED:
//   * text, fontSize, fontWeight, baseColor — text style surface.
//   * mode — which pacing feel.
//   * duration (optional) — hint, clamped to intrinsic minimum.
//   * effects — glow / motionBlur overrides.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";
import { emphMultiplier } from "../shared/emphasis";
import { mergeEffects } from "../shared/effects";

export type RollKnobs = CommonKnobs & {
  text: string;
  mode?: "stagger" | "together"; // default "stagger"
  baseColor?: string;
  /** Optional hint. If absent OR shorter than the intrinsic minimum
   *  (settle + 8-frame exit), the preset clamps up. Longer durations
   *  become dwell at scale 1 before the exit. */
  duration?: number;
};

const FPS = 24;
const EXIT_FRAMES = 8;
// Mode-aware atom defaults — kept in sync with letterRoll.tsx's
// mode-aware defaults so intrinsic calculations stay accurate.
const STAGGER_ATOM_DURATION = 28;
const STAGGER_INTER_LETTER = 2; // letterRoll DEFAULT_STAGGER
const TOGETHER_ATOM_DURATION = 96;

function nonSpaceCount(text: string): number {
  return Math.max(1, text.replace(/\s/g, "").length);
}

export function roll(knobs: RollKnobs, ctx: PresetCtx): SceneSpec {
  const mode = knobs.mode ?? "stagger";
  const mul = emphMultiplier(knobs.emphasis);
  const brandFont = knobs.fontFamily ?? ctx.brand.fontFamily;
  const n = nonSpaceCount(knobs.text);

  // Intrinsic atom-settle frames per mode. stagger fans the settle out
  // across letters; together locks everyone at the same frame.
  const intrinsicAtomFrames =
    mode === "stagger"
      ? STAGGER_ATOM_DURATION + (n - 1) * STAGGER_INTER_LETTER
      : TOGETHER_ATOM_DURATION;
  const intrinsicSceneFrames = intrinsicAtomFrames + EXIT_FRAMES;

  // Clamp user duration UP to intrinsic — never down. A short hint
  // produces the natural length; a long hint adds dwell before the exit.
  const userFrames = knobs.duration ? Math.round(knobs.duration * FPS) : 0;
  const sceneFrames = Math.max(intrinsicSceneFrames, userFrames);
  const sceneDuration = sceneFrames / FPS;

  // Atom internal `duration` recomputed so the settle frame lands
  // exactly EXIT_FRAMES before scene-end. No dead space between settle
  // and exit; no settle cutoff if the LLM picked a long sceneFrames.
  const atomSettleFrames = sceneFrames - EXIT_FRAMES;
  const atomDuration =
    mode === "stagger"
      ? atomSettleFrames - (n - 1) * STAGGER_INTER_LETTER
      : atomSettleFrames;

  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.text,
      fontSize: knobs.fontSize ?? 11,
      fontWeight: clampFontWeight(knobs.fontWeight, 800),
      letterSpacing: -0.02,
      color: knobs.baseColor ?? "#FFFFFF",
      ...(brandFont ? { fontFamily: brandFont } : {}),
    },
    layers: [
      {
        type: "letter_roll",
        role: "in",
        props: { settleMode: mode, duration: atomDuration },
      },
      // Baked exit: punch-up + blur over the last EXIT_FRAMES. easeIn so
      // the motion accelerates into the cut — feels like the word is
      // launching toward the camera at the moment of transition.
      {
        type: "scale",
        role: "out",
        props: { from: 1, to: 1.25, duration: EXIT_FRAMES, easing: "easeIn" },
      },
      {
        type: "blur",
        role: "out",
        props: { from: 0, to: 8, duration: EXIT_FRAMES, easing: "easeIn" },
      },
    ],
    effects: mergeEffects(undefined, knobs.effects, mul),
  };

  return {
    duration: sceneDuration,
    transition_out: "hard_cut",
    elements: [element],
  };
}
