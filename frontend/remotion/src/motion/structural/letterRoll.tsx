// structural/letterRoll.tsx
// Slot-machine reel atom. Each glyph is a vertical viewport (one-glyph
// tall, overflow hidden) with a column of random characters scrolling
// past, decelerating onto the final glyph. Neighbouring glyphs scroll
// in OPPOSITE directions — the zigzag is what reads as "machine"
// rather than "string of independent spinners".
//
// Pro-grade details (carried from scramble's lessons + the slot-machine
// specifics):
//
//  1. SLOT WIDTH = MAX(finalGlyph, every charset glyph).
//     Computed in ComposedText with measureText() over the entire
//     charset. Each reel pinned via min/max-width so a wider noise
//     glyph cannot escape its slot and bump the next reel. Same fix
//     that made scramble stop reflowing.
//
//  2. ZIGZAG DIRECTION.
//     Letter at charIdx i picks dir = (i % 2 === 0 ? firstDir : -firstDir).
//     dir=+1 scrolls UP (chars exit top, enter bottom); dir=-1 scrolls
//     DOWN (chars exit bottom, enter top). Alternating directions on
//     adjacent glyphs gives the "every other reel spins the other way"
//     look you see on real slot machines.
//
//  3. TWO-PHASE DECEL: CONSTANT FAST SPIN → GRADUAL SLOWDOWN.
//     Phase 1 (first `freeFrac` of duration): linear scroll at constant
//     velocity — this is the "spinning" the eye reads as "still going".
//     Phase 2 (remaining 1-freeFrac): easeOut (Quad or Cubic) — gradual
//     deceleration to a clean stop at zero. The two phases meet at a
//     continuous velocity (free_progress is solved as
//     `easePow·freeFrac / (1 + (easePow-1)·freeFrac)` so the linear
//     velocity matches the easeOut start-of-settle derivative exactly —
//     no velocity jump at the boundary, no jerk).
//
//  4. SETTLE MODE — TWO DECEL SHAPES.
//     "stagger" (default) — settleFrame = duration + ci·stagger. Reels
//        stop one by one left→right (slot-machine / roulette feel).
//        Two-phase: linear constant-velocity spin (freeFrac default 0.55)
//        then easeOutQuad. Use for emphasis, beat, excitement.
//     "together" — settleFrame = duration. All reels stop at the SAME
//        frame, decelerating together. SINGLE-PHASE easeOutCubic
//        (freeFrac default 0): peak velocity at f0 then velocity
//        continuously decreases the whole way down — a rolling ball
//        coasting to a stop on friction, no brakes. The cubic tail
//        means the last ~5 frames the glyphs almost drift to a halt.
//        Use for relaxed, breather, casual reveals.
//
//  4. VELOCITY-LINKED VERTICAL MOTION BLUR.
//     Per-frame |velocity| × slotHeight × blurFactor → SVG
//     feGaussianBlur with stdDeviation="0 Y" (vertical only). Goes to
//     zero exactly when the reel settles, so the locked glyph is crisp.
//     CSS filter:blur() is radial and would smear the X axis too — we
//     don't want that.

import React from "react";
import { clamp01 } from "../core/easing";
import type { Letter } from "./splitText";

export type LetterRollProps = {
  /** Pool of glyphs the reel rolls through. Default is uppercase + digits;
   *  override for katakana, Hangul, etc. */
  charset?: string;
  /** Per-letter SETTLE delay (frames) in `settleMode: "stagger"`. Letter
   *  i settles at duration + i*stagger. Ignored in `"together"` mode
   *  (all letters settle at `duration`). */
  stagger?: number;
  /** Total frames the first letter spends rolling (also: total frames for
   *  every letter in `"together"` mode). */
  duration?: number;
  /** "stagger" — reels stop sequentially left→right (slot-machine feel),
   *  easeOutQuad settle. "together" — all reels stop simultaneously,
   *  easeOutCubic settle (longer slow tail). Default "stagger". */
  settleMode?: "stagger" | "together";
  /** Slots traversed per frame during the constant-velocity free-roll
   *  phase. The settle phase (last `1-freeFrac` of duration) decelerates
   *  from this speed to zero via easeOutQuad. */
  rollSpeed?: number;
  /** Fraction of `duration` spent in the constant-velocity free-roll
   *  phase. Default 0.55. Bigger value = longer constant spin, shorter
   *  decel; smaller = shorter spin, longer decel. */
  freeFrac?: number;
  /** Direction of charIdx=0. The next glyph gets the opposite, and so on. */
  firstDir?: 1 | -1;
  /** Motion-blur scaler. Final stdDeviation_y = |velocity_slots_per_frame|
   *  × slotHeightPx × (blurFactor / 24). 0 = no blur. */
  blurFactor?: number;
  /** Deterministic noise + tiebreak. */
  seed?: number;
};

export const DEFAULT_ROLL_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DEFAULT_STAGGER = 2;
const DEFAULT_DURATION = 28;
const DEFAULT_ROLL_SPEED = 1.8;
const DEFAULT_FREE_FRAC = 0.55;
const DEFAULT_BLUR_FACTOR = 4;
const DEFAULT_SEED = 23;

