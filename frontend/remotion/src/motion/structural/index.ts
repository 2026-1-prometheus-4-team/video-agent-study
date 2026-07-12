// structural/index.ts
// Structural atom barrel + dynamic registry. Each *.tsx file that
// exports `name` (and optionally `labPreset`) self-registers. Files
// without `name` (e.g. splitText, which is a shared utility) are
// silently skipped. Named re-exports below stay explicit so consumers
// (ComposedText, Lab) keep stable import paths even though the
// per-atom `name` exports would otherwise collide on `export *`.

import type { IntrinsicDurationFn, LabPreset } from "../wrappers";

export { splitText, unitCount, renderLetters, setLetterCurve, cursorCss, measureText, measureTextBox } from "./splitText";
export type { Letter } from "./splitText";
export { typewriterVisible } from "./typewriter";
export type { TypewriterProps, TypewriterState } from "./typewriter";
export { letterStaggerStyle } from "./letterStagger";
export type { LetterStaggerProps } from "./letterStagger";
export { letterFlickerStyle } from "./letterFlicker";
export type { LetterFlickerProps } from "./letterFlicker";
export { letterScatterStyle } from "./letterScatter";
export type { LetterScatterProps } from "./letterScatter";
export { letterChoreoState, choreoStyle } from "./letterChoreography";
export type { LetterChoreoProps, ChoreoKeyframe } from "./letterChoreography";
export { statRevealState } from "./statReveal";
export type {
  StatRevealProps,
  StatRevealFrame,
  StatRevealLetter,
} from "./statReveal";
export {
  letterRollState,
  reelCharAt,
  LetterReel,
  DEFAULT_ROLL_CHARSET,
} from "./letterRoll";
export type { LetterRollProps, LetterRollState } from "./letterRoll";

type StructuralAtomModule = {
  name?: unknown;
  labPreset?: unknown;
  intrinsicDuration?: unknown;
};

function buildRegistry(): {
  set: Set<string>;
  presets: Record<string, LabPreset>;
  meta: Record<string, LabPreset>;
  intrinsic: Record<string, IntrinsicDurationFn>;
} {
  const set = new Set<string>();
  const presets: Record<string, LabPreset> = {};
  const meta: Record<string, LabPreset> = {};
  const intrinsic: Record<string, IntrinsicDurationFn> = {};
  const ctx = require.context("./", false, /\.tsx?$/);
  for (const key of ctx.keys()) {
    if (/index\.[tj]sx?$/.test(key)) continue;
    const mod = ctx(key) as StructuralAtomModule;
    if (typeof mod.name !== "string") continue;
    set.add(mod.name);
    if (mod.labPreset && typeof mod.labPreset === "object") {
      presets[mod.name] = mod.labPreset as LabPreset;
      meta[mod.name] = mod.labPreset as LabPreset;
    }
    if (typeof mod.intrinsicDuration === "function") {
      intrinsic[mod.name] = mod.intrinsicDuration as IntrinsicDurationFn;
    }
  }
  return { set, presets, meta, intrinsic };
}

const REGISTRY = buildRegistry();

export const STRUCTURAL: Set<string> = REGISTRY.set;
export const STRUCTURAL_LAB_PRESETS: Record<string, LabPreset> = REGISTRY.presets;
export const STRUCTURAL_REGISTRY: Record<string, LabPreset> = REGISTRY.meta;
export const STRUCTURAL_INTRINSIC: Record<string, IntrinsicDurationFn> = REGISTRY.intrinsic;
