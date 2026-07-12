// structural/letterScatter.tsx
// Transformer-style word swap atom. Each letter slides along exactly one
// cardinal axis (pure horizontal OR pure vertical) — no diagonal paths.
// The mechanical rectilinear quality is the whole aesthetic: letters
// click in and out of place like puzzle pieces or a robot folding /
// unfolding, NOT a random scatter.
//
// Mode contract:
//   "out" = letter starts at home, easeOut to its scattered position
//           (lands quickly, then sits visible), holds for `scatterHold`
//           frames, then fades out over `fadeFrames`. The hold + late
//           fade is what makes the scatter readable instead of a melt.
//   "in"  = letter starts at scattered, approaches home via Remotion
//           spring(). Slight under-damping gives the magnetic snap.
//
// Distance defaults are aggressive (spread=1.0 → scattered bbox ≈ 90% of
// the canvas in both axes) because the original reference videos explode
// to near-fullscreen. Axis selection is biased ~65/35 toward vertical so
// the vertical bbox stays well-populated even on short words.

import React from "react";
import { clamp, clamp01, ease, lerp, resolveEasing, type EasingName } from "../core/easing";
import { seededRandom } from "../core/random";
import type { Letter } from "./splitText";

export type LetterScatterProps = {
  mode?: "in" | "out";
  spread?: number; // 0..1, scattered max-distance as fraction of dim
  seed?: number;
  stagger?: number; // per-letter delay in frames
  rotation?: number; // max degrees of per-letter rotation; default 0 (robotic)
  // 0..1, share of letters that take the vertical axis. Default 0.65.
  // Measured biasafe scatter is near vertical-only (X actually compresses),
  // so set ~1.0 to stop letters fanning out horizontally.
  verticalBias?: number;
  // mode:"out" only. When >0, letters fade out STAGGERED instead of in
  // sync. Letters scattered farthest on the vertical axis fade first, ones
  // near the home line fade last, spread over this many frames. Measured
  // biasafe dissolve: the vertical extremes vanish first, center last.
  // 0 (default) keeps the original global-sync fade.
  fadeStaggerTotal?: number;
  // mode:"out". charIdx listed here do NOT dissolve — they are the
  // SURVIVORS. With `collapse` set they leave their scattered spot and
  // converge to a target while scaling up. biasafe: of the 35 scattered
  // glyphs only one "A" and one "I" survive and assemble into a big "AI".
  survivors?: number[];
  collapse?: {
    startFrame: number; // local frame the survivors start converging
    duration: number; // frames to reach the target
    scale?: number; // final scale of survivors (small glyph -> big AI)
    easing?: string; // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
    // charIdx -> translation target in px, RELATIVE TO that glyph's home
    // (scattered offset is lerped to this). Lets each survivor land where
    // the assembled word wants it.
    targets?: Record<string, { x: number; y: number }>;
  };
  duration?: number; // mode:"in" -> arrival length; mode:"out" -> launch length
  // named 또는 "cubic(...)" 커스텀 (에디터 커스텀 cubic() 지원).
  easing?: string; // mode:"out" launch curve (default easeOut), mode:"in" arrival curve (default easeOutQuart)
  scatterHold?: number; // mode:"out" only: frames to hold at scattered before fade
  fadeFrames?: number; // mode:"out" only: tail fade length
  preHold?: number; // mode:"out" only: frames to sit at home before launching
  // Deprecated: spring-based settle is gone. Remotion spring() leaves a long
  // sub-pixel tail that the browser re-anti-aliases every frame and the
  // text edges crackle. easing curves with a tight tail (easeOutQuart at
  // duration ~16 lands inside ~12 frames) read as a clean snap without
  // the shimmer. Field accepted for backward compatibility, ignored.
  spring?: { damping?: number; stiffness?: number; mass?: number };
};

const DEFAULT_IN_EASING: EasingName = "easeOutQuart";
const DEFAULT_IN_DURATION = 16;
const DEFAULT_DURATION = DEFAULT_IN_DURATION;
const DEFAULT_STAGGER = 1.2;
const DEFAULT_SPREAD = 1.0;
const DEFAULT_ROTATION = 0;
const DEFAULT_SEED = 7;
const DEFAULT_SCATTER_HOLD = 0;
const DEFAULT_FADE_FRAMES = 1;
const VERTICAL_BIAS = 0.65; // share of letters that take the vertical axis

