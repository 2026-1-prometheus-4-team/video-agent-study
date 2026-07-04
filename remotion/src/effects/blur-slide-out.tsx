/**
 * BlurSlideOut — element exits with simultaneous slide + blur + scale + fade.
 *
 * Usage context for LLM:
 *   The "departure" motion — 4 properties change simultaneously:
 *     1. Position: slides toward exit direction (usually left)
 *     2. Scale: shrinks slightly (1.0 → 0.6-0.8)
 *     3. Blur: increases (0 → 10-15px), often directional (stronger toward exit side)
 *     4. Opacity: fades out (1 → 0)
 *
 *   CRITICAL TIMING from analysis:
 *     - Scale starts shrinking FIRST
 *     - Blur starts AFTER scale is already underway (2-3 frames later)
 *     - Opacity starts AFTER blur is clearly visible
 *     - This creates: shrink → blur appears → fade out (layered, not simultaneous start)
 *
 * Combines well with:
 *   - BlurSlideIn of the NEXT element (overlap the exit/entrance for seamless swap)
 *   - GradientToBlack (gradient color fades to dark before exit)
 *
 * Avoid:
 *   - Starting blur at the same frame as scale (looks mechanical)
 *   - Opacity fading before blur is visible (blur becomes invisible)
 */

import React from "react";
import { spring, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface BlurSlideOutProps {
  children: React.ReactNode;
  /** Frame at which the exit starts */
  startFrame: number;
  /** Direction to exit toward */
  toward?: "left" | "right" | "top" | "bottom";
  /** How far to travel before disappearing (px) */
  offsetPx?: number;
  /** Target scale at end */
  endScale?: number;
  /** Maximum blur at end (px) */
  endBlur?: number;
  /** Brand energy */
  energy?: BrandEnergy;
  /** How many frames AFTER scale starts before blur begins (the "lag") */
  blurLagFrames?: number;
  /** How many frames AFTER blur starts before opacity begins fading */
  opacityLagFrames?: number;
  style?: React.CSSProperties;
}

export const BlurSlideOut: React.FC<BlurSlideOutProps> = ({
  children,
  startFrame,
  toward = "left",
  offsetPx = 300,
  endScale = 0.5,
  endBlur = 14,
  energy = "moderate",
  blurLagFrames = 3,
  opacityLagFrames = 6,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const springConfig = getSpring("exit", energy);
  const dur = Math.round(22 * DURATION_MULTIPLIER[energy]);

  // Scale + Position: start immediately (ease-in — starts slow, accelerates)
  const exitProgress = spring({
    frame: localFrame,
    fps,
    from: 0,
    to: 1,
    durationInFrames: dur,
    config: springConfig,
  });

  // Blur: starts AFTER scale (lagged)
  const blurFrame = Math.max(0, localFrame - blurLagFrames);
  const blurProgress = spring({
    frame: blurFrame,
    fps,
    from: 0,
    to: 1,
    durationInFrames: Math.round(dur * 0.8),
    config: { ...springConfig, damping: springConfig.damping + 4 },
  });

  // Opacity: starts AFTER blur (double lagged)
  const opacityFrame = Math.max(0, localFrame - (blurLagFrames + opacityLagFrames));
  const opacityProgress = interpolate(
    opacityFrame,
    [0, Math.round(dur * 0.6)],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Position
  const translateValue = offsetPx * exitProgress;
  const translateProp =
    toward === "left" ? `translateX(${-translateValue}px)` :
    toward === "right" ? `translateX(${translateValue}px)` :
    toward === "top" ? `translateY(${-translateValue}px)` :
    `translateY(${translateValue}px)`;

  // Scale: 1.0 → endScale
  const scale = 1 + (endScale - 1) * exitProgress;

  // Blur
  const blur = endBlur * blurProgress;

  // Direction-aware blur (stronger toward exit direction)
  const blurDirection = toward === "left" ? "left" : toward === "right" ? "right" : toward === "top" ? "up" : "down";

  if (frame < startFrame) {
    return <div style={style}>{children}</div>;
  }

  if (opacityProgress <= 0) return null;

  return (
    <div
      style={{
        transform: `${translateProp} scale(${scale})`,
        filter: blur > 0.5 ? `blur(${blur}px)` : "none",
        opacity: opacityProgress,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
