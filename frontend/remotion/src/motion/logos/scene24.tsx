// motion/logos/scene24.tsx
// Scene24 brand mark — 6-line radial (clock / sunburst), one accent line
// at 12 o'clock + 5 blade lines at the other compass positions. Mirrors
// the source images/mark-*.svg exactly so the rendered video frame
// matches the static logo asset pixel-for-pixel when scaled.

import React from "react";
import { Base44SunMark, Base44SunWordmark } from "./base44";

export const Scene24Mark: React.FC<{
  /** Rendered pixel size (square). */
  sizePx: number;
  /** 5 outer blade lines colour. Defaults to ink (paper light theme). */
  bladeColor?: string;
  /** Top accent line colour (the copper "12 o'clock" line). */
  accentColor?: string;
}> = ({ sizePx, bladeColor = "#0a0b0d", accentColor = "#c8744a" }) => (
  <svg
    width={sizePx}
    height={sizePx}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Scene24"
  >
    <line x1="24" y1="24" x2="24" y2="5.76" stroke={accentColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="24" y1="24" x2="39.79" y2="14.88" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="24" y1="24" x2="39.79" y2="33.12" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="24" y1="24" x2="24" y2="42.24" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="24" y1="24" x2="8.21" y2="33.12" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="24" y1="24" x2="8.21" y2="14.88" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Full wordmark lockup — mark + "Scene24" text inline in one SVG, matching
// the source images/wordmark-*.svg pixel-for-pixel. Using this as a single
// element sidesteps the side-by-side positioning problem (proportional
// fonts make the text width hard to predict from a JSON spec). `sizePx`
// here is the HEIGHT — width auto-scales to the 280:48 source aspect.
export const Scene24Wordmark: React.FC<{
  sizePx: number;
  bladeColor?: string;
  accentColor?: string;
}> = ({ sizePx, bladeColor = "#0a0b0d", accentColor = "#c8744a" }) => {
  const widthPx = sizePx * (280 / 48);
  return (
    <svg
      width={widthPx}
      height={sizePx}
      viewBox="0 0 280 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Scene24"
    >
      <g transform="translate(0, 0)">
        <line x1="24" y1="24" x2="24" y2="5.76" stroke={accentColor} strokeWidth="3" strokeLinecap="round" />
        <line x1="24" y1="24" x2="39.79" y2="14.88" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
        <line x1="24" y1="24" x2="39.79" y2="33.12" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
        <line x1="24" y1="24" x2="24" y2="42.24" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
        <line x1="24" y1="24" x2="8.21" y2="33.12" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
        <line x1="24" y1="24" x2="8.21" y2="14.88" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
      </g>
      <text
        x="60"
        y="34"
        fontFamily="Syne, sans-serif"
        fontSize="32"
        fontWeight="800"
        letterSpacing="-0.64"
        fill={bladeColor}
      >
        Scene24
      </text>
    </svg>
  );
};

// Registry of known logo kinds. Add new brand marks here; the spec's
// `kind` discriminator picks the right renderer.
export const LOGO_REGISTRY = {
  scene24: Scene24Mark,
  "scene24-wordmark": Scene24Wordmark,
  "base44-sun": Base44SunMark,
  "base44-wordmark": Base44SunWordmark,
} as const;

export type LogoKind = keyof typeof LOGO_REGISTRY;

export function isLogoKind(s: string): s is LogoKind {
  return s in LOGO_REGISTRY;
}
