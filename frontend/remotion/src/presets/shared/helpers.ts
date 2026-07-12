// presets/shared/helpers.ts
// Tiny utilities reused by more than one preset. Each function is
// data-in / data-out (no SceneSpec assembly here) so presets can compose
// them freely.

import type { PaletteValue } from "../../motion/color/engine";

// palette values for one timeline entry: every word is `null` except the
// highlighted index which carries the gradient. Used by `statement`.
export function highlightAt(
  wordCount: number,
  highlightIdx: number,
  stops: string[],
): PaletteValue[] {
  const values: PaletteValue[] = new Array(wordCount).fill(null);
  if (highlightIdx >= 0 && highlightIdx < wordCount) {
    values[highlightIdx] = { type: "gradient", stops };
  }
  return values;
}

// Build 2-stop gradients by walking the cycle pairwise and wrapping back to
// the head, so the timeline can loop without a visible seam.
export function cycleGradientStops(cycle: string[]): string[][] {
  if (cycle.length === 0) return [["#FFFFFF", "#FFFFFF"]];
  if (cycle.length === 1) return [[cycle[0], cycle[0]]];
  return cycle.map((_, i) => [cycle[i], cycle[(i + 1) % cycle.length]]);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Rotate a stop array by k positions, wrapping. Used by `hero_zoom` to
// generate the 3 looping color permutations from one base palette.
export function rotateStops(stops: string[], k: number): string[] {
  if (stops.length === 0) return ["#FFFFFF"];
  return stops.map((_, i) => stops[(i + k) % stops.length]);
}
