/**
 * BlurSlideIn — element enters with large size + strong blur, then settles.
 *
 * Usage context for LLM:
 *   The "hero entrance" for important text or UI elements.
 *   Creates a strong first impression — the element feels like it's
 *   "materializing" or "coming into focus."
 *
 *   3 properties change simultaneously:
 *     1. Position: slides from offset → target (usually right→center)
 *     2. Scale: starts large (1.3-2.0x) → settles to 1.0x
 *     3. Blur: starts strong (20-40px) → resolves to 0
 *
 *   All three use the same spring config for coherent motion.
 *
 * Combines well with:
 *   - "hold" period after (0.3-1.0s)
 *   - BlurSlideOut for departure
 *   - GradientTransfer when another element takes the color
 *   - WordAppend when a secondary word joins
 *
 * Avoid:
 *   - Using more than 3 times consecutively (becomes repetitive)
 *   - Combining with HardCut transition (the blur IS the transition)
 *   - Having blur resolve too quickly (< 0.2s feels glitchy)
 */

import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface BlurSlideInProps {
  children: React.ReactNode;
  /** Frame at which the entrance starts */
  startFrame: number;
  /** Direction to slide from: "right" | "left" | "top" | "bottom" */
  from?: "right" | "left" | "top" | "bottom";
  /** Starting offset in px (how far outside the target position) */
  offsetPx?: number;
  /** Starting scale multiplier */
  startScale?: number;
  /** Starting blur in px */
  startBlur?: number;
  /** Brand energy — controls speed/feel of all springs */
  energy?: BrandEnergy;
  /** Additional styles on the wrapper */
  style?: React.CSSProperties;
}

export const BlurSlideIn: React.FC<BlurSlideInProps> = ({
  children,
  startFrame,
  from = "right",
  offsetPx = 200,
  startScale = 1.5,
  startBlur = 30,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const springConfig = getSpring("entrance", energy);
  const dur = Math.round(24 * DURATION_MULTIPLIER[energy]);

  // All three properties use the same spring for coherent motion
  const progress = spring({
    frame: localFrame,
    fps,
    from: 0,
    to: 1,
    durationInFrames: dur,
    config: springConfig,
  });

  // Position: offset → 0
  const translateValue = offsetPx * (1 - progress);
  const translateProp =
    from === "right" ? `translateX(${translateValue}px)` :
    from === "left" ? `translateX(${-translateValue}px)` :
    from === "top" ? `translateY(${-translateValue}px)` :
    `translateY(${translateValue}px)`;

  // Scale: startScale → 1.0
  const scale = startScale + (1 - startScale) * progress;

  // Blur: startBlur → 0
  const blur = startBlur * (1 - progress);

  // Opacity: 0 → 1 (faster than other properties — element should be visible quickly)
  const opacity = Math.min(1, progress * 2);

  // Don't render before start
  if (frame < startFrame) return null;

  return (
    <div
      style={{
        transform: `${translateProp} scale(${scale})`,
        filter: blur > 0.5 ? `blur(${blur}px)` : "none",
        opacity,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