// Slot-offset-keyed glyph picker. Each reel shows ONLY its target glyph
// (M reel rolls M's, O reel rolls O's). The "spin" is the vertical
// translation — all slots in the column hold the same letter, so the
// eye reads a continuous letter sliding past the window. The
// `charset` / `seed` / `charIdx` params are kept on the signature for
// future overrides (e.g. mixing noise glyphs back in) but currently
// ignored.
export function reelCharAt(
  _slotOffset: number,
  finalChar: string,
  _charset: string,
  _seed: number,
  _charIdx: number,
): string {
  return finalChar;
}

export type LetterRollState = {
  /** Signed offset from target in slot-units. 0 = target centered.
   *  Sign depends on dir (where the reel "came from"). */
  posSlots: number;
  /** Per-frame Δ of posSlots. Drives motion blur. */
  velocity: number;
  /** +1 or -1. ComposedText uses the magnitude (slot height) but the
   *  sign is implicit in posSlots and translateY math. */
  dir: 1 | -1;
  /** True once locked on target with zero velocity. */
  isSettled: boolean;
};

// Roll progress. Two shapes:
//   freeFrac > 0 — linear constant-velocity free roll then easeOut
//                  (power 2 or 3). Boundary velocity matched by setting
//                  freeProgress = easePow·freeFrac / (1+(easePow-1)·freeFrac)
//                  so the linear velocity equals the easeOut start-of-settle
//                  derivative.
//   freeFrac = 0 — pure easeOut across the whole duration. Velocity is
//                  highest at f0 and decreases monotonically to zero.
//                  Models a rolling ball decelerating on friction with
//                  no constant-speed phase.
function rollProgress(t: number, freeFrac: number, easePow: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (freeFrac <= 0) {
    return 1 - Math.pow(1 - t, easePow);
  }
  const freeProgress = (easePow * freeFrac) / (1 + (easePow - 1) * freeFrac);
  if (t <= freeFrac) {
    return (t / freeFrac) * freeProgress;
  }
  const settleT = (t - freeFrac) / (1 - freeFrac);
  const eased = 1 - Math.pow(1 - settleT, easePow);
  return freeProgress + (1 - freeProgress) * eased;
}

export function letterRollState(
  l: Letter,
  localFrame: number,
  props: LetterRollProps,
): LetterRollState {
  const stagger = Math.max(0, props.stagger ?? DEFAULT_STAGGER);
  const firstDir: 1 | -1 = (props.firstDir ?? 1) as 1 | -1;
  const settleMode = props.settleMode ?? "stagger";
  // Mode-aware defaults. "together" is the calm-coast mode — long
  // duration, low rollSpeed, cubic decel so the last 15-20% of frames
  // are barely-moving drift before the final stop. "stagger" stays
  // snappier (slot-machine feel).
  const duration = Math.max(
    2,
    props.duration ?? (settleMode === "together" ? 96 : DEFAULT_DURATION),
  );
  const rollSpeed = Math.max(
    0.01,
    props.rollSpeed ?? (settleMode === "together" ? 0.7 : DEFAULT_ROLL_SPEED),
  );
  // stagger uses easeOutQuad (linear velocity decay — slot-machine snap).
  // together uses easeOutCubic — quadratic velocity decay, with a very
  // long slow tail where the glyph almost-but-not-quite stops, then
  // finally locks. Reads as "ball coasting on rolling friction" rather
  // than "ball with brakes applied".
  const easePow = settleMode === "together" ? 3 : 2;
  // freeFrac defaults differ by mode. stagger gets a constant-velocity
  // phase first (slot-machine "spinning" then snap-stop). together
  // defaults to 0 — pure easeOut from f0 so the velocity is decreasing
  // from the very first frame (rolling ball with friction).
  const freeFrac = clamp01(
    props.freeFrac ?? (settleMode === "together" ? 0 : DEFAULT_FREE_FRAC),
  );

  // Zigzag: alternating direction per glyph index.
  const dir: 1 | -1 = (l.charIdx % 2 === 0 ? firstDir : -firstDir) as 1 | -1;

  // Every reel starts spinning at frame 0.
  // stagger mode: settleFrame = duration + ci*stagger (sequential lock).
  // together mode: settleFrame = duration (simultaneous lock).
  // Total distance scales with settleFrame so free-roll velocity stays
  // constant across all reels (rollSpeed × easePow/(1+(easePow-1)·freeFrac)
  // / freeFrac slots/frame in the free phase).
  const settleFrame =
    settleMode === "together" ? duration : duration + l.charIdx * stagger;

  if (localFrame >= settleFrame) {
    return { posSlots: 0, velocity: 0, dir, isSettled: true };
  }
  if (localFrame < 0) {
    const initialPos = -dir * rollSpeed * settleFrame;
    return { posSlots: initialPos, velocity: 0, dir, isSettled: false };
  }

  const totalDistance = rollSpeed * settleFrame;
  const initialPos = -dir * totalDistance;

  const tNorm = localFrame / settleFrame;
  const tNormNext = Math.min(1, (localFrame + 1) / settleFrame);
  const p = rollProgress(tNorm, freeFrac, easePow);
  const pNext = rollProgress(tNormNext, freeFrac, easePow);
  const pos = initialPos * (1 - p);
  const posNext = initialPos * (1 - pNext);
  return {
    posSlots: pos,
    velocity: posNext - pos,
    dir,
    isSettled: false,
  };
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as LetterRollProps;
  const settleMode = p.settleMode ?? "stagger";
  const stagger = Math.max(0, p.stagger ?? DEFAULT_STAGGER);
  const duration = Math.max(
    2,
    p.duration ?? (settleMode === "together" ? 96 : DEFAULT_DURATION),
  );
  const n = Math.max(1, ctx.unitCount);
  // together: every reel settles at `duration`. stagger: the last reel
  // (charIdx n-1) settles at `duration + (n-1)*stagger`.
  return Math.ceil(
    settleMode === "together" ? duration : duration + (n - 1) * stagger,
  );
}

