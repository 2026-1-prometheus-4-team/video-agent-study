/**
 * ProgressBar — animated fill bar with count-up number and glow.
 *
 * Usage context for LLM:
 *   Shows "processing" or "progress toward goal."
 *   The count-up creates anticipation. The glow creates premium feel.
 *   Often followed by a completion celebration (confetti, checkmark).
 *
 *   Count-up speed pattern (from analysis):
 *     0→70: very fast (0.2s)
 *     70→90: medium (0.5s)
 *     90→99: slowing down (ease-out)
 *     99: brief pause (anticipation)
 *     99→100: satisfying final tick
 *
 *   This deceleration pattern is universal — it creates tension before completion.
 *
 * Combines well with:
 *   - LiquidMorph (bar morphs into circle after completion)
 *   - ConfettiExplosion (triggers at 100%)
 *   - CheckmarkDraw (inside the morphed circle)
 *
 * Avoid:
 *   - Linear count-up (boring, no tension)
 *   - Stopping exactly at 100 without the 99→pause→100 moment
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { type BrandEnergy, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface ProgressBarProps {
  /** Frame when the progress animation starts */
  startFrame: number;
  /** Total frames for the count-up to complete */
  durationFrames?: number;
  /** Bar width as fraction of screen (0-1) */
  barWidth?: number;
  /** Bar height in px */
  barHeight?: number;
  /** Filled portion gradient */
  fillGradient?: string;
  /** Unfilled portion color */
  emptyColor?: string;
  /** Glow color under the bar */
  glowColor?: string;
  /** Show the "N/100" counter above bar */
  showCounter?: boolean;
  /** Brand energy */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  startFrame,
  durationFrames = 45,
  barWidth = 0.4,
  barHeight = 16,
  fillGradient = "linear-gradient(90deg, #F0F4FF 0%, #3D4FF0 50%, #34CDF6 100%)",
  emptyColor = "#E8ECF5",
  glowColor = "rgba(59, 149, 255, 0.2)",
  showCounter = true,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { width: screenWidth, fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const dur = Math.round(durationFrames * DURATION_MULTIPLIER[energy]);

  // Count value: ease-out deceleration (fast start, slow finish)
  // Uses a custom curve: fast 0-70, medium 70-90, slow 90-99, pause, 100
  const rawProgress = interpolate(
    localFrame,
    [0, dur * 0.3, dur * 0.6, dur * 0.85, dur * 0.92, dur],
    [0, 70, 90, 99, 99, 100],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const countValue = Math.round(rawProgress);
  const fillPercent = rawProgress / 100;

  // Glow intensity increases with fill
  const glowIntensity = interpolate(fillPercent, [0, 1], [0.1, 0.4]);

  // Bar dimensions
  const barWidthPx = screenWidth * barWidth;
  const borderRadius = barHeight / 2;

  if (frame < startFrame) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        ...style,
      }}
    >
      {/* Counter "N/100" */}
      {showCounter && (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 2,
            fontFamily: "Inter, sans-serif",
            fontSize: 28,
            fontWeight: 600,
            alignSelf: "flex-end",
            marginRight: `${(1 - fillPercent) * barWidthPx}px`,
          }}
        >
          <span
            style={{
              background: "linear-gradient(180deg, #2F88F5 0%, #6FB8FF 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            {countValue}
          </span>
          <span style={{ color: "#B8C0D0", fontSize: 20 }}>/100</span>
        </div>
      )}

      {/* Bar container */}
      <div
        style={{
          width: barWidthPx,
          height: barHeight,
          borderRadius,
          backgroundColor: emptyColor,
          position: "relative",
          overflow: "hidden",
          boxShadow: `0 4px 20px ${glowColor.replace(/[\d.]+\)$/, `${glowIntensity})`)}`,
        }}
      >
        {/* Filled portion */}
        <div
          style={{
            width: `${fillPercent * 100}%`,
            height: "100%",
            borderRadius,
            background: fillGradient,
            position: "relative",
            transition: "none",
          }}
        >
          {/* White dot at fill head */}
          <div
            style={{
              position: "absolute",
              right: -4,
              top: "50%",
              transform: "translateY(-50%)",
              width: barHeight - 4,
              height: barHeight - 4,
              borderRadius: "50%",
              backgroundColor: "white",
              boxShadow: "0 0 6px rgba(255,255,255,0.5)",
            }}
          />
        </div>
      </div>
    </div>
  );
};
