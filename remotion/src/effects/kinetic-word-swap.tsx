/**
 * KineticWordSwap — phrases swap instantly, then letter-spacing settles.
 *
 * Core mechanic:
 *   1. Phrase appears with wide letter-spacing (centered)
 *   2. Spacing settles via spring to normal
 *   3. Holds with breathing micro-motion
 *   4. Hard swap to next phrase (1 frame)
 *   5. New phrase settles again
 *   6. Repeat cycle
 *
 * If only 1 phrase: settle once, then hold forever.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface KineticWordSwapProps {
  /** Array of phrases to cycle through */
  phrases: string[];
  /** Frame at which the first phrase appears */
  startFrame?: number;
  /** Frames for spacing to settle (default 12) */
  settleFrames?: number;
  /** Frames to hold each phrase after settle (default 30) */
  holdFrames?: number;
  /** Initial letter-spacing in em (default 0.5) */
  initialSpacingEm?: number;
  /** Font size */
  fontSize?: number;
  /** Text color */
  color?: string;
  /** Font weight */
  fontWeight?: number;
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const KineticWordSwap: React.FC<KineticWordSwapProps> = ({
  phrases,
  startFrame = 0,
  settleFrames: settleProp,
  holdFrames = 30,
  initialSpacingEm = 0.5,
  fontSize = 48,
  color = "#FAFAFA",
  fontWeight = 600,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < startFrame || phrases.length === 0) return null;

  const localFrame = frame - startFrame;
  const mult = DURATION_MULTIPLIER[energy];
  const settleFrames = settleProp ?? Math.round(12 * mult);
  const cycleFrames = settleFrames + holdFrames;

  // Determine current phrase index and phase
  let currentIndex: number;
  let phaseFrame: number;

  if (phrases.length === 1) {
    // Single phrase: settle once, hold forever
    currentIndex = 0;
    phaseFrame = Math.min(localFrame, settleFrames);
  } else {
    const currentCycle = Math.floor(localFrame / cycleFrames);
    if (currentCycle >= phrases.length) {
      // Past all phrases: stay on last one, fully settled
      currentIndex = phrases.length - 1;
      phaseFrame = settleFrames;
    } else {
      currentIndex = currentCycle % phrases.length;
      phaseFrame = localFrame - currentCycle * cycleFrames;
    }
  }

  const isSettling = phaseFrame < settleFrames;
  const settleLocalFrame = isSettling ? phaseFrame : settleFrames;

  // Letter-spacing: wide → normal via spring
  const springConfig = getSpring("settle", energy);
  const spacingProgress = spring({
    frame: settleLocalFrame,
    fps,
    from: initialSpacingEm,
    to: 0,
    durationInFrames: settleFrames,
    config: { ...springConfig, overshootClamping: true },
  });

  // Scale: slight scale-down from 1.05 → 1.0 during settle
  const scaleProgress = spring({
    frame: settleLocalFrame,
    fps,
    from: 1.05,
    to: 1.0,
    durationInFrames: settleFrames,
    config: { ...springConfig, overshootClamping: true },
  });

  // Opacity: first phrase entrance 0→1
  const isFirstEntrance = localFrame < settleFrames && currentIndex === 0;
  const entranceOpacity = isFirstEntrance
    ? interpolate(localFrame, [0, 6], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 1;

  // Blur: clear during settle
  const blurProgress = isSettling
    ? interpolate(settleLocalFrame, [0, settleFrames * 0.6], [4, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  // Breathing during hold
  const breathe = !isSettling
    ? Math.sin(localFrame * 0.05) * 0.003
    : 0;

  // Swap transition: slight opacity dip on swap boundary (1 frame before cycle end)
  let swapDip = 1;
  if (phrases.length > 1 && phaseFrame >= cycleFrames - 2 && phaseFrame < cycleFrames) {
    swapDip = 0.85;
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        width: "100%",
        height: "100%",
        ...style,
      }}
    >
      <div
        style={{
          whiteSpace: "nowrap",
          textAlign: "center",
          fontSize,
          fontWeight,
          color,
          letterSpacing: `${spacingProgress}em`,
          transform: `scale(${scaleProgress + breathe})`,
          transformOrigin: "center",
          opacity: entranceOpacity * swapDip,
          filter: blurProgress > 0.3 ? `blur(${blurProgress}px)` : "none",
        }}
      >
        {phrases[currentIndex]}
      </div>
    </div>
  );
};
