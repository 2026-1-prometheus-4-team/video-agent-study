// timing.ts
// Phase-based layer timing resolution.
//
//   enter phase = max intrinsic duration of layers with role "in"
//   exit phase  = max intrinsic duration of layers with role "out"
//   hold phase  = (sceneFrames - enter - exit)   when fit:"fixed"
//                 max intrinsic of role "hold"   when fit:"auto"
//   total       = enter + hold + exit            (used as requiredFrames)
//
// Role mapping for startFrame:
//   in       : delay
//   afterIn  : enter + (props.lead ?? 0) + delay
//   hold     : enter + delay
//   out      : total - intrinsic                 (= enter + hold)
//
// Atoms expose intrinsicDuration via the WRAPPER_INTRINSIC /
// STRUCTURAL_INTRINSIC registries. Layers without an intrinsicDuration
// fall back to defaultDuration so legacy specs still work.

import { clamp } from "./easing";

export type Role = "in" | "hold" | "out" | "afterIn";

export type MotionLayer = {
  type: string;
  role: Role;
  props?: Record<string, unknown>;
};

export type TimedLayer = MotionLayer & {
  startFrame: number;
  window: number;
};

export type IntrinsicProvider = (
  layer: MotionLayer,
  ctx: { fps: number; unitCount: number },
) => number;

export type SceneFit = "auto" | "fixed";

const DEFAULT_WRAPPER_DURATION = 18;

// Per-type props slices used only for fallback duration. Atoms own the
// canonical typed shape; this is the minimal subset defaultDuration needs.
type DurationProps = {
  duration?: number;
  charsPerSecond?: number;
  wordGap?: number;
  firstGap?: number;
  lastGap?: number;
  staggerTotal?: number;
  perLetter?: { duration?: number };
};

const TYPEWRITER_SETTLE = 6;

export function defaultDuration(
  layer: MotionLayer,
  ctx: { fps: number; unitCount: number },
): number {
  const p = (layer.props ?? {}) as DurationProps;
  if (typeof p.duration === "number") return Math.max(1, p.duration);
  if (layer.type === "typewriter") {
    if (typeof p.wordGap === "number") {
      const wordGap = Math.max(1, p.wordGap);
      const firstGap = Math.max(1, p.firstGap ?? p.wordGap);
      const lastGap =
        typeof p.lastGap === "number" ? Math.max(1, p.lastGap) : wordGap;
      const middleGaps = Math.max(0, ctx.unitCount - 3);
      const beats =
        firstGap +
        middleGaps * wordGap +
        (ctx.unitCount >= 3 ? lastGap : 0);
      return Math.max(1, beats + TYPEWRITER_SETTLE);
    }
    const cps = clamp(p.charsPerSecond ?? 14, 2, 60);
    return Math.ceil((ctx.unitCount / cps) * ctx.fps) + 4;
  }
  if (layer.type === "letter_stagger") {
    const staggerTotal = clamp(p.staggerTotal ?? 18, 1, 120);
    const perLetter = clamp(p.perLetter?.duration ?? 10, 1, 60);
    return staggerTotal + perLetter;
  }
  if (layer.type === "path_in") return clamp(p.duration ?? 30, 8, 120);
  return DEFAULT_WRAPPER_DURATION;
}

function intrinsicFor(
  intrinsic: IntrinsicProvider | undefined,
  layer: MotionLayer,
  ctx: { fps: number; unitCount: number },
): number {
  if (intrinsic) {
    const v = intrinsic(layer, ctx);
    if (Number.isFinite(v)) return Math.max(1, v);
  }
  return defaultDuration(layer, ctx);
}

// Sum of enter + hold + exit. Used by SceneRenderer when fit:"auto" so a
// scene can size itself to its content.
export function requiredFrames(
  layers: MotionLayer[],
  ctx: { fps: number; unitCount: number },
  intrinsic?: IntrinsicProvider,
): number {
  let enterMax = 0;
  let holdMax = 0;
  let exitMax = 0;
  let afterInReach = 0; // enterMax + lead + intrinsic of the latest afterIn
  for (const l of layers) {
    const d = intrinsicFor(intrinsic, l, ctx);
    if (l.role === "in") enterMax = Math.max(enterMax, d);
    else if (l.role === "out") exitMax = Math.max(exitMax, d);
    else if (l.role === "hold") holdMax = Math.max(holdMax, d);
  }
  // afterIn reach can extend past enterMax + holdMax, so size the scene
  // to include it when fit:"auto".
  for (const l of layers) {
    if (l.role !== "afterIn") continue;
    const lead = (l.props?.lead as number | undefined) ?? 0;
    const d = intrinsicFor(intrinsic, l, ctx);
    afterInReach = Math.max(afterInReach, enterMax + lead + d);
  }
  return Math.max(enterMax + holdMax, afterInReach) + exitMax;
}

export function resolveTimings(
  layers: MotionLayer[],
  sceneFrames: number,
  ctx: { fps: number; unitCount: number },
  intrinsic?: IntrinsicProvider,
  fit: SceneFit = "fixed",
): TimedLayer[] {
  const durations = layers.map((l) => intrinsicFor(intrinsic, l, ctx));
  let enterMax = 0;
  let exitMax = 0;
  let holdIntrinsicMax = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    // afterIn anchors itself to enterMax + lead, so it must not feed back
    // into enterMax (would push its own start further away).
    if (l.role === "in") enterMax = Math.max(enterMax, durations[i]);
    else if (l.role === "out") exitMax = Math.max(exitMax, durations[i]);
    else if (l.role === "hold") holdIntrinsicMax = Math.max(holdIntrinsicMax, durations[i]);
  }

  const total =
    fit === "auto"
      ? enterMax + holdIntrinsicMax + exitMax
      : Math.max(sceneFrames, enterMax + exitMax);
  const holdLen =
    fit === "auto" ? holdIntrinsicMax : Math.max(0, total - enterMax - exitMax);

  return layers.map((l, i) => {
    const d = durations[i];
    const rawDelay = (l.props?.delay as number | undefined) ?? 0;
    const delay = Math.max(0, rawDelay);
    if (l.role === "in") {
      return { ...l, startFrame: delay, window: d };
    }
    if (l.role === "afterIn") {
      const lead = (l.props?.lead as number | undefined) ?? 0;
      return {
        ...l,
        startFrame: Math.max(0, enterMax + lead + delay),
        window: d,
      };
    }
    if (l.role === "out") {
      // delay anchors the start to (exit phase start + delay), with the
      // full intrinsic window preserved. Clamped to (total - intrinsic)
      // so a too-large delay can't push the layer's end past the scene
      // end (the layer just starts at its self-end instead of getting
      // truncated). Without delay the layer is pinned to total - d,
      // identical to the pre-delay behaviour.
      const defaultStart = Math.max(0, total - d);
      const startFrame =
        delay > 0
          ? Math.min(defaultStart, Math.max(0, total - exitMax) + delay)
          : defaultStart;
      return { ...l, startFrame, window: d };
    }
    // hold (or anything else): live inside the hold phase.
    return {
      ...l,
      startFrame: enterMax + delay,
      window: Math.max(0, holdLen - delay),
    };
  });
}
