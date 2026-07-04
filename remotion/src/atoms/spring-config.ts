/**
 * Spring configuration presets mapped to brand energy levels.
 *
 * These are NOT tied to any specific reference video.
 * They represent universal motion "feels" that map to brand personality.
 *
 * Usage context for LLM:
 *   Visual Creator reads brand_voice.energy and selects the matching preset.
 *   "restrained" brands get slow, heavy springs. "high" brands get snappy, light springs.
 */

export type BrandEnergy = "restrained" | "moderate" | "high";

export interface SpringPreset {
  damping: number;
  stiffness: number;
  mass?: number;
  overshootClamping?: boolean;
}

/**
 * Entrance springs — for elements appearing on screen.
 *
 * Usage: text entering, cards sliding in, devices appearing.
 * Higher damping = more controlled settle. Lower = more energetic.
 */
export const ENTRANCE_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 24, stiffness: 50, overshootClamping: true },
  moderate: { damping: 18, stiffness: 80 },
  high: { damping: 12, stiffness: 120 },
};

/**
 * Exit springs — for elements leaving the screen.
 *
 * Usage: text departing, cards flying out, UI fading away.
 * Exit is typically faster than entrance (viewer's attention moves to next element).
 */
export const EXIT_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 28, stiffness: 40 },
  moderate: { damping: 22, stiffness: 60 },
  high: { damping: 14, stiffness: 100 },
};

/**
 * Settle springs — for elements reaching their final position.
 *
 * Usage: after entrance, the subtle "settling" motion.
 * Very high damping = almost no overshoot. Feels precise.
 */
export const SETTLE_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 30, stiffness: 60, overshootClamping: true },
  moderate: { damping: 22, stiffness: 80 },
  high: { damping: 16, stiffness: 100 },
};

/**
 * Hover/breathing springs — for subtle idle motion during "hold" periods.
 *
 * Usage: elements that appear static but have micro-movement to feel alive.
 * Very subtle — scale 0.99↔1.01, position ±1-2px.
 */
export const BREATHING_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 30, stiffness: 20, mass: 2 },
  moderate: { damping: 25, stiffness: 30, mass: 1.5 },
  high: { damping: 20, stiffness: 40, mass: 1 },
};

/**
 * Click/bounce springs — for interactive feedback (cursor click, button press).
 *
 * Usage: UI element reacts to click — press down then release.
 * From pressed state (0.85) directly to target (no return to 1.0 in between).
 */
export const CLICK_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 20, stiffness: 50 },
  moderate: { damping: 14, stiffness: 100 },
  high: { damping: 10, stiffness: 200 },
};

/**
 * Morph springs — for shape transformations (bar→circle, button→star).
 *
 * Usage: fluid morphing between shapes. Slower than other springs.
 * The morph should feel organic, not mechanical.
 */
export const MORPH_SPRING: Record<BrandEnergy, SpringPreset> = {
  restrained: { damping: 22, stiffness: 35 },
  moderate: { damping: 18, stiffness: 50 },
  high: { damping: 14, stiffness: 70 },
};

/**
 * Duration multipliers — scale all timing by brand energy.
 *
 * restrained brands hold longer, transition slower.
 * high energy brands move fast, hold briefly.
 */
export const DURATION_MULTIPLIER: Record<BrandEnergy, number> = {
  restrained: 1.4,
  moderate: 1.0,
  high: 0.7,
};

/**
 * Get spring config for a specific purpose and brand energy.
 */
export function getSpring(
  purpose: "entrance" | "exit" | "settle" | "breathing" | "click" | "morph",
  energy: BrandEnergy,
): SpringPreset {
  const map = {
    entrance: ENTRANCE_SPRING,
    exit: EXIT_SPRING,
    settle: SETTLE_SPRING,
    breathing: BREATHING_SPRING,
    click: CLICK_SPRING,
    morph: MORPH_SPRING,
  };
  return map[purpose][energy];
}
