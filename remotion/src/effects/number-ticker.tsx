/**
 * NumberTicker — smoothly counting number that simulates live data.
 *
 * Usage context for LLM:
 *   Shows "live data updating" — revenue ticking up, calories counting,
 *   AQI changing, temperature shifting. Creates "this is a real, working product"
 *   impression even in a static mockup.
 *
 *   From Base44 analysis:
 *     - $189,450 → $190,280 (financial dashboard)
 *     - 308 kcal → 341 kcal (nutrition tracker)
 *     - 17 AQI → 19 AQI (weather app)
 *     - 1224 Hours → 1231 Hours (course metrics)
 *     - 4.2 kW (energy dashboard)
 *
 *   The tick speed should be natural — not uniform but with micro-variation.
 *   Numbers that change slowly feel more "real" than rapid counting.
 *
 * Combines well with:
 *   - DashboardUI (any mockup with metrics)
 *   - ProgressBar (counter above the bar)
 *   - MultiWidgetDashboard (multiple tickers simultaneously)
 *
 * Avoid:
 *   - Counting from 0 (unless it's a progress bar). Start from a realistic value.
 *   - Uniform tick speed (add micro-variation for organic feel)
 *   - More than 4 tickers visible simultaneously (overwhelming)
 */

import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";

interface NumberTickerProps {
  /** Starting value */
  from: number;
  /** Ending value */
  to: number;
  /** Frame at which counting starts */
  startFrame: number;
  /** How many frames the count takes */
  durationFrames?: number;
  /** Number format: 'integer' | 'decimal1' | 'decimal2' | 'currency' | 'percentage' */
  format?: "integer" | "decimal1" | "decimal2" | "currency" | "percentage";
  /** Currency symbol (if format = 'currency') */
  currencySymbol?: string;
  /** Suffix text (e.g., " kW", " kcal", " Hours") */
  suffix?: string;
  /** Prefix text (e.g., "$", "AQI ") */
  prefix?: string;
  /** Font size in px */
  fontSize?: number;
  /** Font weight */
  fontWeight?: number;
  /** Text color */
  color?: string;
  /** Optional: gradient for the number */
  gradient?: string;
  style?: React.CSSProperties;
}

export const NumberTicker: React.FC<NumberTickerProps> = ({
  from,
  to,
  startFrame,
  durationFrames = 30,
  format = "integer",
  currencySymbol = "$",
  suffix = "",
  prefix = "",
  fontSize = 32,
  fontWeight = 600,
  color = "#1A1A1A",
  gradient,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const localFrame = Math.max(0, frame - startFrame);

  // Ease-out counting (fast start, slow end) — feels natural
  const progress = interpolate(
    localFrame,
    [0, durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Apply ease-out curve
  const easedProgress = 1 - Math.pow(1 - progress, 2.5);

  const currentValue = from + (to - from) * easedProgress;

  // Format the number
  let displayText = "";
  switch (format) {
    case "integer":
      displayText = `${prefix}${Math.round(currentValue).toLocaleString()}${suffix}`;
      break;
    case "decimal1":
      displayText = `${prefix}${currentValue.toFixed(1)}${suffix}`;
      break;
    case "decimal2":
      displayText = `${prefix}${currentValue.toFixed(2)}${suffix}`;
      break;
    case "currency":
      displayText = `${currencySymbol}${Math.round(currentValue).toLocaleString()}${suffix}`;
      break;
    case "percentage":
      displayText = `${prefix}${Math.round(currentValue)}%${suffix}`;
      break;
  }

  const textStyle: React.CSSProperties = {
    fontSize,
    fontWeight,
    fontFamily: "Inter, sans-serif",
    fontVariantNumeric: "tabular-nums", // Monospace numbers prevent layout shift
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
        {displayText}
      </span>
    );
  }

  return (
    <span style={{ ...textStyle, color }}>
      {displayText}
    </span>
  );
};
