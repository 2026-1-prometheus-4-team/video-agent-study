/**
 * FadeOut — exact reverse of FadeIn.
 *
 * FadeIn:  opacity 0→1, scale startScale→1.0
 * FadeOut: opacity 1→0, scale 1.0→endScale
 *
 * Same spring config, same duration logic, just reversed.
 */

import React from "react";
import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface FadeOutProps {
  children: React.ReactNode;
  startFrame: number;
  durationFrames?: number;
  withScale?: boolean;
  endScale?: number;
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const FadeOut: React.FC<FadeOutProps> = ({
  children,
  startFrame,
  durationFrames,
  withScale = false,
  endScale = 0.95,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = durationFrames ?? Math.round(10 * DURATION_MULTIPLIER[energy]);

  // Before startFrame: fully visible
  if (frame < startFrame) {
    return <div style={style}>{children}</div>;
  }

  const localFrame = frame - startFrame;

  // Opacity: 1 → 0 (same interpolate as FadeIn but reversed)
  const opacity = interpolate(localFrame, [0, dur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Scale: 1.0 → endScale (same spring as FadeIn but reversed direction)
  const scale = withScale
    ? spring({
        frame: localFrame,
        fps,
        from: 1.0,
        to: endScale,
        durationInFrames: dur,
        config: getSpring("entrance", energy), // same config as FadeIn
      })
    : 1;

  if (opacity <= 0) return null;

  return (
    <div style={{ opacity, transform: `scale(${scale})`, ...style }}>
      {children}
    </div>
  );
};
