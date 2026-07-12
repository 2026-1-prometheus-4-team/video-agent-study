// effects/transitions.ts
// TEXT_MOTION_SPEC 5.2 — text_collapse_fill.
// Three hardcoded phases at the end of a scene:
//   collapse (collapseFrames): scaleY 1 -> 0.06, scaleX 1 -> 1.3,
//                              blur 0 -> 14 (horizontal smear).
//   bar    (instant on transition mid): centered horizontal bar at 4% screen
//                                       height, gradient fill.
//   fill   (fillFrames): bar 4% -> 100% screen height (easeOutExpo). After
//                        this the next scene starts fullscreen.

import React from "react";
import { clamp, ease, lerp } from "../core/easing";

export type TextCollapseFillSpec = {
  type: "text_collapse_fill";
  stops: string[];
  collapseFrames?: number;
  fillFrames?: number;
};

export type CollapseFillStyles = {
  textWrap?: React.CSSProperties;
  bar?: React.CSSProperties;
  fillOverlay?: React.CSSProperties;
};

export function collapseFillStyles(
  spec: TextCollapseFillSpec,
  frame: number,
  sceneFrames: number,
  _width: number,
): CollapseFillStyles | null {
  const collapseFrames = clamp(spec.collapseFrames ?? 12, 4, 30);
  const fillFrames = clamp(spec.fillFrames ?? 12, 4, 30);
  const startFrame = sceneFrames - collapseFrames - fillFrames;
  const f = frame - startFrame;
  if (f < 0) return null;

  const stops = spec.stops?.length ? spec.stops : ["#FFFFFF"];
  const gradient = `linear-gradient(90deg, ${stops.join(", ")})`;

  if (f <= collapseFrames) {
    const t = ease(f, collapseFrames, "easeOutExpo");
    const scaleY = lerp(1, 0.06, t);
    const scaleX = lerp(1, 1.3, t);
    const blurPx = lerp(0, 14, t);
    return {
      textWrap: {
        transform: `scaleY(${scaleY.toFixed(3)}) scaleX(${scaleX.toFixed(3)})`,
        filter: `blur(${blurPx.toFixed(2)}px)`,
        transformOrigin: "50% 50%",
      },
    };
  }

  // bar + fill phase: bar grows from 4% -> 100% of screen height,
  // centered vertically. Text is hidden.
  const fillT = ease(f - collapseFrames, fillFrames, "easeOutExpo");
  const heightPct = lerp(4, 100, fillT);
  return {
    textWrap: { display: "none" },
    bar: {
      position: "absolute",
      left: 0,
      right: 0,
      top: `${((100 - heightPct) / 2).toFixed(2)}%`,
      height: `${heightPct.toFixed(2)}%`,
      background: gradient,
    },
  };
}

// ===========================================================================
// Scene exit transitions (transition_out)
// ---------------------------------------------------------------------------
// Same contract as collapseFillStyles: given the current frame and the scene
// length, return CSS applied over the last N frames of the OUTGOING scene
// (null before the window starts). Scenes are sequenced back-to-back (no
// overlap), so a transition is an EXIT deformation of the leaving scene, not
// a cross-fade of two scenes.
//
// All numbers are measured from the ad analysis, not invented:
//   - premium_motion_factors.md : hard cut dominates; high-energy cuts are
//     hidden by blur / glow / luminance (factor 5); dissolve is rare (fade
//     already covers it). So the useful additions are momentum / reveal /
//     cut-hiding exits, not more cross-fades.
//   - base44_analysis.md        : dashboard push ~250 px/sec; zoom 1.0->1.5
//     with the orb filling screen in ~0.3s (~9-10 frames).

export type SlidePushSpec = {
  type: "slide_push";
  direction?: "left" | "right" | "up" | "down";
  frames?: number;
};
export type ZoomPunchSpec = {
  type: "zoom_punch";
  toScale?: number;
  frames?: number;
};
export type WipeCollapseSpec = {
  type: "wipe_collapse";
  direction?: "left" | "right" | "up" | "down";
  frames?: number;
};
export type LightSweepSpec = {
  type: "light_sweep";
  color?: string;
  angle?: number;
  frames?: number;
};

