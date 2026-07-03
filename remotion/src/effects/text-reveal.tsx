/**
 * TextReveal — generic text entrance with multiple modes.
 *
 * Usage context for LLM:
 *   Flexible text entrance — choose the mode that fits the moment:
 *   - "fade": simple opacity fade (gentle, minimal)
 *   - "slide-up": text rises from below (energetic, attention-grabbing)
 *   - "scale": text starts large/small and settles (impactful)
 *   - "blur-in": text starts blurred and sharpens (dramatic, premium)
 *   - "word-by-word": each word appears with a stagger delay
 *
 *   Use this for secondary text, taglines, descriptions.
 *   For primary keywords, use BlurSlideIn instead (more dramatic).
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { type BrandEnergy, getSpring, DURATION_MULTIPLIER } from "../atoms/spring-config";

type RevealMode = "fade" | "slide-up" | "slide-down" | "scale" | "blur-in" | "word-by-word";

interface TextRevealProps {
  /** Text to reveal */
  text: string;
  /** Entrance mode */
  mode?: RevealMode;
  /** Frame at which reveal starts */
  startFrame: number;
  /** Font size */
  fontSize?: number;
  /** Font weight */
  fontWeight?: number;
  /** Text color */
  color?: string;
  /** Optional gradient */
  gradient?: string;
  /** Slide distance in px (for slide modes) */
  slideDistance?: number;
  /** Start scale (for scale mode) */
  startScale?: number;
  /** Start blur in px (for blur-in mode) */
  startBlur?: number;
  /** Stagger delay per word in frames (for word-by-word mode) */
  wordStaggerFrames?: number;
  /** Brand energy */
  energy?: BrandEnergy;
  /** Text align */
  textAlign?: "left" | "center" | "right";
  style?: React.CSSProperties;
}

export const TextReveal: React.FC<TextRevealProps> = ({
  text,
  mode = "fade",
  startFrame,
  fontSize = 32,
  fontWeight = 500,
  color = "#1A1A1A",
  gradient,
  slideDistance = 30,
  startScale = 1.2,
  startBlur = 15,
  wordStaggerFrames = 4,
  energy = "moderate",
  textAlign = "center",
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (frame < startFrame) return null;

  const localFrame = frame - startFrame;
  const dur = Math.round(12 * DURATION_MULTIPLIER[energy]);
  const springConfig = getSpring("entrance", energy);

  // Word-by-word mode renders each word separately
  if (mode === "word-by-word") {
    const words = text.split(" ");
    return (
      <div style={{ display: "flex", gap: "0.3em", justifyContent: textAlign === "center" ? "center" : "flex-start", flexWrap: "wrap", ...style }}>
        {words.map((word, i) => {
          const wordLocalFrame = Math.max(0, localFrame - i * wordStaggerFrames);
          const wordOpacity = interpolate(wordLocalFrame, [0, dur * 0.5], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const wordSlide = spring({
            frame: wordLocalFrame,
            fps,
            from: 15,
            to: 0,
            durationInFrames: dur,
            config: springConfig,
          });

          const wordStyle: React.CSSProperties = {
            fontSize,
            fontWeight,
            fontFamily: "Inter, sans-serif",
            opacity: wordOpacity,
            transform: `translateY(${wordSlide}px)`,
            display: "inline-block",
          };

          if (gradient) {
            return (
              <span
                key={i}
                style={{
                  ...wordStyle,
                  background: gradient,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text",
                }}
              >
                {word}
              </span>
            );
          }
          return <span key={i} style={{ ...wordStyle, color }}>{word}</span>;
        })}
      </div>
    );
  }

  // Single-element modes
  const opacity = interpolate(localFrame, [0, dur * 0.6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  let transform = "";
  let filter = "";

  switch (mode) {
    case "slide-up":
      transform = `translateY(${spring({ frame: localFrame, fps, from: slideDistance, to: 0, durationInFrames: dur, config: springConfig })}px)`;
      break;
    case "slide-down":
      transform = `translateY(${spring({ frame: localFrame, fps, from: -slideDistance, to: 0, durationInFrames: dur, config: springConfig })}px)`;
      break;
    case "scale": {
      const scale = spring({ frame: localFrame, fps, from: startScale, to: 1.0, durationInFrames: dur, config: springConfig });
      transform = `scale(${scale})`;
      break;
    }
    case "blur-in": {
      const blur = spring({ frame: localFrame, fps, from: startBlur, to: 0, durationInFrames: dur, config: springConfig });
      filter = blur > 0.5 ? `blur(${blur}px)` : "";
      break;
    }
    case "fade":
    default:
      break;
  }

  const textStyle: React.CSSProperties = {
    fontSize,
    fontWeight,
    fontFamily: "Inter, sans-serif",
    textAlign,
    opacity,
    transform: transform || undefined,
    filter: filter || undefined,
    ...style,
  };

  if (gradient) {
    return (
      <span
        style={{
          ...textStyle,
          background: gradient,
          WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent",
          backgroundClip: "text",
        }}
      >
        {text}
      </span>
    );
  }

  return <span style={{ ...textStyle, color }}>{text}</span>;
};
