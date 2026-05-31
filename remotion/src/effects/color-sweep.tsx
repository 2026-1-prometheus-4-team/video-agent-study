/**
 * ColorSweep — color wave sweeps across an element from one side to the other.
 *
 * Usage context for LLM:
 *   State change visualization: disabled → active, dark → branded.
 *   The sweep is directional (left→right or right→left).
 *   Like painting the element with a new color.
 */

import React from "react";
import { useCurrentFrame, interpolate } from "remotion";

interface ColorSweepProps {
  children: React.ReactNode;
  /** Frame at which sweep starts */
  startFrame: number;
  /** Duration of sweep in frames */
  durationFrames?: number;
  /** Starting color (before sweep) */
  fromColor: string;
  /** Ending color (after sweep) */
  toColor: string;
  /** Sweep direction */
  direction?: "left-to-right" | "right-to-left" | "top-to-bottom" | "bottom-to-top";
  /** Apply to background or text */
  target?: "background" | "text";
  style?: React.CSSProperties;
}

export const ColorSweep: React.FC<ColorSweepProps> = ({
  children,
  startFrame,
  durationFrames = 8,
  fromColor,
  toColor,
  direction = "left-to-right",
  target = "background",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const localFrame = Math.max(0, frame - startFrame);

  const progress = interpolate(localFrame, [0, durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const sweepPosition = progress * 100;

  const gradientDirection =
    direction === "left-to-right" ? "to right" :
    direction === "right-to-left" ? "to left" :
    direction === "top-to-bottom" ? "to bottom" :
    "to top";

  const gradient = `linear-gradient(${gradientDirection}, ${toColor} ${sweepPosition}%, ${fromColor} ${Math.min(100, sweepPosition + 2)}%)`;

  if (target === "text") {
    // For text: use clip on a colored overlay positioned over the children
    return (
      <span style={{ position: "relative", display: "inline-block", ...style }}>
        {/* Base layer: fromColor text */}
        <span style={{ color: fromColor, visibility: progress >= 1 ? "hidden" : "visible" }}>
          {children}
        </span>
        {/* Sweep layer: toColor text revealed via clip */}
        <span
          style={{
            position: "absolute",
            inset: 0,
            color: toColor,
            clipPath: direction === "left-to-right"
              ? `inset(0 ${100 - sweepPosition}% 0 0)`
              : direction === "right-to-left"
              ? `inset(0 0 0 ${100 - sweepPosition}%)`
              : direction === "top-to-bottom"
              ? `inset(0 0 ${100 - sweepPosition}% 0)`
              : `inset(${100 - sweepPosition}% 0 0 0)`,
          }}
        >
          {children}
        </span>
      </span>
    );
  }

  return (
    <div style={{ background: gradient, ...style }}>
      {children}
    </div>
  );
};
