/**
 * HandCursor — stylized cursor that moves along a path and clicks.
 *
 * Usage context for LLM:
 *   Demonstrates interactivity. Cursor moves to a target (button, card),
 *   hovers, then clicks. The click triggers a response (bounce, color change).
 *   Two styles: pointer arrow (default mouse) or grab hand (Mac-style).
 *
 *   From LangEase analysis:
 *     - Mac grab hand (stylized, not system cursor)
 *     - Moves from bottom-right toward target with ease-out
 *     - Click = element bounce
 *
 *   From Base44 analysis:
 *     - Standard arrow cursor (black)
 *     - Moves to send button
 *     - Hover state: button color lightens
 *     - Click → transition to next scene
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface CursorKeyframe {
  frame: number;
  x: number; // 0-1 fraction of screen
  y: number;
}

interface HandCursorProps {
  /** Keyframes defining cursor path */
  path: CursorKeyframe[];
  /** Cursor style */
  cursorType?: "pointer" | "grab";
  /** Size in px */
  size?: number;
  /** Color */
  color?: string;
  /** Frame at which cursor appears */
  startFrame?: number;
  /** Brand energy (affects movement speed) */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

/** SVG Pointer Arrow */
function PointerArrow({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M5 3L19 12L12 13L9 20L5 3Z"
        fill={color}
        stroke="white"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** SVG Grab Hand */
function GrabHand({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <path
        d="M16 28V14a2 2 0 114 0v10M20 18V11a2 2 0 114 0v13M24 14v-2a2 2 0 114 0v14M28 16a2 2 0 114 0v10c0 6-4 10-10 10h-2c-5 0-9-4-10-8l-3-7a2 2 0 013.5-1.8L16 28"
        stroke={color}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="white"
      />
    </svg>
  );
}

export const HandCursor: React.FC<HandCursorProps> = ({
  path,
  cursorType = "pointer",
  size = 32,
  color = "#1A1A1A",
  startFrame = 0,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  if (path.length < 1 || frame < startFrame) return null;

  // Interpolate position along keyframes
  const frames = path.map((k) => k.frame);
  const xs = path.map((k) => k.x);
  const ys = path.map((k) => k.y);

  if (frame < frames[0]) return null;

  const x = interpolate(frame, frames, xs, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, frames, ys, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Opacity: fade in at start
  const opacity = interpolate(frame, [frames[0], frames[0] + 4], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "absolute",
        left: x * width,
        top: y * height,
        opacity,
        pointerEvents: "none",
        zIndex: 1000,
        ...style,
      }}
    >
      {cursorType === "pointer" ? (
        <PointerArrow size={size} color={color} />
      ) : (
        <GrabHand size={size} color={color} />
      )}
    </div>
  );
};