// Applied to the outgoing scene's full-scene wrapper (sceneWrap) or as a
// full-screen overlay above it (overlay). SceneRenderer merges these the
// same way it already applies fadeOut opacity and collapse styles.
export type SceneExitStyles = {
  sceneWrap?: React.CSSProperties;
  overlay?: React.CSSProperties;
};

function exitWindow(frame: number, sceneFrames: number, frames: number): number | null {
  const start = sceneFrames - frames;
  const f = frame - start;
  return f < 0 ? null : f;
}

// slide_push: the outgoing scene slides off-frame. Momentum cut, not a
// dissolve. Measured travel ~250 px/sec (base44 dashboard push); here the
// full-scene slide runs over `frames` with an ease so it lands off-screen.
export function slidePushStyles(spec: SlidePushSpec, frame: number, sceneFrames: number): SceneExitStyles | null {
  const frames = clamp(spec.frames ?? 12, 4, 30);
  const f = exitWindow(frame, sceneFrames, frames);
  if (f === null) return null;
  const t = ease(f, frames, "easeInOut");
  const dir = spec.direction ?? "left";
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "left" || dir === "up" ? -1 : 1;
  const pct = lerp(0, 100, t) * sign;
  const axis = horizontal ? "translateX" : "translateY";
  return { sceneWrap: { transform: `${axis}(${pct.toFixed(2)}%)` } };
}

// zoom_punch: the outgoing scene scales up and fades, reading as "diving in"
// to the next scene. Measured (base44): zoom 1.0 -> 1.5 over ~0.3s (~10f).
export function zoomPunchStyles(spec: ZoomPunchSpec, frame: number, sceneFrames: number): SceneExitStyles | null {
  const frames = clamp(spec.frames ?? 10, 4, 30);
  const f = exitWindow(frame, sceneFrames, frames);
  if (f === null) return null;
  const t = ease(f, frames, "easeInOut");
  const scale = lerp(1, spec.toScale ?? 1.5, t);
  const opacity = lerp(1, 0, t);
  return { sceneWrap: { transform: `scale(${scale.toFixed(3)})`, opacity, transformOrigin: "50% 50%" } };
}

// wipe_collapse: a clip edge closes across the outgoing scene, revealing the
// next scene beneath. A cut-hiding reveal (glossary A-11 mask transition).
export function wipeCollapseStyles(spec: WipeCollapseSpec, frame: number, sceneFrames: number): SceneExitStyles | null {
  const frames = clamp(spec.frames ?? 14, 4, 30);
  const f = exitWindow(frame, sceneFrames, frames);
  if (f === null) return null;
  const t = ease(f, frames, "easeInOut");
  const edge = lerp(0, 100, t);
  const dir = spec.direction ?? "left";
  const clip =
    dir === "left"
      ? `inset(0 0 0 ${edge.toFixed(2)}%)`
      : dir === "right"
        ? `inset(0 ${edge.toFixed(2)}% 0 0)`
        : dir === "up"
          ? `inset(0 0 ${edge.toFixed(2)}% 0)`
          : `inset(${edge.toFixed(2)}% 0 0 0)`;
  return { sceneWrap: { clipPath: clip } };
}

// light_sweep: a bright band sweeps across and the cut happens under the
// flash. Measured intent (premium factor 5): hide high-energy cuts behind a
// luminance flash. Overlay only; pair with a hard cut to the next scene.
export function lightSweepStyles(spec: LightSweepSpec, frame: number, sceneFrames: number): SceneExitStyles | null {
  const frames = clamp(spec.frames ?? 12, 4, 30);
  const f = exitWindow(frame, sceneFrames, frames);
  if (f === null) return null;
  const half = frames / 2;
  const sweep = lerp(-40, 140, ease(f, frames, "easeInOut"));
  const glow =
    f < half
      ? lerp(0, 0.9, ease(f, half, "easeInOut"))
      : lerp(0.9, 0, ease(f - half, half, "easeInOut"));
  const color = spec.color ?? "#ffffff";
  const angle = spec.angle ?? 110;
  return {
    overlay: {
      background: `linear-gradient(${angle}deg, transparent ${(sweep - 18).toFixed(0)}%, ${color} ${sweep.toFixed(0)}%, transparent ${(sweep + 18).toFixed(0)}%)`,
      opacity: glow,
      mixBlendMode: "screen",
    },
  };
}
