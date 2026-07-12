/**
 * lottie-to-remotion — extract motion tracks from a Lottie JSON and expose
 * them as frame-sampleable transform curves for Remotion.
 *
 * Purpose:
 *   Lottie files authored by motion designers in After Effects carry
 *   production-grade timing and easing. This module reads that motion
 *   (opacity, position, scale, rotation keyframes) and turns it into plain
 *   transform tracks. The motion is decoupled from the Lottie's own shapes,
 *   so it can be re-applied to arbitrary children (a title, a card, a UI
 *   element) inside Remotion.
 *
 * Usage context for LLM:
 *   Use this to convert a downloaded Lottie into a reusable kinetic preset.
 *   parseLottieMotion() returns the tracks; the LottiePreset component wraps
 *   children and applies sampleMotion() every frame.
 *
 * Scope:
 *   Covers transform animation (ks: o/p/s/r) on a chosen layer. It does NOT
 *   render Lottie shapes/masks. For full-fidelity shape playback use
 *   @remotion/lottie instead. Transform extraction is enough for the vast
 *   majority of text and UI kinetic motion.
 */

// ---------------------------------------------------------------------------
// Lottie JSON types (subset of the bodymovin spec)
// ---------------------------------------------------------------------------

/** Cubic bezier control points [x1, y1, x2, y2], same as CSS cubic-bezier(). */
export type BezierCurve = [number, number, number, number]

/** Lottie easing handle. x/y are either a scalar or per-dimension array. */
interface LottieHandle {
  x: number | number[]
  y: number | number[]
}

/** A single Lottie keyframe inside an animated property's `k` array. */
interface LottieKeyframe {
  /** Time in Lottie frames. */
  t: number
  /** Start value for this segment (array form). */
  s?: number[]
  /** Out tangent (leaving this keyframe). */
  o?: LottieHandle
  /** In tangent (arriving at the next keyframe). */
  i?: LottieHandle
  /** Hold flag: 1 = step (no interpolation). */
  h?: 0 | 1
}

/** A Lottie animated property: a=1 with keyframes, or a=0 with a static value. */
interface LottieProperty {
  a: 0 | 1
  k: number | number[] | LottieKeyframe[]
}

/** The transform block of a Lottie layer. */
interface LottieTransform {
  /** Opacity 0..100. */
  o?: LottieProperty
  /** Rotation in degrees. */
  r?: LottieProperty
  /** Position [x, y] (or [x, y, z]). */
  p?: LottieProperty
  /** Anchor point. */
  a?: LottieProperty
  /** Scale [x%, y%]. */
  s?: LottieProperty
}

interface LottieLayer {
  nm?: string
  ks?: LottieTransform
  ip?: number
  op?: number
}

export interface LottieJSON {
  /** Frame rate. */
  fr: number
  /** In point (first frame). */
  ip: number
  /** Out point (last frame). */
  op: number
  w: number
  h: number
  layers?: LottieLayer[]
}

// ---------------------------------------------------------------------------
// Parsed motion output
// ---------------------------------------------------------------------------

/** One animated transform channel, sampled by frame. */
export interface MotionTrack {
  /** Keyframe times in Remotion frames (already rescaled to the target fps). */
  times: number[]
  /** Keyframe values (opacity 0..1, scale ratio 1=100%, deg, or px). */
  values: number[]
  /** Bezier easing for each segment between consecutive keyframes. */
  easings: BezierCurve[]
  /** Whether each segment holds (step) instead of interpolating. */
  holds: boolean[]
}

/** All transform tracks extracted from one Lottie layer. */
export interface ParsedMotion {
  /** Source layer name, if any. */
  name: string
  /** Total duration in Remotion frames after any speed change. */
  durationInFrames: number
  opacity?: MotionTrack
  positionX?: MotionTrack
  positionY?: MotionTrack
  scaleX?: MotionTrack
  scaleY?: MotionTrack
  rotation?: MotionTrack
}

export interface ParseOptions {
  /** Target Remotion fps. Lottie times are rescaled to this. Default 30. */
  fps?: number
  /** Playback speed multiplier. 2 = twice as fast (times divided by 2). Default 1. */
  speed?: number
  /** Frames to delay the whole motion. Default 0. */
  delayFrames?: number
  /** Which layer to extract. Default 0 (first animated layer). */
  layerIndex?: number
}

// ---------------------------------------------------------------------------
// Cubic bezier solver (maps eased progress t -> value progress)
// ---------------------------------------------------------------------------

/** Build an easing function from cubic bezier control points. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = (t: number) => ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t + 3 * x1 * t
  const cy = (t: number) => ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t + 3 * y1 * t
  const dx = (t: number) => 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1
  return (x: number) => {
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

const LINEAR: BezierCurve = [0, 0, 1, 1]

/** Convert a Lottie out/in handle pair into CSS cubic bezier points. */
function handlesToBezier(out: LottieHandle | undefined, into: LottieHandle | undefined, dim: number): BezierCurve {
  if (!out || !into) return LINEAR
  const pick = (v: number | number[]): number => (Array.isArray(v) ? (v[dim] ?? v[0] ?? 0) : v)
  return [pick(out.x), pick(out.y), pick(into.x), pick(into.y)]
}

// ---------------------------------------------------------------------------
// Track extraction
// ---------------------------------------------------------------------------

/**
 * Extract a single dimension of a Lottie property into a MotionTrack.
 * `transform` maps the raw Lottie value to the desired unit
 * (e.g. opacity /100, scale /100).
 */
