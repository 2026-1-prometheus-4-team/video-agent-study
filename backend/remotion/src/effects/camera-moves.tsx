/**
 * camera-moves — virtual camera motion for scene content.
 *
 * IMPORTANT: the numbers here are not invented. Every default is measured
 * from the project's own ad analysis and cross-checked across 6 references:
 *   - premium_motion_factors.md  (I-1 camera moves, E-5 parallax, A-8 hold)
 *   - langease_analysis.md       (drift 240-540 px/sec, hover 1-2px / 1-2deg)
 *   - base44_analysis.md         (dashboard push 250 px/sec, zoom 1.0->1.5)
 * Where a value is a range in the source, the default sits mid-range and the
 * source is cited in the component's doc. Tune within the cited range only.
 *
 * Usage context for LLM:
 *   Camera motion rides UNDER element effects. Two hard rules from the
 *   analysis (premium_motion_factors A-8 / factor 3):
 *     - Nothing is ever fully static. Every hold carries a drift or a
 *       breathing scale. Put PushIn or CameraDrift under almost every hold.
 *     - Drift is LINEAR (constant velocity), not eased. Camera reveals
 *       (PushIn/PullOut) are eased; ambient drift is not.
 *   Physics is robotic-snap: no overshoot on camera (premium C-2:
 *   Stripe/Notion/Linear/Vercel bounce 0).
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing, random } from "remotion";

// Reveal easing: ease-out, no overshoot (premium C-2 robotic snap).
const EASE_REVEAL = Easing.out(Easing.cubic);

/**
 * PushIn — slow dolly toward the subject with a micro-pan (Ken Burns).
 *
 * Measured (premium_motion_factors I-1): push_in scale 110-120% per shot,
 * accompanied by a small pan. Default 1.14 sits mid-range. Reveal is eased.
 *
 * Usage: hero product reveal, "this matters" focus. Keep under ~1.2 or it
 * reads as a zoom, not a camera.
 */
export interface PushInProps {
  children: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  from?: number;
  to?: number;
  panX?: number;
  originX?: number;
  originY?: number;
  style?: React.CSSProperties;
}

