// presets/index.ts
// Public entry. PRESETS is the flat dispatch registry — folder structure
// is for human navigation, not the LLM. PRESET_META describes each preset's
// intended role so a future prompt-builder can render the menu without
// reading every preset file.

import type { SceneSpec } from "../motion/SceneRenderer";
import type { PresetCtx } from "./shared/types";
import { punch, type PunchKnobs } from "./hook/punch";
import { roll, type RollKnobs } from "./hook/roll";
import { statement, type StatementKnobs } from "./statement/statement";
import { blurReveal, type BlurRevealKnobs } from "./statement/blur_reveal";
import { beat, type BeatKnobs } from "./beat/beat";
import { heroZoom, type HeroZoomKnobs } from "./hero/hero_zoom";
import { wordSwap, type WordSwapKnobs } from "./swap/word_swap";
import { scatterAssemble, type ScatterAssembleKnobs } from "./swap/scatter_assemble";
import { statCounter, type StatCounterKnobs } from "./data/stat_counter";
import { zoomCut, type ZoomCutKnobs } from "./transition/zoom_cut";

export type { Brand, PresetCtx, CommonKnobs } from "./shared/types";
export type { Emphasis } from "./shared/emphasis";
export type {
  EffectsOverride,
  GlowOverride,
  MotionBlurOverride,
} from "./shared/effects";
export type { PunchKnobs } from "./hook/punch";
export type { RollKnobs } from "./hook/roll";
export type { StatementKnobs } from "./statement/statement";
export type { BlurRevealKnobs } from "./statement/blur_reveal";
export type { BeatKnobs } from "./beat/beat";
export type { HeroZoomKnobs } from "./hero/hero_zoom";
export type { WordSwapKnobs } from "./swap/word_swap";
export type { ScatterAssembleKnobs } from "./swap/scatter_assemble";
export type { StatCounterKnobs } from "./data/stat_counter";
export type { ZoomCutKnobs } from "./transition/zoom_cut";

// Each entry adapts the typed preset fn to a uniform (knobs, ctx) => SceneSpec
// shape so dispatch can be flat. Cast happens at the boundary where the JSON
// knobs object becomes a typed Knobs — the JSON itself is unchecked.
type PresetFn = (knobs: Record<string, unknown>, ctx: PresetCtx) => SceneSpec;

export const PRESETS = {
  punch: ((knobs, ctx) => punch(knobs as unknown as PunchKnobs, ctx)) as PresetFn,
  roll: ((knobs, ctx) => roll(knobs as unknown as RollKnobs, ctx)) as PresetFn,
  statement: ((knobs, ctx) => statement(knobs as unknown as StatementKnobs, ctx)) as PresetFn,
  blur_reveal: ((knobs, ctx) => blurReveal(knobs as unknown as BlurRevealKnobs, ctx)) as PresetFn,
  beat: ((knobs, ctx) => beat(knobs as unknown as BeatKnobs, ctx)) as PresetFn,
  hero_zoom: ((knobs, ctx) => heroZoom(knobs as unknown as HeroZoomKnobs, ctx)) as PresetFn,
  word_swap: ((knobs, ctx) => wordSwap(knobs as unknown as WordSwapKnobs, ctx)) as PresetFn,
  scatter_assemble: ((knobs, ctx) => scatterAssemble(knobs as unknown as ScatterAssembleKnobs, ctx)) as PresetFn,
  stat_counter: ((knobs, ctx) => statCounter(knobs as unknown as StatCounterKnobs, ctx)) as PresetFn,
  zoom_cut: ((knobs, ctx) => zoomCut(knobs as unknown as ZoomCutKnobs, ctx)) as PresetFn,
} as const;

export type PresetName = keyof typeof PRESETS;

export function isPresetName(s: string): s is PresetName {
  return Object.prototype.hasOwnProperty.call(PRESETS, s);
}

export function expandPresetScene(
  preset: PresetName,
  knobs: Record<string, unknown>,
  ctx: PresetCtx,
): SceneSpec {
  const scene = PRESETS[preset](knobs, ctx);
  return applySceneShell(scene, knobs);
}

