/**
 * LiquidMorph — shape smoothly transforms between geometries.
 *
 * Usage context for LLM:
 *   Fluid transformation between shapes: rectangle → pill → circle → star.
 *   Feels organic, like liquid flowing. Used for state transitions.
 *
 *   From LangEase analysis:
 *     - Progress bar → pill → circle (completion)
 *     - Button → star/sparkle (transformation)
 *     - Width shrinks while borderRadius increases
 *     - ~0.5-0.7s for complete morph
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

type MorphShape = "rectangle" | "pill" | "circle" | "star";

interface LiquidMorphProps {
  /** Starting shape */
  fromShape: MorphShape;
  /** Target shape */
  toShape: MorphShape;
  /** Frame at which morph starts */
  startFrame: number;
  /** Duration in frames */
  durationFrames?: number;
  /** Initial width in px */
  fromWidth: number;
  /** Initial height in px */
  fromHeight: number;
  /** Fill color or gradient */
  fill?: string;
  /** Brand energy */
  energy?: BrandEnergy;
  /** Content inside the shape */
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

function getShapeProps(shape: MorphShape, w: number, h: number) {
  switch (shape) {
    case "rectangle":
      return { width: w, height: h, borderRadius: 8 };
    case "pill":
      return { width: w * 0.4, height: h, borderRadius: h / 2 };
    case "circle": {
      const size = Math.max(h, h);
      return { width: size, height: size, borderRadius: size / 2 };
    }
    case "star":
      // Star uses clipPath instead of borderRadius
      return { width: h * 1.2, height: h * 1.2, borderRadius: 0 };
  }
}

export const LiquidMorph: React.FC<LiquidMorphProps> = ({
  fromShape,
  toShape,
  startFrame,
  durationFrames,
  fromWidth,
  fromHeight,
  fill = "linear-gradient(135deg, #4F4FE8, #6FCFFF)",
  energy = "moderate",
  children,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const dur = durationFrames ?? Math.round(18 * DURATION_MULTIPLIER[energy]);
  const springConfig = getSpring("morph", energy);

  const progress = spring({
    frame: localFrame,
    fps,
    from: 0,
    to: 1,
    durationInFrames: dur,
    config: springConfig,
  });

  const fromProps = getShapeProps(fromShape, fromWidth, fromHeight);
  const toProps = getShapeProps(toShape, fromWidth, fromHeight);

  const currentWidth = fromProps.width + (toProps.width - fromProps.width) * progress;
  const currentHeight = fromProps.height + (toProps.height - fromProps.height) * progress;
  const currentRadius = fromProps.borderRadius + (toProps.borderRadius - fromProps.borderRadius) * progress;

  // Star shape uses clip-path
  const isStarTarget = toShape === "star";
  const starProgress = isStarTarget ? progress : 0;
  const clipPath = isStarTarget && starProgress > 0.5
    ? `polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)`
    : undefined;

  if (frame < startFrame) {
    return (
      <div
        style={{
          width: fromProps.width,
          height: fromProps.height,
          borderRadius: fromProps.borderRadius,
          background: fill,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...style,
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      style={{
        width: currentWidth,
        height: currentHeight,
        borderRadius: currentRadius,
        background: fill,
        clipPath,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
};