// Pick a single cardinal axis + signed distance for letter i. dx OR dy is
// exactly zero (no diagonal). Vertical bias keeps the vertical bbox dense
// even on short words. Distance varies 0.7..1.0 of the max so the
// scattered set forms staggered rails rather than a uniform stripe.
//
// Horizontal direction is locked to the letter's position in the word
// (frac < 0.5 -> left, frac > 0.5 -> right) so paths never cross the
// word's home line. A letter sitting at the right end of "Ask anything"
// always scatters to the right; during assembly it returns from the
// right. Without this bias the right-end "n" could fly off-screen left,
// cross the entire word during re-entry, and the choreography reads as
// a mess. Vertical direction stays random because letters are arranged
// horizontally — vertical scatter just fans them perpendicular to the
// row, no crossings.
function scatterAxis(
  i: number,
  frac: number,
  spread: number,
  seed: number,
  width: number,
  height: number,
  verticalBias: number,
): { dx: number; dy: number; rotUnit: number } {
  const ra = seededRandom(seed + i * 31);
  const rd = seededRandom(seed + i * 71);
  const rl = seededRandom(seed + i * 113);
  const rr = seededRandom(seed + i * 191);
  const axis: "h" | "v" = ra() < verticalBias ? "v" : "h";
  const dir =
    axis === "h"
      ? frac < 0.5
        ? -1
        : frac > 0.5
        ? 1
        : rd() < 0.5
        ? -1
        : 1
      : rd() < 0.5
      ? -1
      : 1;
  const span = clamp01(spread);
  const lenFactor = 0.7 + rl() * 0.3; // 0.7..1.0
  // distance from center = dim * span * 0.5 * lenFactor  (so spread=1 +
  // lenFactor=1 places the letter at +-50% of the dim → bbox covers the
  // whole canvas)
  const dist =
    axis === "h"
      ? dir * width * span * 0.5 * lenFactor
      : dir * height * span * 0.5 * lenFactor;
  return {
    dx: axis === "h" ? dist : 0,
    dy: axis === "v" ? dist : 0,
    rotUnit: (rr() - 0.5) * 2,
  };
}