function extractTrack(
  prop: LottieProperty | undefined,
  dim: number,
  transform: (raw: number) => number,
  sourceFps: number,
  opts: Required<ParseOptions>,
): MotionTrack | undefined {
  if (!prop) return undefined
  const scale = (opts.fps / sourceFps) / opts.speed

  // Static property: single flat keyframe.
  if (prop.a === 0 || !Array.isArray(prop.k)) {
    const raw = Array.isArray(prop.k) ? (prop.k[dim] ?? prop.k[0] ?? 0) : (prop.k as number)
    return { times: [0], values: [transform(raw)], easings: [], holds: [] }
  }

  const kfs = prop.k as LottieKeyframe[]
  const times: number[] = []
  const values: number[] = []
  const easings: BezierCurve[] = []
  const holds: boolean[] = []

  for (let idx = 0; idx < kfs.length; idx++) {
    const kf = kfs[idx]!
    const raw = kf.s ? (kf.s[dim] ?? kf.s[0] ?? 0) : 0
    times.push(kf.t * scale + opts.delayFrames)
    values.push(transform(raw))
    if (idx < kfs.length - 1) {
      holds.push(kf.h === 1)
      easings.push(kf.h === 1 ? LINEAR : handlesToBezier(kf.o, kf.i, dim))
    }
  }

  return { times, values, easings, holds }
}

/**
 * Parse the transform motion of one Lottie layer into frame-sampleable tracks.
 * Picks the first layer that actually has animated transform channels unless
 * a layerIndex is given.
 */
export function parseLottieMotion(json: LottieJSON, options: ParseOptions = {}): ParsedMotion {
  const opts: Required<ParseOptions> = {
    fps: options.fps ?? 30,
    speed: options.speed ?? 1,
    delayFrames: options.delayFrames ?? 0,
    layerIndex: options.layerIndex ?? -1,
  }

  const layers = json.layers ?? []
  if (layers.length === 0) {
    throw new Error('lottie-to-remotion: no layers found in Lottie JSON')
  }

  const isAnimated = (t?: LottieTransform): boolean =>
    !!t && [t.o, t.p, t.s, t.r].some((p) => p?.a === 1)

  let layer: LottieLayer | undefined
  if (opts.layerIndex >= 0) {
    layer = layers[opts.layerIndex]
  } else {
    layer = layers.find((l) => isAnimated(l.ks)) ?? layers[0]
  }
  if (!layer || !layer.ks) {
    throw new Error('lottie-to-remotion: selected layer has no transform block')
  }

  const ks = layer.ks
  const scale = (opts.fps / json.fr) / opts.speed
  const durationInFrames = Math.round((json.op - json.ip) * scale) + opts.delayFrames

  return {
    name: layer.nm ?? 'lottie-layer',
    durationInFrames,
    opacity: extractTrack(ks.o, 0, (v) => v / 100, json.fr, opts),
    positionX: extractTrack(ks.p, 0, (v) => v, json.fr, opts),
    positionY: extractTrack(ks.p, 1, (v) => v, json.fr, opts),
    scaleX: extractTrack(ks.s, 0, (v) => v / 100, json.fr, opts),
    scaleY: extractTrack(ks.s, 1, (v) => v / 100, json.fr, opts),
    rotation: extractTrack(ks.r, 0, (v) => v, json.fr, opts),
  }
}

// ---------------------------------------------------------------------------
// Frame sampling
// ---------------------------------------------------------------------------

/** Sample a MotionTrack at an absolute frame. Clamps outside the range. */
export function sampleTrack(frame: number, track: MotionTrack | undefined, fallback: number): number {
  if (!track || track.times.length === 0) return fallback
  const { times, values, easings, holds } = track
  if (times.length === 1) return values[0]!
  if (frame <= times[0]!) return values[0]!
  const last = times.length - 1
  if (frame >= times[last]!) return values[last]!

  for (let i = 0; i < last; i++) {
    const t0 = times[i]!
    const t1 = times[i + 1]!
    if (frame >= t0 && frame < t1) {
      if (holds[i]) return values[i]!
      const localT = (frame - t0) / (t1 - t0)
      const curve = easings[i] ?? LINEAR
      const eased = cubicBezier(curve[0], curve[1], curve[2], curve[3])(localT)
      return values[i]! + (values[i + 1]! - values[i]!) * eased
    }
  }
  return values[last]!
}

/** Resolved transform values for one frame. */
export interface SampledTransform {
  opacity: number
  translateX: number
  translateY: number
  scaleX: number
  scaleY: number
  rotation: number
}

/**
 * Sample every track of a ParsedMotion at one frame.
 * Position is returned relative to the first keyframe so the motion can be
 * applied on top of a normally-laid-out element (offset, not absolute).
 */
export function sampleMotion(frame: number, motion: ParsedMotion): SampledTransform {
  const px0 = motion.positionX?.values[0] ?? 0
  const py0 = motion.positionY?.values[0] ?? 0
  return {
    opacity: sampleTrack(frame, motion.opacity, 1),
    translateX: sampleTrack(frame, motion.positionX, px0) - px0,
    translateY: sampleTrack(frame, motion.positionY, py0) - py0,
    scaleX: sampleTrack(frame, motion.scaleX, 1),
    scaleY: sampleTrack(frame, motion.scaleY, 1),
    rotation: sampleTrack(frame, motion.rotation, 0),
  }
}
