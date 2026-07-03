/**
 * Hold — keeps content visible with breathing micro-motion for a specified duration.
 *
 * Usage context for LLM:
 *   "Pause" between effects. Content stays visible but never truly static.
 *   Breathing adds: scale ±0.2%, position ±1px, rotation ±0.05deg.
 *   This is what makes "hold" periods feel alive instead of frozen.
 *
 *   Every "hold" in a video should use this wrapper.
 *   Duration typically 0.3-1.0s (10-30 frames at 30fps).
 */

import React from "react";
import { useCurrentFrame } from "remotion";

interface HoldProps {
  children: React.ReactNode;
  /** Frame at which hold starts (content visible from this frame) */
  startFrame: number;
  /** Duration in frames */
  durationFrames: number;
  /** Breathing intensity (0 = truly static, 1 = normal, 2 = noticeable) */
  breathingIntensity?: number;
  /** Breathing speed multiplier */
  breathingSpeed?: number;
  style?: React.CSSProperties;
}

export const Hold: React.FC<HoldProps> = ({
  children,
  startFrame,
  durationFrames,
  breathingIntensity = 1,
  breathingSpeed = 1,
  style = {},
}) => {
  const frame = useCurrentFrame();

  if (frame < startFrame || frame > startFrame + durationFrames) return null;

  const localFrame = frame - startFrame;

  // Breathing micro-motion
  const scaleBreath = 1 + Math.sin(localFrame * 0.05 * breathingSpeed) * 0.002 * breathingIntensity;
  const xDrift = Math.sin(localFrame * 0.03 * breathingSpeed) * 0.5 * breathingIntensity;
  const yDrift = Math.cos(localFrame * 0.04 * breathingSpeed) * 0.3 * breathingIntensity;

  return (
    <div
      style={{
        transform: `translate(${xDrift}px, ${yDrift}px) scale(${scaleBreath})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
