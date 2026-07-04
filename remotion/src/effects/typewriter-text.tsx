/**
 * TypewriterText — simple text that appears character by character.
 *
 * Different from TypewriterPrompt: this is just text appearing with cursor,
 * no input box, no send button. Used for URLs, domain names, code-like text.
 *
 * From LangEase analysis:
 *   - "langease.ai" types out below the logo
 *   - ~0.1s per character
 *   - Blinking cursor during and briefly after typing
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface TypewriterTextProps {
  /** Full text to type */
  text: string;
  /** Frame at which typing starts */
  startFrame: number;
  /** Milliseconds per character */
  msPerChar?: number;
  /** Show blinking cursor */
  showCursor?: boolean;
  /** Cursor character or element */
  cursorChar?: string;
  /** Cursor color */
  cursorColor?: string;
  /** Text color */
  color?: string;
  /** Font size */
  fontSize?: number;
  /** Font weight */
  fontWeight?: number;
  /** Font family */
  fontFamily?: string;
  /** Keep cursor visible after typing completes (frames) */
  cursorLingerFrames?: number;
  style?: React.CSSProperties;
}

export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame,
  msPerChar = 100,
  showCursor = true,
  cursorChar = "|",
  cursorColor = "#1A1A1A",
  color = "#1A1A1A",
  fontSize = 20,
  fontWeight = 400,
  fontFamily = "Inter, sans-serif",
  cursorLingerFrames = 30,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const localFrame = Math.max(0, frame - startFrame);

  if (frame < startFrame) return null;

  const framesPerChar = Math.max(1, Math.round((msPerChar / 1000) * fps));
  const charsVisible = Math.min(text.length, Math.floor(localFrame / framesPerChar));
  const typingComplete = charsVisible >= text.length;
  const framesSinceComplete = typingComplete ? localFrame - text.length * framesPerChar : 0;

  // Cursor blinks every 15 frames (0.5s at 30fps)
  const cursorVisible = showCursor &&
    (!typingComplete || framesSinceComplete < cursorLingerFrames) &&
    Math.floor(frame / 15) % 2 === 0;

  return (
    <span
      style={{
        color,
        fontSize,
        fontWeight,
        fontFamily,
        fontVariantNumeric: "tabular-nums",
        ...style,
      }}
    >
      {text.slice(0, charsVisible)}
      {cursorVisible && (
        <span style={{ color: cursorColor, opacity: 0.8 }}>{cursorChar}</span>
      )}
    </span>
  );
};
