/**
 * Layer-level visual effects — applied on top of or behind content.
 *
 * These are the "always-on" effects that make a video feel alive and cinematic.
 * Without these, the video looks flat and "AI-generated."
 * With these, it feels like a professional production.
 *
 * Usage context for LLM:
 *   Apply Grain + Vignette to nearly every scene.
 *   Breathing is for any element during "hold" periods.
 *   OuterGlow is for UI cards, buttons, highlighted elements.
 *   DynamicShadow for any floating/hovering element.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

/**
 * FilmGrain — subtle noise overlay that makes every frame unique.
 *
 * Usage: Apply to the entire video as the topmost layer.
 * The grain changes every frame, preventing the "digital stillness" feel.
 * Opacity should be very low (2-5%) — if you can clearly see it, it's too much.
 */
export const FilmGrain: React.FC<{ opacity?: number }> = ({ opacity = 0.03 }) => {
  const frame = useCurrentFrame();

  // Generate unique grain pattern per frame using pseudo-random offset
  const offsetX = (frame * 17) % 200;
  const offsetY = (frame * 31) % 200;

  return (
    <AbsoluteFill
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        backgroundPosition: `${offsetX}px ${offsetY}px`,
        opacity,
        mixBlendMode: "overlay",
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * Vignette — darkens edges of the frame for cinematic depth.
 *
 * Usage: Apply to most scenes. Stronger vignette = more dramatic/focused.
 * Restrained brands: subtle (0.15). High energy brands: stronger (0.3).
 */
export const Vignette: React.FC<{
  opacity?: number;
  /** How much of the center is clear. 0.5 = half clear. */
  spread?: number;
}> = ({ opacity = 0.2, spread = 0.5 }) => {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at center, transparent ${spread * 100}%, rgba(0,0,0,${opacity}) 100%)`,
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * OuterGlow — soft colored glow around an element.
 *
 * Usage context for LLM:
 *   Apply to UI cards, buttons, highlighted elements.
 *   Color should match brand primary or accent.
 *   Glow implies "importance" or "interactivity."
 *   Floating elements (cards, icons) should have glow + shadow together.
 */
export const OuterGlow: React.FC<{
  color?: string;
  blurRadius?: number;
  spreadRadius?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({
  color = "rgba(59, 149, 255, 0.2)",
  blurRadius = 12,
  spreadRadius = 0,
  children,
  style = {},
}) => {
  return (
    <div
      style={{
        boxShadow: `0 0 ${blurRadius}px ${spreadRadius}px ${color}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/**
 * DynamicShadow — shadow that changes with element state.
 *
 * Usage context for LLM:
 *   Elements that "hover" or "float" need dynamic shadows.
 *   When element moves UP → shadow gets farther, more spread, lighter.
 *   When element moves DOWN → shadow gets closer, tighter, darker.
 *   This creates depth illusion.
 *
 *   elevation: 0 = resting on surface. 1 = floating high.
 */
export const DynamicShadow: React.FC<{
  elevation: number;
  color?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ elevation, color = "rgba(0,0,0,0.1)", children, style = {} }) => {
  // Map elevation (0-1) to shadow properties
  const offsetY = 4 + elevation * 16; // 4px → 20px
  const blur = 8 + elevation * 32; // 8px → 40px
  const opacity = 0.15 - elevation * 0.05; // 0.15 → 0.10 (lighter when higher)

  const shadowColor = color.replace(/[\d.]+\)$/, `${opacity})`);

  return (
    <div
      style={{
        boxShadow: `0 ${offsetY}px ${blur}px ${shadowColor}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/**
 * DirectionalBlur — blur with direction bias.
 *
 * Usage context for LLM:
 *   When elements exit the screen, blur should be stronger in the exit direction.
 *   Text sliding LEFT → left side of text blurs more than right.
 *   This simulates "motion blur" without actual motion blur rendering.
 *
 *   Implementation: CSS filter blur on the whole element + optional
 *   gradient mask to make one side blurrier.
 */
export const DirectionalBlur: React.FC<{
  blurAmount: number;
  /** Direction of stronger blur: "left" | "right" | "up" | "down" | "uniform" */
  direction?: "left" | "right" | "up" | "down" | "uniform";
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ blurAmount, direction = "uniform", children, style = {} }) => {
  if (blurAmount <= 0) {
    return <div style={style}>{children}</div>;
  }

  // For directional blur, we apply base blur + gradient mask
  const maskGradient =
    direction === "uniform"
      ? undefined
      : direction === "left"
        ? "linear-gradient(to right, rgba(0,0,0,0.3), rgba(0,0,0,1))"
        : direction === "right"
          ? "linear-gradient(to left, rgba(0,0,0,0.3), rgba(0,0,0,1))"
          : direction === "up"
            ? "linear-gradient(to bottom, rgba(0,0,0,0.3), rgba(0,0,0,1))"
            : "linear-gradient(to top, rgba(0,0,0,0.3), rgba(0,0,0,1))";

  return (
    <div
      style={{
        filter: `blur(${blurAmount}px)`,
        maskImage: maskGradient,
        WebkitMaskImage: maskGradient,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/**
 * BreathingWrapper — adds micro-movement to any element during "hold" periods.
 *
 * Usage context for LLM:
 *   Apply to ANY element that stays on screen for more than 0.5 seconds.
 *   Without this, static elements feel "dead."
 *   Scale oscillates between 0.998 and 1.002 (invisible to conscious eye,
 *   but brain registers "alive").
 *   Position drifts ±1px. Rotation drifts ±0.1deg.
 */
export const BreathingWrapper: React.FC<{
  /** Intensity of breathing. 0 = none, 1 = normal, 2 = strong. */
  intensity?: number;
  /** Frequency multiplier. Higher = faster breathing. */
  speed?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ intensity = 1, speed = 1, children, style = {} }) => {
  const frame = useCurrentFrame();

  const scaleBreath = 1 + Math.sin(frame * 0.05 * speed) * 0.002 * intensity;
  const xDrift = Math.sin(frame * 0.03 * speed) * 0.5 * intensity;
  const yDrift = Math.cos(frame * 0.04 * speed) * 0.3 * intensity;
  const rotateDrift = Math.sin(frame * 0.02 * speed) * 0.05 * intensity;

  return (
    <div
      style={{
        transform: `translate(${xDrift}px, ${yDrift}px) scale(${scaleBreath}) rotate(${rotateDrift}deg)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};
