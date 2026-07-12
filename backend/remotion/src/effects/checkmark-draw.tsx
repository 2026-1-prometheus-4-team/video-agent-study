/**
 * CheckmarkDraw — animated checkmark stroke being drawn inside a circle.
 *
 * Usage context for LLM:
 *   Completion/success moment. The stroke draws from left to right.
 *   Circle appears first, then checkmark animates inside.
 *   Often paired with "Done" text and followed by ConfettiExplosion.
 *
 *   From LangEase analysis:
 *     - Circle: light blue #DCEEFF background, #B8E0FF border
 *     - Checkmark: blue #6FB8FF, thick rounded stroke
 *     - Stroke draws left-to-right in ~0.2s
 *     - "Done" text appears above simultaneously
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface CheckmarkDrawProps {
  /** Frame at which the animation starts */
  startFrame: number;
  /** Circle diameter in px */
  size?: number;
  /** Circle background color */
  circleColor?: string;
  /** Circle border color */
  circleBorderColor?: string;
  /** Checkmark stroke color */
  checkColor?: string;
  /** Checkmark stroke width */
  strokeWidth?: number;
  /** Optional "Done" text above */
  showDoneText?: boolean;
  /** "Done" text color */
  doneTextColor?: string;
  /** Brand energy */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const CheckmarkDraw: React.FC<CheckmarkDrawProps> = ({
  startFrame,
  size = 80,
  circleColor = "#DCEEFF",
  circleBorderColor = "#B8E0FF",
  checkColor = "#6FB8FF",
  strokeWidth = 4,
  showDoneText = true,
  doneTextColor = "#2F88F5",
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  if (frame < startFrame) return null;

  const dur = Math.round(12 * DURATION_MULTIPLIER[energy]);

  // Circle appears first (scale spring)
  const circleScale = spring({
    frame: localFrame,
    fps,
    from: 0.5,
    to: 1.0,
    durationInFrames: Math.round(dur * 0.6),
    config: getSpring("entrance", energy),
  });

  const circleOpacity = interpolate(localFrame, [0, 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Checkmark stroke draws after circle settles (delayed)
  const checkDelay = Math.round(dur * 0.4);
  const checkLocalFrame = Math.max(0, localFrame - checkDelay);
  const checkProgress = interpolate(checkLocalFrame, [0, Math.round(dur * 0.5)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // SVG checkmark path (V shape)
  // Total path length ≈ 40 units
  const pathLength = 40;
  const dashOffset = pathLength * (1 - checkProgress);

  // "Done" text
  const textOpacity = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 12,
        ...style,
      }}
    >
      {/* "Done" text */}
      {showDoneText && (
        <span
          style={{
            fontSize: 18,
            fontWeight: 600,
            fontFamily: "Inter, sans-serif",
            color: doneTextColor,
            opacity: textOpacity,
          }}
        >
          Done
        </span>
      )}

      {/* Circle + Checkmark */}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          backgroundColor: circleColor,
          border: `2px solid ${circleBorderColor}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${circleScale})`,
          opacity: circleOpacity,
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
        }}
      >
        <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13L9 17L19 7"
            stroke={checkColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={pathLength}
            strokeDashoffset={dashOffset}
          />
        </svg>
      </div>
    </div>
  );
};