export const PushIn: React.FC<PushInProps> = ({
  children,
  startFrame,
  durationFrames = 90,
  from = 1,
  to = 1.14,
  panX = 24,
  originX = 50,
  originY = 50,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - startFrame);
  const p = interpolate(local, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_REVEAL,
  });
  const scale = from + (to - from) * p;
  const tx = panX * p; // micro-pan accompanies the push (Ken Burns)
  return (
    <AbsoluteFill
      style={{ transformOrigin: `${originX}% ${originY}%`, transform: `scale(${scale}) translateX(${tx}px)`, ...style }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * PullOut — reverse dolly, "detail -> big picture" reveal.
 *
 * Measured: mirror of PushIn (premium I-1). Default 1.14 -> 1.0, eased.
 * Usage: end of a scene, revealing full layout after a close-up.
 */
export interface PullOutProps {
  children: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  from?: number;
  to?: number;
  originX?: number;
  originY?: number;
  style?: React.CSSProperties;
}

export const PullOut: React.FC<PullOutProps> = ({
  children,
  startFrame,
  durationFrames = 90,
  from = 1.14,
  to = 1,
  originX = 50,
  originY = 50,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - startFrame);
  const p = interpolate(local, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_REVEAL,
  });
  const scale = from + (to - from) * p;
  return (
    <AbsoluteFill style={{ transformOrigin: `${originX}% ${originY}%`, transform: `scale(${scale})`, ...style }}>
      {children}
    </AbsoluteFill>
  );
};

/**
 * CameraDrift — LINEAR constant-velocity pan that rides on top of a hold.
 *
 * Measured (premium A-8 / langease / base44): hold is never static; it
 * carries a drift of 100-540 px/sec @1920 (LE Audio 240-300, LE group 540,
 * B44 dashboard 250). Motion is CONSTANT VELOCITY (linear), not eased.
 * Default 250 px/sec sits in the measured band.
 *
 * Usage: put under almost every hold so the frame stays alive. Pair with a
 * slight overscale so the edge never shows.
 */
export interface CameraDriftProps {
  children: React.ReactNode;
  startFrame?: number;
  pxPerSec?: number;
  direction?: "left" | "right" | "up" | "down";
  scale?: number;
  style?: React.CSSProperties;
}

export const CameraDrift: React.FC<CameraDriftProps> = ({
  children,
  startFrame = 0,
  pxPerSec = 250,
  direction = "right",
  scale = 1.06,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = Math.max(0, frame - startFrame) / fps;
  // Measured speeds are quoted at 1920px wide; scale to this comp.
  const px = pxPerSec * (width / 1920) * t;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const tx = horizontal ? px * sign : 0;
  const ty = horizontal ? 0 : px * sign;
  return (
    <AbsoluteFill style={{ transform: `scale(${scale}) translate(${tx}px, ${ty}px)`, ...style }}>
      {children}
    </AbsoluteFill>
  );
};

/**
 * Parallax — foreground and background drift at different speeds for depth.
 *
 * Measured (premium E-5 parallax, HARD-LOCK ratio structure): every camera
 * move carries a parallax layer; front travels farther than back. Motion is
 * linear drift (rides the same rule as CameraDrift). `depth` is the
 * front/back speed ratio.
 *
 * Usage: any scene with a clear front subject over a back layer. Keeps flat
 * UI from feeling dead.
 */
export interface ParallaxProps {
  back: React.ReactNode;
  front: React.ReactNode;
  startFrame?: number;
  pxPerSec?: number;
  depth?: number;
  direction?: "left" | "right";
  style?: React.CSSProperties;
}

export const Parallax: React.FC<ParallaxProps> = ({
  back,
  front,
  startFrame = 0,
  pxPerSec = 120,
  depth = 2.5,
  direction = "left",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = Math.max(0, frame - startFrame) / fps;
  const base = pxPerSec * (width / 1920) * t;
  const sign = direction === "left" ? -1 : 1;
  const backX = base * sign;
  const frontX = base * depth * sign;
  return (
    <AbsoluteFill style={style}>
      <AbsoluteFill style={{ transform: `translateX(${backX}px) scale(1.08)` }}>{back}</AbsoluteFill>
      <AbsoluteFill style={{ transform: `translateX(${frontX}px)` }}>{front}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * HoverFloat — micro hover + breathing that makes an element feel alive.
 *
 * Measured (langease folder hover: 1-2px position + 1-2deg rotation;
 * premium A-8 breathing: scale 1.0-1.03, period 2-4s). These are the real
 * amplitudes from the analysis, much smaller than a "handheld" shake.
 *
 * Usage: any element during a hold (cards, devices, badges). Deterministic
 * per `seed`. Raise `intensity` toward a documentary handheld feel, but the
 * default is the measured product-grade subtle drift.
 */
export interface HoverFloatProps {
  children: React.ReactNode;
  startFrame?: number;
  intensity?: number;
  periodSec?: number;
  seed?: number;
  style?: React.CSSProperties;
}

export const HoverFloat: React.FC<HoverFloatProps> = ({
  children,
  startFrame = 0,
  intensity = 1,
  periodSec = 3,
  seed = 1,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = Math.max(0, frame - startFrame) / fps;
  const w = (2 * Math.PI) / periodSec; // breathing period 2-4s
  const ph = random(`h-${seed}`) * 6.283;
  // Measured amplitudes: position 1-2px, rotation 1-2deg, scale 1.0-1.03.
  const x = Math.sin(t * w + ph) * 2 * intensity;
  const y = Math.sin(t * w * 0.8 + ph) * 1.5 * intensity;
  const rot = Math.sin(t * w * 0.6 + ph) * 1.5 * intensity;
  const scale = 1 + (Math.sin(t * w * 0.5 + ph) * 0.5 + 0.5) * 0.03 * intensity;
  return (
    <AbsoluteFill
      style={{ transform: `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${scale})`, ...style }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * OrbitTilt — subtle 3D rotation on a perspective plane (product beauty-shot).
 *
 * Measured for angle band from the glossary (B-10 orbit/arc, 3D product);
 * langease device mockups sit at small isometric tilts. Keep 6-14deg.
 * Reveal is eased, no overshoot (premium C-2).
 *
 * Usage: device mockups, cards, hero product frames. Pair with a shadow.
 */
export interface OrbitTiltProps {
  children: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  fromDeg?: number;
  toDeg?: number;
  axis?: "y" | "x";
  perspective?: number;
  style?: React.CSSProperties;
}

export const OrbitTilt: React.FC<OrbitTiltProps> = ({
  children,
  startFrame,
  durationFrames = 90,
  fromDeg = -10,
  toDeg = 6,
  axis = "y",
  perspective = 1400,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const local = Math.max(0, frame - startFrame);
  const deg = interpolate(local, [0, durationFrames], [fromDeg, toDeg], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE_REVEAL,
  });
  const rotate = axis === "y" ? `rotateY(${deg}deg)` : `rotateX(${deg}deg)`;
  return (
    <AbsoluteFill style={{ perspective: `${perspective}px`, ...style }}>
      <AbsoluteFill style={{ transform: `${rotate}`, transformStyle: "preserve-3d" }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