// Per-glyph reel. ComposedText computes slotWidthPx (max over charset)
// and slotHeightPx (~1.1 × fontSizePx) and hands them in so we don't
// need to re-measure here.
export const LetterReel: React.FC<{
  state: LetterRollState;
  finalChar: string;
  charset: string;
  seed: number;
  charIdx: number;
  slotWidthPx: number;
  slotHeightPx: number;
  color: string;
  blurFactor: number;
  wordIdx: number;
}> = ({
  state,
  finalChar,
  charset,
  seed,
  charIdx,
  slotWidthPx,
  slotHeightPx,
  color,
  blurFactor,
  wordIdx,
}) => {
  const reactId = React.useId();
  const filterId = `rollblur-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // Vertical-only motion blur. Disabled when below a perceptual floor so
  // the locked glyph isn't slightly hazy from rounding noise.
  const blurY =
    Math.abs(state.velocity) * slotHeightPx * (blurFactor / 24);
  const blurOn = blurY > 0.5;

  // Render three consecutive slot rows: [baseSlot-1, baseSlot, baseSlot+1].
  // translateY = -(1 + frac) × slotHeight puts baseSlot in the window when
  // frac=0; as frac → 1 the column slides up another slotHeight so
  // baseSlot+1 is in the window — continuous across integer boundaries.
  const baseSlot = Math.floor(state.posSlots);
  const frac = state.posSlots - baseSlot;
  const slotsToRender = [-1, 0, 1].map((k) => baseSlot + k);
  const w = `${slotWidthPx.toFixed(2)}px`;
  const h = `${slotHeightPx.toFixed(2)}px`;
  const translateY = (-(1 + frac) * slotHeightPx).toFixed(2);

  return (
    <span
      data-word-idx={wordIdx}
      style={{
        display: "inline-block",
        width: w,
        minWidth: w,
        maxWidth: w,
        height: h,
        verticalAlign: "baseline",
        position: "relative",
        // overflow:hidden on the OUTER span is what stops the rendered
        // glyph from leaking below the slot (font antialiasing + line-
        // box leading routinely paint pixels below the cap baseline that
        // the inner clip alone won't catch). It also changes the inline-
        // block's baseline rule from "last line's baseline" to "bottom
        // margin edge" — same baseline for every reel, no zig-zag from
        // baseline drift.
        overflow: "hidden",
        color,
      }}
    >
      {blurOn && (
        <svg
          width="0"
          height="0"
          aria-hidden
          style={{ position: "absolute", overflow: "visible" }}
        >
          <defs>
            <filter
              id={filterId}
              x="-10%"
              y="-50%"
              width="120%"
              height="200%"
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur stdDeviation={`0 ${blurY.toFixed(2)}`} />
            </filter>
          </defs>
        </svg>
      )}
      <div
        style={{
          overflow: "hidden",
          height: h,
          width: w,
          filter: blurOn ? `url(#${filterId})` : undefined,
        }}
      >
        <div
          style={{
            transform: `translateY(${translateY}px)`,
            willChange: "transform",
          }}
        >
          {slotsToRender.map((s) => (
            <div
              key={s}
              style={{
                height: h,
                lineHeight: h,
                textAlign: "center",
                // Per-row clip too — a wider/taller glyph in one row
                // can't bleed into the adjacent row's space (which would
                // then appear when translateY brings that row into view).
                overflow: "hidden",
              }}
            >
              {reelCharAt(s, finalChar, charset, seed, charIdx)}
            </div>
          ))}
        </div>
      </div>
    </span>
  );
};

export const name = "letter_roll";
export const labPreset = {
  role: "in" as const,
  props: {
    charset: DEFAULT_ROLL_CHARSET,
    stagger: DEFAULT_STAGGER,
    duration: DEFAULT_DURATION,
    rollSpeed: DEFAULT_ROLL_SPEED,
    freeFrac: DEFAULT_FREE_FRAC,
    settleMode: "stagger",
    firstDir: 1,
    blurFactor: DEFAULT_BLUR_FACTOR,
    seed: DEFAULT_SEED,
  } as Record<string, unknown>,
};
