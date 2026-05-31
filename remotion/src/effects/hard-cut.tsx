/**
 * HardCut — instant 1-frame scene change container.
 *
 * Usage context for LLM:
 *   Wraps two or more scenes with frame-exact boundaries.
 *   No transition animation — the switch IS the effect.
 *   Creates rhythm: content-hold-CUT-content-hold-CUT.
 *
 *   This is a layout utility, not a visual effect.
 *   Each "scene" is a child with its own frame range.
 */

import React from "react";
import { useCurrentFrame, AbsoluteFill } from "remotion";

interface HardCutScene {
  /** Frame at which this scene starts (inclusive) */
  from: number;
  /** Frame at which this scene ends (exclusive) */
  to: number;
  /** Background color for this scene */
  backgroundColor?: string;
  /** Scene content */
  content: React.ReactNode;
}

interface HardCutProps {
  scenes: HardCutScene[];
}

export const HardCut: React.FC<HardCutProps> = ({ scenes }) => {
  const frame = useCurrentFrame();

  const activeScene = scenes.find(
    (s) => frame >= s.from && frame < s.to,
  );

  if (!activeScene) return null;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: activeScene.backgroundColor ?? "transparent",
      }}
    >
      {activeScene.content}
    </AbsoluteFill>
  );
};
