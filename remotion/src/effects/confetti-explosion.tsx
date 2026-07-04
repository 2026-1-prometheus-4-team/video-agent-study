/**
 * ConfettiExplosion — colored paper pieces burst outward then fall with gravity.
 *
 * Usage context for LLM:
 *   Celebration moment — "task complete", "goal reached", "100% done".
 *   Triggers at a specific frame (e.g., when progress bar hits 100%).
 *   Should feel joyful and organic, not mechanical.
 *
 *   Physics:
 *     - Initial burst: fast radial expansion from center
 *     - Then: gravity pulls down + air resistance slows + wobble left/right
 *     - Each piece: random rotation, random size, random color
 *
 *   From LangEase analysis:
 *     - 30-40 pieces visible at peak
 *     - Pieces are small rectangles (4-12px), not circles
 *     - Colors: brand palette (blues, pinks, teals)
 *     - Burst speed: ~2000px/sec, then slow gravity fall
 *     - Wobble: sin wave, ±5-10px amplitude
 *
 * Combines well with:
 *   - CheckmarkDraw (check animation → confetti burst)
 *   - ProgressBarComplete (bar fills → morph → confetti)
 *   - Achievement sound effect at trigger frame
 *
 * Avoid:
 *   - Using for non-celebration moments (dilutes impact)
 *   - More than once per video (loses specialness)
 *   - Too many pieces (> 60 = messy, < 20 = weak)
 */

import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface ConfettiPiece {
  id: number;
  x: number; // starting X position (0-1, fraction of screen width)
  y: number; // starting Y position (0-1)
  width: number; // piece width in px
  height: number; // piece height in px
  color: string;
  rotation: number; // initial rotation degrees
  rotationSpeed: number; // degrees per frame
  velocityX: number; // initial horizontal velocity (px/frame)
  velocityY: number; // initial vertical velocity (px/frame, negative = upward)
  wobblePhase: number; // sin wave phase offset
  wobbleFreq: number; // sin wave frequency
  wobbleAmp: number; // sin wave amplitude in px
}

interface ConfettiExplosionProps {
  /** Frame at which confetti triggers */
  triggerFrame: number;
  /** Center of explosion (0-1 of screen) */
  centerX?: number;
  centerY?: number;
  /** Number of confetti pieces */
  count?: number;
  /** Colors for the pieces */
  colors?: string[];
  /** How long confetti stays visible (frames) */
  durationFrames?: number;
  /** Gravity strength (px/frame^2) */
  gravity?: number;
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export const ConfettiExplosion: React.FC<ConfettiExplosionProps> = ({
  triggerFrame,
  centerX = 0.5,
  centerY = 0.5,
  count = 40,
  colors = ["#1F3DD0", "#34CDF6", "#FF9DD0", "#E55BAD", "#1B2390", "#6FB8FF"],
  durationFrames = 90,
  gravity = 0.15,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Generate pieces deterministically (same pieces every render)
  const pieces: ConfettiPiece[] = useMemo(() => {
    return Array.from({ length: count }, (_, i) => {
      const r = (seed: number) => seededRandom(i * 100 + seed);
      const angle = r(1) * Math.PI * 2; // random direction
      const speed = 8 + r(2) * 15; // burst speed: 8-23 px/frame

      return {
        id: i,
        x: centerX,
        y: centerY,
        width: 4 + r(3) * 8, // 4-12px
        height: 3 + r(4) * 5, // 3-8px
        color: colors[Math.floor(r(5) * colors.length)],
        rotation: r(6) * 360,
        rotationSpeed: -5 + r(7) * 10, // -5 to +5 deg/frame
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed * -1, // negative = upward initially
        wobblePhase: r(8) * Math.PI * 2,
        wobbleFreq: 0.1 + r(9) * 0.15,
        wobbleAmp: 3 + r(10) * 7, // 3-10px wobble
      };
    });
  }, [count, centerX, centerY, colors]);

  const localFrame = frame - triggerFrame;
  if (localFrame < 0 || localFrame > durationFrames) return null;

  // Overall fade out near end
  const globalOpacity = interpolate(
    localFrame,
    [durationFrames * 0.7, durationFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: globalOpacity }}>
      {pieces.map((piece) => {
        // Physics simulation
        const t = localFrame;
        const airResistance = 0.96; // velocity multiplier per frame

        // Position with air resistance (velocity decays exponentially)
        const decayFactor = Math.pow(airResistance, t);
        const posX = piece.x * width + piece.velocityX * (1 - decayFactor) / (1 - airResistance)
          + Math.sin(t * piece.wobbleFreq + piece.wobblePhase) * piece.wobbleAmp;
        const posY = piece.y * height + piece.velocityY * (1 - decayFactor) / (1 - airResistance)
          + 0.5 * gravity * t * t; // gravity

        const rotation = piece.rotation + piece.rotationSpeed * t;

        // Skip if off screen
        if (posY > height + 50 || posX < -50 || posX > width + 50) return null;

        return (
          <div
            key={piece.id}
            style={{
              position: "absolute",
              left: posX,
              top: posY,
              width: piece.width,
              height: piece.height,
              backgroundColor: piece.color,
              borderRadius: 1,
              transform: `rotate(${rotation}deg)`,
              transformOrigin: "center",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
