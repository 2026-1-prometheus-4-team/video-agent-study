/**
 * transitions — scene-to-scene transition wrappers.
 *
 * Numbers measured from the project's ad analysis, not invented:
 *   - premium_motion_factors.md  (A-8 dissolve 0-2 per video / 1-6 frames;
 *                                 factor 5: high-energy cuts hidden by
 *                                 blur / glow / luma inversion; hard cut dominates)
 *   - base44_analysis.md         (hard cut + 5-10f cross-fade; zoom 1.0->1.5;
 *                                 orb full-screen zoom in ~0.3s = ~9f;
 *                                 color sweep + dissolve "magic" transition)
 *
 * Rule of thumb from the analysis: the HARD CUT is the default. Reach for
 * these only when the beat earns it. Dissolve especially is rare and short.
 *
 * Usage context for LLM:
 *   - soft, premium, mood/time shift  -> Dissolve   (rare, 1-6 frames)
 *   - momentum, "next", product tour  -> SlidePush
 *   - hype / brand sting (hide cut)   -> LightSweep
 *   - reveal, "made right here"       -> MaskWipe
 *   - immersive "enter the app"       -> ZoomTransition
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

/** Shared progress 0..1 across the transition window. */
function useTransitionProgress(startFrame: number, durationFrames: number, easing: (t: number) => number): number {
  const frame = useCurrentFrame();
  const local = frame - startFrame;
  return interpolate(local, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

/**
 * Dissolve — short cross-fade for a soft, filmic handover.
 *
 * Measured (premium A-8): dissolves appear 0-2 times per video and last only
 * 1-6 frames; the hard cut carries the rest. Default 6 frames. Use only for
 * mood or time-passage shifts, never as a default "smoother".
 */
export interface DissolveProps {
  outgoing: React.ReactNode;
  incoming: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  style?: React.CSSProperties;
}

export const Dissolve: React.FC<DissolveProps> = ({
  outgoing,
  incoming,
  startFrame,
  durationFrames = 6,
  style = {},
}) => {
  const p = useTransitionProgress(startFrame, durationFrames, Easing.inOut(Easing.cubic));
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill style={{ opacity: 1 - p, transform: `scale(${1 + p * 0.02})` }}>{outgoing}</AbsoluteFill>
      <AbsoluteFill style={{ opacity: p, transform: `scale(${1 - (1 - p) * 0.02})` }}>{incoming}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * SlidePush — outgoing is pushed off-frame as incoming slides in behind it.
 *
 * A crisp momentum cut (not a dissolve). Measured band for such moves is
 * short; default 12 frames. `direction` is the travel of the outgoing scene.
 * Usage: forward momentum, "next step", carousels, product tours.
 */
export interface SlidePushProps {
  outgoing: React.ReactNode;
  incoming: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  direction?: "left" | "right" | "up" | "down";
  style?: React.CSSProperties;
}

export const SlidePush: React.FC<SlidePushProps> = ({
  outgoing,
  incoming,
  startFrame,
  durationFrames = 12,
  direction = "left",
  style = {},
}) => {
  const p = useTransitionProgress(startFrame, durationFrames, Easing.out(Easing.cubic));
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const axis = horizontal ? "translateX" : "translateY";
  const outOffset = p * 100 * sign;
  const inOffset = (p - 1) * 100 * sign;
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill style={{ transform: `${axis}(${inOffset}%)` }}>{incoming}</AbsoluteFill>
      <AbsoluteFill style={{ transform: `${axis}(${outOffset}%)` }}>{outgoing}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * LightSweep — a bright band sweeps across; content swaps under the flash.
 *
 * Measured (premium factor 5): high-energy transitions hide the cut behind
 * blur / glow / luminance inversion. base44 uses a color-sweep + dissolve
 * "magic" transition. The swap happens at the sweep's peak so the cut is
 * masked by light. Default 12 frames.
 */
export interface LightSweepProps {
  outgoing: React.ReactNode;
  incoming: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  angle?: number;
  color?: string;
  style?: React.CSSProperties;
}

export const LightSweep: React.FC<LightSweepProps> = ({
  outgoing,
  incoming,
  startFrame,
  durationFrames = 12,
  angle = 110,
  color = "#ffffff",
  style = {},
}) => {
  const p = useTransitionProgress(startFrame, durationFrames, Easing.inOut(Easing.cubic));
  const sweep = interpolate(p, [0, 1], [-40, 140]);
  const glow = interpolate(p, [0, 0.5, 1], [0, 0.9, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const showIncoming = p >= 0.5;
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill>{showIncoming ? incoming : outgoing}</AbsoluteFill>
      <AbsoluteFill
        style={{
          background: `linear-gradient(${angle}deg, transparent ${sweep - 18}%, ${color} ${sweep}%, transparent ${sweep + 18}%)`,
          opacity: glow,
          mixBlendMode: "screen",
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * MaskWipe — incoming is revealed through an expanding mask over outgoing.
 *
 * Measured intent (base44): "the next content is built in the same spot" —
 * a cause-effect reveal, not a slide. glossary A-11 mask transition, UI-native.
 * `circle` grows from a point; `linear` wipes across an edge. Default 16 frames.
 */
export interface MaskWipeProps {
  outgoing: React.ReactNode;
  incoming: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  shape?: "circle" | "linear";
  originX?: number;
  originY?: number;
  direction?: "left" | "right" | "up" | "down";
  style?: React.CSSProperties;
}

export const MaskWipe: React.FC<MaskWipeProps> = ({
  outgoing,
  incoming,
  startFrame,
  durationFrames = 16,
  shape = "circle",
  originX = 50,
  originY = 50,
  direction = "left",
  style = {},
}) => {
  const p = useTransitionProgress(startFrame, durationFrames, Easing.inOut(Easing.cubic));
  let clip: string;
  if (shape === "circle") {
    const r = interpolate(p, [0, 1], [0, 150]);
    clip = `circle(${r}% at ${originX}% ${originY}%)`;
  } else {
    const edge = interpolate(p, [0, 1], [0, 100]);
    clip =
      direction === "left"
        ? `inset(0 ${100 - edge}% 0 0)`
        : direction === "right"
          ? `inset(0 0 0 ${100 - edge}%)`
          : direction === "up"
            ? `inset(0 0 ${100 - edge}% 0)`
            : `inset(${100 - edge}% 0 0 0)`;
  }
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill>{outgoing}</AbsoluteFill>
      <AbsoluteFill style={{ clipPath: clip }}>{incoming}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * ZoomTransition — punch through: outgoing scales up and fades as incoming
 * rises from slightly small. Reads as "entering" the next scene.
 *
 * Measured (base44): zoom in scale 1.0 -> 1.5 with origin shift; the orb
 * fills the screen in ~0.3s (~9-10 frames). Default 10 frames, outgoing to 1.5.
 * Usage: device-to-app, "dive in", immersive handoffs.
 */
export interface ZoomTransitionProps {
  outgoing: React.ReactNode;
  incoming: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  style?: React.CSSProperties;
}

export const ZoomTransition: React.FC<ZoomTransitionProps> = ({
  outgoing,
  incoming,
  startFrame,
  durationFrames = 10,
  style = {},
}) => {
  const p = useTransitionProgress(startFrame, durationFrames, Easing.bezier(0.5, 0, 0.2, 1));
  const outScale = interpolate(p, [0, 1], [1, 1.5]);
  const inScale = interpolate(p, [0, 1], [0.85, 1]);
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill style={{ opacity: 1 - p, transform: `scale(${outScale})` }}>{outgoing}</AbsoluteFill>
      <AbsoluteFill style={{ opacity: p, transform: `scale(${inScale})` }}>{incoming}</AbsoluteFill>
    </AbsoluteFill>
  );
};
