/**
 * easings — named cubic-bezier easing presets for kinetic motion.
 *
 * Purpose:
 *   A shared vocabulary of easing curves so every preset in this project
 *   pulls from the same, verified set. Good easing is the single biggest
 *   lever on perceived motion quality; hardcoding random bezier values per
 *   component is what makes motion feel "off".
 *
 * Usage context for LLM:
 *   When building a kinetic preset, pick an easing by intent:
 *     - entrance that arrives with momentum then settles -> EASE.smoothOut
 *     - snappy UI response -> EASE.snappy
 *     - element that overshoots its target then eases back -> EASE.overshoot
 *     - element that dips back before launching -> EASE.anticipate
 *     - exit that accelerates away -> EASE.exitFast
 *   Pass the function straight into Remotion's interpolate:
 *     interpolate(frame, [0, 20], [0, 1], { easing: EASE.smoothOut })
 *
 * Licensing note:
 *   The structure and naming were informed by egaki's easing module (MIT).
 *   The curve values here are standard motion-community cubic-bezier values
 *   (easeOutExpo, easeOutBack, Material standard, etc.), defined from scratch
 *   so nothing is copied and the library stays clean for commercial use.
 */

export type EasingFn = (t: number) => number

/**
 * cubic-bezier(x1, y1, x2, y2) as a y(x) easing function.
 * x1/x2 must be in [0, 1]; y values may exceed [0, 1] for overshoot curves.
 * Solved with Newton-Raphson (6 iterations is accurate to sub-pixel).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t + 3 * x1 * t
  const cy = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t + 3 * y1 * t
  const dx = (t: number) => 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 6; i++) {
      const xErr = cx(t) - x
      const d = dx(t)
      if (Math.abs(xErr) < 1e-4 || Math.abs(d) < 1e-6) break
      t = t - xErr / d
    }
    return cy(t)
  }
}

/**
 * Named easing presets, keyed by intent. Values are standard curves:
 *   smoothOut     easeOutExpo    fast start, long gentle settle (default entrance)
 *   smoothInOut   easeInOutCubic symmetric ease both ends
 *   snappy        strong ease-out, reaches target quickly then holds
 *   gentle        Material standard, calm and neutral
 *   decelerate    Material decelerate, enters and slows to rest
 *   accelerate    Material accelerate, starts at rest and speeds up (exits)
 *   anticipate    easeInBack, dips backward before moving (wind-up)
 *   overshoot     easeOutBack, passes the target then eases back
 *   overshootSoft milder easeOutBack for subtle bounce
 *   exitFast      accelerates out, for elements leaving the frame
 *   exitSmooth    softer accelerate-out
 */
export const EASE = {
  linear: ((t: number) => t) as EasingFn,
  smoothOut: cubicBezier(0.16, 1, 0.3, 1),
  smoothInOut: cubicBezier(0.65, 0, 0.35, 1),
  snappy: cubicBezier(0.5, 0, 0, 1),
  gentle: cubicBezier(0.4, 0, 0.2, 1),
  decelerate: cubicBezier(0, 0, 0.2, 1),
  accelerate: cubicBezier(0.4, 0, 1, 1),
  anticipate: cubicBezier(0.36, 0, 0.66, -0.56),
  overshoot: cubicBezier(0.34, 1.56, 0.64, 1),
  overshootSoft: cubicBezier(0.25, 1.2, 0.5, 1),
  exitFast: cubicBezier(0.5, 0, 0.75, 0),
  exitSmooth: cubicBezier(0.7, 0, 0.84, 0),
} as const

export type EaseName = keyof typeof EASE

/** Resolve an easing by name or pass through a custom function. */
export function resolveEasing(easing: EaseName | EasingFn): EasingFn {
  return typeof easing === 'function' ? easing : EASE[easing]
}