export function letterScatterStyle(
  l: Letter,
  totalChars: number,
  localFrame: number,
  fps: number,
  p: LetterScatterProps,
  ctx: { width: number; height: number },
): React.CSSProperties {
  if (l.isSpace) return {};
  const mode = p.mode ?? "in";
  const stagger = Math.max(0, p.stagger ?? DEFAULT_STAGGER);
  const spread = clamp01(p.spread ?? DEFAULT_SPREAD);
  const seed = p.seed ?? DEFAULT_SEED;
  const rotation = p.rotation ?? DEFAULT_ROTATION;
  const duration = clamp(p.duration ?? DEFAULT_DURATION, 1, 240);

  const verticalBias = clamp01(p.verticalBias ?? VERTICAL_BIAS);
  const cell = scatterAxis(l.charIdx, l.frac, spread, seed, ctx.width, ctx.height, verticalBias);
  const maxRot = cell.rotUnit * rotation;
  const delay = l.charIdx * stagger;
  const f = localFrame - delay;

  if (mode === "in") {
    // All letters appear at scattered the moment the layer starts —
    // visibility does NOT wait for per-letter stagger. The stagger only
    // controls when each letter starts MOVING toward home. This way a
    // tangent crossover (B.delay = A.fadeEnd) shows the full scattered
    // word the same frame A finishes, with no blank gap caused by a
    // staggered first letter that happens to land off-screen.
    // resolveEasing: named 는 기존과 동일, "cubic(...)" 커스텀도 지원 (에디터)
    const easeFn = resolveEasing(p.easing, DEFAULT_IN_EASING);
    const moveT = clamp01(Math.max(0, f) / duration);
    const e = easeFn(moveT);
    const dx = cell.dx * (1 - e);
    const dy = cell.dy * (1 - e);
    const rot = maxRot * (1 - e);
    return {
      transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg)`,
      transformOrigin: "center center",
      willChange: "transform",
      opacity: localFrame < 0 ? 0 : 1,
    };
  }

  // mode "out": each letter eases home -> scattered on its own staggered
  // timeline, but the FADE is synchronized across all letters — they
  // disappear in one beat at lastLetterEnd, not one-by-one. Per-letter
  // fade was rejected as visually "letters going out one at a time."
  // scatterHold default 0 keeps the time-at-scattered short.
  // preHold sits the letters at home (visible, no motion) for that many
  // frames before the launch begins — useful for "display, then scatter"
  // sequences. Layer scale wrappers handle any intro animation.
  const scatterHold = Math.max(0, p.scatterHold ?? DEFAULT_SCATTER_HOLD);
  const fadeFrames = Math.max(1, p.fadeFrames ?? DEFAULT_FADE_FRAMES);
  const preHold = Math.max(0, p.preHold ?? 0);
  // Re-base f so launch starts after preHold; before then f<0 and the
  // launch progress is 0 (letter stays at home).
  const launchF = f - preHold;
  const launchT = clamp01(Math.max(0, launchF) / duration);
  const e = ease(launchT * duration, duration, p.easing ?? "easeOut");
  const dx = cell.dx * e;
  const dy = cell.dy * e;
  const rot = maxRot * e;
  // survivor: 소멸하지 않고 collapse 타겟으로 모이며 확대한다. biasafe 의
  // "흩어진 글자 중 A·I 하나씩만 살아남아 가운데 AI 로 조립" 메커니즘.
  if ((p.survivors ?? []).indexOf(l.charIdx) !== -1) {
    if (p.collapse) {
      const cl = p.collapse;
      const ct = clamp01(Math.max(0, localFrame - cl.startFrame) / Math.max(1, cl.duration));
      // 에디터 커스텀 cubic() 지원 — 기본값(easeOutQuart)은 기존과 동일
      const ceFn = resolveEasing(cl.easing, "easeOutQuart");
      const ce = ceFn(ct);
      const tgt = cl.targets?.[String(l.charIdx)] ?? { x: 0, y: 0 };
      const tx = lerp(dx, tgt.x, ce);
      const ty = lerp(dy, tgt.y, ce);
      const sc = lerp(1, cl.scale ?? 1, ce);
      return {
        transform: `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${sc.toFixed(3)})`,
        transformOrigin: "center center",
        willChange: "transform",
        opacity: localFrame < 0 ? 0 : 1,
      };
    }
    // collapse 가 없으면 흩어진 자리에 그대로 남는다(소멸만 면제).
    return {
      transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg)`,
      transformOrigin: "center center",
      willChange: "transform",
      opacity: localFrame < 0 ? 0 : 1,
    };
  }
  // Global fade aligned with the last-staggered letter finishing its
  // launch — measured from the END of preHold, so adding preHold shifts
  // the whole motion timeline later without shortening anything.
  const lastLetterEnd = preHold + (totalChars - 1) * stagger + duration + scatterHold;
  const baseFadeStart = lastLetterEnd;
  // fadeStaggerTotal: 세로로 가장 멀리 흩어진 글자(|dy| 큰)부터 먼저 소멸.
  // dissolveOrder 0 = 세로 끝(먼저), 1 = home 근처(나중). 전체를
  // fadeStaggerTotal 프레임에 펼친다. 0이면 모든 글자 baseFadeStart 동시.
  const fadeStaggerTotal = Math.max(0, p.fadeStaggerTotal ?? 0);
  const maxV = ctx.height * spread * 0.5;
  const vNorm = clamp01(Math.abs(cell.dy) / Math.max(1, maxV));
  const dissolveOrder = 1 - vNorm;
  const fadeStart = baseFadeStart + dissolveOrder * fadeStaggerTotal;
  const fadeEnd = fadeStart + fadeFrames;
  let opacity = 1;
  // Visibility tied to the layer (localFrame), not per-letter — letter is
  // visible at home from layer start, then takes off after preHold.
  if (localFrame < 0) opacity = 0;
  else if (localFrame >= fadeEnd) opacity = 0;
  else if (localFrame > fadeStart) opacity = 1 - (localFrame - fadeStart) / fadeFrames;
  return {
    transform: `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg)`,
    transformOrigin: "center center",
    willChange: "transform",
    opacity,
  };
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as LetterScatterProps & { duration?: number };
  const stagger = Math.max(0, p.stagger ?? DEFAULT_STAGGER);
  const duration = clamp(p.duration ?? DEFAULT_DURATION, 1, 240);
  const lastDelay = Math.max(0, ctx.unitCount - 1) * stagger;
  if ((p.mode ?? "in") === "out") {
    const scatterHold = Math.max(0, p.scatterHold ?? DEFAULT_SCATTER_HOLD);
    const fadeFrames = Math.max(1, p.fadeFrames ?? DEFAULT_FADE_FRAMES);
    const preHold = Math.max(0, p.preHold ?? 0);
    return Math.max(1, Math.ceil(preHold + lastDelay + duration + scatterHold + fadeFrames));
  }
  return Math.max(1, Math.ceil(lastDelay + duration));
}

export const name = "letter_scatter";
export const labPreset = {
  role: "in" as const,
  props: {
    mode: "in",
    spread: DEFAULT_SPREAD,
    seed: DEFAULT_SEED,
    stagger: DEFAULT_STAGGER,
    rotation: DEFAULT_ROTATION,
    duration: DEFAULT_IN_DURATION,
  } as Record<string, unknown>,
};
