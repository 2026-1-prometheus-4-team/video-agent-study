// effects/glow.ts
//
// Two paths:
//   A) element-wide glow (no wordIdx) — original 2-layer halo+core div clone
//      assembled via glowAuraLayers().
//   B) per-word glow (wordIdx set) — ComposedText drops a text-shadow on
//      the letters whose wordIdx matches. Same halo+core recipe encoded
//      as two CSS shadows. Used by glowTextShadow().
//
// Intensity can be a fixed number or a timeline (same hold/transition
// model the color engine uses), so the glow can pulse / fade with the
// reel's beats without touching the color spec.

import React from "react";
import { clamp } from "../core/easing";

export type GlowEntry = {
  intensity: number;
  hold?: number;
  transition?: number;
};

export type GlowSpec = {
  enabled?: boolean;
  color?: "auto" | string;
  intensity?: number; // used when timeline is absent
  radius?: number;
  breath?: boolean;
  wordIdx?: number; // if set, glow only that word
  timeline?: GlowEntry[];
  loop?: boolean;
};

// ---------------------------------------------------------------------------
// Element-wide glow (legacy path)
// ---------------------------------------------------------------------------

function baseStyle(
  spec: GlowSpec,
  intensity: number,
  blurPx: number,
): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    filter: `blur(${blurPx.toFixed(2)}px)`,
    opacity: intensity,
    color: spec.color && spec.color !== "auto" ? spec.color : undefined,
  };
}

export function glowAuraLayers(
  spec: GlowSpec | undefined,
  frame: number,
): React.CSSProperties[] {
  if (!spec || spec.enabled !== true) return [];
  // wordIdx is honoured by the renderer (it masks non-matching letters via
  // a scoped data-word-idx CSS rule on the clone) — the layer math is the
  // same either way.
  const intensity = effectiveIntensity(spec, frame);
  if (intensity < 0.01) return [];
  const radius = clamp(spec.radius ?? 36, 4, 120);
  return [
    baseStyle(spec, intensity * 0.5, radius),
    baseStyle(spec, intensity * 0.9, radius * 0.25),
  ];
}

// ---------------------------------------------------------------------------
// Per-word path
// ---------------------------------------------------------------------------

function intensityAtFrame(spec: GlowSpec, frame: number): number {
  const tl = spec.timeline;
  if (!tl || tl.length === 0) return clamp(spec.intensity ?? 0.6, 0, 1);
  const total = tl.reduce(
    (s, e) => s + (e.hold ?? 0) + (e.transition ?? 0),
    0,
  );
  let f = frame;
  if (spec.loop && total > 0) f = ((frame % total) + total) % total;
  let cursor = 0;
  for (let i = 0; i < tl.length; i++) {
    const e = tl[i];
    const hold = e.hold ?? 0;
    const trans = e.transition ?? 0;
    if (f < cursor + hold) return clamp(e.intensity, 0, 1);
    cursor += hold;
    if (trans > 0 && f < cursor + trans) {
      const next = tl[(i + 1) % tl.length] ?? e;
      const t = (f - cursor) / trans;
      return clamp(e.intensity + (next.intensity - e.intensity) * t, 0, 1);
    }
    cursor += trans;
  }
  return clamp(tl[tl.length - 1].intensity, 0, 1);
}

function effectiveIntensity(spec: GlowSpec, frame: number): number {
  const base = intensityAtFrame(spec, frame);
  if (!spec.breath) return base;
  return base * (0.75 + 0.25 * Math.sin(frame / 14));
}

// Parse a CSS color literal (#hex / #rrggbb / rgb(...)) into 0..255 channels.
function parseRgb(color: string): [number, number, number] {
  if (color.startsWith("#")) {
    let h = color.slice(1);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    if (!Number.isNaN(n) && h.length === 6) {
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
  }
  const m = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  return [255, 255, 255];
}

function toRgba(color: string, alpha: number): string {
  const [r, g, b] = parseRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

/**
 * Two stacked shadows (halo + core) on a single letter span. Returns ""
 * when the glow contributes nothing visible this frame.
 *
 * letterColor is whatever color the letter currently renders in; used
 * when spec.color is "auto".
 */
export function glowTextShadow(
  spec: GlowSpec | undefined,
  frame: number,
  letterColor: string,
): string {
  if (!spec || spec.enabled !== true) return "";
  const eff = effectiveIntensity(spec, frame);
  if (eff < 0.01) return "";
  const radius = clamp(spec.radius ?? 36, 4, 120);
  const source =
    spec.color && spec.color !== "auto" ? spec.color : letterColor;
  const halo = `0 0 ${radius.toFixed(1)}px ${toRgba(source, eff * 0.5)}`;
  const core = `0 0 ${(radius * 0.25).toFixed(1)}px ${toRgba(source, eff * 0.9)}`;
  return `${halo}, ${core}`;
}

/**
 * Same halo+core recipe as glowTextShadow, but emitted as CSS
 * filter: drop-shadow(...) instead of text-shadow. Use this for letters
 * whose fill is rendered via background-clip:text — text-shadow on a
 * transparent text fill bleeds into the glyph interior (the shadow is
 * drawn against the glyph outline, not the actual visible alpha), which
 * shows up as an off-color tint inside the letters. drop-shadow follows
 * the rendered alpha so the halo lives outside the glyph only.
 */
export function glowDropFilter(
  spec: GlowSpec | undefined,
  frame: number,
  letterColor: string,
): string {
  if (!spec || spec.enabled !== true) return "";
  const eff = effectiveIntensity(spec, frame);
  if (eff < 0.01) return "";
  const radius = clamp(spec.radius ?? 36, 4, 120);
  const source =
    spec.color && spec.color !== "auto" ? spec.color : letterColor;
  const halo = `drop-shadow(0 0 ${radius.toFixed(1)}px ${toRgba(source, eff * 0.5)})`;
  const core = `drop-shadow(0 0 ${(radius * 0.25).toFixed(1)}px ${toRgba(source, eff * 0.9)})`;
  return `${halo} ${core}`;
}
