/**
 * BreathingDots — dots arranged in a pattern that expand/contract rhythmically.
 *
 * Usage context for LLM:
 *   Meditation/mindfulness/wellness visual.
 *   8-10 dots in a circular or organic pattern.
 *   They expand together (breathe in) and contract (breathe out).
 *   The rhythm suggests calm, intentional breathing.
 *
 *   From Base44 analysis:
 *     - "Finding Your Calm" mindfulness app
 *     - Dot constellation with breathing animation
 *     - Used alongside timer (00:41 / 02:35)
 */

import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";

interface BreathingDotsProps {
  /** Number of dots */
  count?: number;
  /** Base arrangement: "circle" | "organic" */
  arrangement?: "circle" | "organic";
  /** Dot color */
  color?: string;
  /** Base dot size in px */
  dotSize?: number;
  /** Breathing cycle duration in frames (one full inhale-exhale) */
  cycleDuration?: number;
  /** Scale range: dots oscillate between scaleMin and scaleMax */
  scaleMin?: number;
  scaleMax?: number;
  /** Overall size of the arrangement in px */
  arrangementSize?: number;
  /** Frame at which dots appear */
  startFrame?: number;
  style?: React.CSSProperties;
}

function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export const BreathingDots: React.FC<BreathingDotsProps> = ({
  count = 8,
  arrangement = "circle",
  color = "rgba(255,255,255,0.8)",
  dotSize = 8,
  cycleDuration = 90,
  scaleMin = 0.8,
  scaleMax = 1.3,
  arrangementSize = 120,
  startFrame = 0,
  style = {},
}) => {
  const frame = useCurrentFrame();

  const localFrame = Math.max(0, frame - startFrame);

  // Dot positions — must be before any early return (React hooks rule)
  const dots = useMemo(() => {
    return Array.from({ length: count }, (_, i) => {
      if (arrangement === "circle") {
        const angle = (i / count) * Math.PI * 2;
        return {
          x: Math.cos(angle) * arrangementSize / 2,
          y: Math.sin(angle) * arrangementSize / 2,
          delay: i * 0.1, // slight phase offset per dot
        };
      }
      // organic: semi-random positions
      const r = seededRandom;
      return {
        x: (r(i * 100 + 1) - 0.5) * arrangementSize,
        y: (r(i * 100 + 2) - 0.5) * arrangementSize,
        delay: r(i * 100 + 3) * 0.5,
      };
    });
  }, [count, arrangement, arrangementSize]);

  if (frame < startFrame) return null;

  // Breathing cycle: sin wave
  const breathPhase = (localFrame / cycleDuration) * Math.PI * 2;
  const breathScale = scaleMin + (scaleMax - scaleMin) * (0.5 + 0.5 * Math.sin(breathPhase));

  // Opacity: fade in
  const fadeIn = Math.min(1, localFrame / 15);

  return (
    <div
      style={{
        position: "relative",
        width: arrangementSize,
        height: arrangementSize,
        opacity: fadeIn,
        ...style,
      }}
    >
      {dots.map((dot, i) => {
        // Each dot has a slight phase offset for organic feel
        const dotPhase = breathPhase + dot.delay * Math.PI * 2;
        const dotScale = scaleMin + (scaleMax - scaleMin) * (0.5 + 0.5 * Math.sin(dotPhase));
        const dotOpacity = 0.5 + 0.3 * Math.sin(dotPhase + Math.PI / 4);

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: arrangementSize / 2 + dot.x - dotSize / 2,
              top: arrangementSize / 2 + dot.y - dotSize / 2,
              width: dotSize,
              height: dotSize,
              borderRadius: "50%",
              backgroundColor: color,
              transform: `scale(${dotScale})`,
              opacity: dotOpacity,
            }}
          />
        );
      })}
    </div>
  );
};