// Type-D scene-shell layer. Presets build content (Type C); these fields
// wrap the resulting scene at the orchestration level. Applied generically
// here so no preset re-implements them and a new shell field (camera,
// flash, whip) is a one-line addition, not a per-preset change.
function applySceneShell(
  scene: SceneSpec,
  knobs: Record<string, unknown>,
): SceneSpec {
  const bg = knobs.background;
  if (typeof bg === "string") {
    scene.background = { ...(scene.background ?? {}), color: bg };
  }
  const tout = knobs.transition_out;
  if (tout === "hard_cut" || tout === "fade") {
    scene.transition_out = tout;
  }
  return scene;
}

// ---------------------------------------------------------------------------
// Meta (LLM prompt-builder source of truth)
// ---------------------------------------------------------------------------

// Folder layout = category. New presets go under the matching category folder.
export type PresetCategory = "hook" | "statement" | "beat" | "hero" | "swap" | "data" | "transition";

// Subjective "how loud" — for sequencing arcs (low -> peak feels like a build).
export type PresetEnergy = "low" | "med" | "high" | "peak";

export type PresetMeta = {
  category: PresetCategory;
  energy: PresetEnergy;
  intent: string; // one-line description of when to reach for this preset
};

export const PRESET_META: Record<PresetName, PresetMeta> = {
  punch: {
    category: "hook",
    energy: "high",
    intent:
      "Short attention grab (1-3 words). Color sweeps through the letters and settles. Use to open or stamp.",
  },
  roll: {
    category: "hook",
    energy: "high",
    intent:
      "Single-word slot-machine reveal: each glyph spins on its own vertical reel in alternating directions, then locks onto its target letter. mode='stagger' (default) — reels stop sequentially left→right with a snappy quad tail (roulette feel, use for hype hits). mode='together' — all reels stop at the same frame with a long cubic coast tail (ball-rolling feel, use for relaxed reveals). All motion params are cemented — only mode/text/duration/style are exposed.",
  },
  statement: {
    category: "statement",
    energy: "med",
    intent:
      "Reveal a full sentence word-by-word with smooth reflow; spotlight one word with a looping highlight gradient. The main message carrier.",
  },
  blur_reveal: {
    category: "statement",
    energy: "med",
    intent:
      "Word-by-word reveal where each word appears with a heavy blur that resolves to sharp as it fades in. The dominant text-entrance pattern across app-launch ads (langease/numtera/nexus). Use for impactful headline or short-line reveals; reflow stays off so words sharpen in place rather than sliding.",
  },
  beat: {
    category: "beat",
    energy: "med",
    intent:
      "Single staccato word: fade-in then scale-up + blur on exit. Chain 2-3 in a row for a chant rhythm.",
  },
  hero_zoom: {
    category: "hero",
    energy: "peak",
    intent:
      "Final brand reveal. Large text with looping multi-stop gradient sweep, then scales down and slides out.",
  },
  word_swap: {
    category: "swap",
    energy: "high",
    intent:
      "Transformer-style word replacement. fromText scatters out along cardinal axes (vertical/horizontal slides, no diagonals), toText reassembles. Crossover is auto-timed so the swap is tangent — no blank frame, no overlap.",
  },
  scatter_assemble: {
    category: "swap",
    energy: "peak",
    intent:
      "biasafe-style opener. A long sentence (fromText) scatters out along cardinal axes and dissolves; only N survivor glyphs (N = assembleText length) stay, morph into assembleText (e.g. \"AI\"), converge to center and scale up huge. Use for a dramatic 'long phrase collapses into a short brand word' reveal. Keep assembleText to 1-3 chars.",
  },
  stat_counter: {
    category: "data",
    energy: "med",
    intent:
      "Stat reveal: a large number counts up with separators + prefix/suffix, gradient emphasis, and a soft settle. Optional caption above. Use ONLY for meaningful headline numbers (10,000+ users, $2.4M, 98%). Do NOT use for tiny values like '2x' or '1배' — the count-up has nothing to travel; use punch or roll for small multipliers instead.",
  },
  zoom_cut: {
    category: "transition",
    energy: "peak",
    intent:
      "Camera-dolly zoom that ends with a hard cut. fromText scales up with easeInBoost (fast initial, accelerating end). Zoom intensity is controlled by zoomSpeed (scale units per second) — same zoomSpeed value gives the same visual feel across any duration. Optional emergeText pin-emerges from a 1-px dot at the focal point starting at emergeAt (0..1 fraction of duration). Compose with a same-bg follow-up scene for an 'emerge' feel (invisible cut), or a different-bg follow-up scene for a visible cut/flash transition.",
  },
};
