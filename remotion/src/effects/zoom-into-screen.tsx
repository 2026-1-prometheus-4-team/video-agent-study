/**
 * ZoomIntoScreen — camera pushes into a device's screen, transitioning from
 * "seeing the device" to "being inside the app."
 *
 * Usage context for LLM:
 *   Transition from product showcase (device mockup) to product demo.
 *   The zoom creates an immersive "entering the app" feeling.
 *   Scale goes from 1.0 to 3-5x, centered on the screen area.
 *
 *   Often follows DeviceMockup and precedes UI demo sequences.
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

interface ZoomIntoScreenProps {
  children: React.ReactNode;
  /** Frame at which zoom starts */
  startFrame: number;
  /** Target zoom scale */
  targetScale?: number;
  /** Zoom focus point X (0-1) */
  focusX?: number;
  /** Zoom focus point Y (0-1) */
  focusY?: number;
  /** Duration in frames */
  durationFrames?: number;
  /** Brand energy */
  energy?: BrandEnergy;
  style?: React.CSSProperties;
}

export const ZoomIntoScreen: React.FC<ZoomIntoScreenProps> = ({
  children,
  startFrame,
  targetScale = 3.5,
  focusX = 0.5,
  focusY = 0.4,
  durationFrames,
  energy = "moderate",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  const dur = durationFrames ?? Math.round(24 * DURATION_MULTIPLIER[energy]);

  const zoomProgress = frame < startFrame ? 0 : spring({
    frame: localFrame,
    fps,
    from: 1,
    to: targetScale,
    durationInFrames: dur,
    config: { ...getSpring("entrance", energy), stiffness: 40, damping: 22 },
  });

  // As we zoom in, we need to translate to keep the focus point centered
  const translateX = (0.5 - focusX) * (zoomProgress - 1) * 100;
  const translateY = (0.5 - focusY) * (zoomProgress - 1) * 100;

  return (
    <div
      style={{
        transform: `scale(${zoomProgress}) translate(${translateX}%, ${translateY}%)`,
        transformOrigin: `${focusX * 100}% ${focusY * 100}%`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
