/**
 * FadeIn — simple opacity transition from 0 to 1.
 *
 * Usage context for LLM:
 *   The most basic entrance. Element simply appears by becoming visible.
 *   Use when other entrances (BlurSlideIn, etc.) would be too dramatic.
 *   Good for: logos, subtle text, background elements, secondary UI.
 *
 *   Can optionally include a slight scale (0.95→1.0) for a touch of motion.
 */

import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface FadeInProps {
  children: React.ReactNode;
  /** Frame at which fade starts */
  startFrame: number;
  /** Duration of fade in frames */
  durationFrames?: number;
  /** Also apply subtle scale (0.95→1.0)? */
  withScale?: boolean;
  /** Starting scale (only if withScale) */
  startScale?: number;
  /** Brand energy */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const FadeIn: React.FC<FadeInProps> = ({
  children,
  startFrame,
  durationFrames,
  withScale = false,
  startScale = 0.95,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  if (frame < startFrame) return null;

  const dur = durationFrames ?? Math.round(10 * DURATION_MULTIPLIER[energy]);

  const opacity = interpolate(localFrame, [0, dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = withScale
    ? spring({
        frame: localFrame,
        fps,
        from: startScale,
        to: 1.0,
        durationInFrames: dur,
        config: getSpring("entrance", energy),
      })
    : 1;

  return (
    <div style={{ opacity, transform: `scale(${scale})`, ...style }}>
      {children}
    </div>
  );
};
