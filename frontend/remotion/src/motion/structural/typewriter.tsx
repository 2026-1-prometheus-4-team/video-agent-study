// structural/typewriter.tsx
// Type / erase by char or word, optional blinking caret. Cadence "human"
// jitters each reveal step deterministically (seeded RNG). gapSettle and
// letterFadeTrail are exposed as schedule-aware per-letter modifiers that
// ComposedText folds into the rendered glyph style.

import { clamp, lerp, type EasingName } from "../core/easing";
import { seededRandom } from "../core/random";
import type { Letter } from "./splitText";

export type TypewriterProps = {
  unit?: "char" | "word";
  mode?: "type" | "erase";
  charsPerSecond?: number;
  eraseFrom?: "left" | "right" | "edges";
  cursor?: "none" | "light" | "dark";
  cadence?: "uniform" | "human";
  seed?: number;
  // TEXT_MOTION_SPEC 2.1
  gapSettle?: { from: number; duration: number };
  letterFadeTrail?: number;
  // Reveal blur-in: each freshly revealed unit (char or word) starts blurry
  // and settles to sharp over `duration` frames. Off when omitted.
  revealBlur?: { from?: number; duration?: number };
  /** 방금 등장한 글자 틴트 — color 로 찍혔다가 fade 프레임 동안 본문색으로. */
  freshTint?: { color?: string; fade?: number };
  // 공개 전 유닛을 숨기는 대신 "흐림+반투명 고스트"로 보여준다 — 전 단어가
  // 처음부터 자리 잡고 있고 블러만 순차 해제되는 히어로 타이틀 리빌
  // (레퍼런스 실측: SaaS 프로모 오프닝). revealBlur 와 연속(등장 순간 점프 X).
  preReveal?: { opacity?: number; blur?: number };
  // Reveal scale/rotate-in: each freshly revealed unit starts small and/or
  // tilted (사선) and settles to scale 1 / 0deg over `duration` frames. Off
  // when omitted. Used for the characters_settle glyph-pop reveal (작은 사선
  // 글자가 정자체로 안착). ease-out 안착이라 뒤로 갈수록 부드럽게 멈춘다.
  revealScale?: { from?: number; duration?: number };
  revealRotate?: { from?: number; duration?: number };
  // Reveal slide-in: each freshly revealed unit starts offset horizontally
  // (from in em; negative = left of home so a new glyph overlaps its
  // predecessor) and slides to 0 over `duration` frames (ease-out). Used by
  // characters_settle: 새 글자가 이전 글자에 겹쳐 나타나 제자리로 미끄러진다.
  // reflow:"smooth"(char) 의 그룹 좌측 밀림과 물려서 함께 동작한다.
  revealX?: { from?: number; duration?: number };
  // Reveal rise: each freshly revealed unit starts offset vertically (y in
  // em; positive = 제자리보다 아래에서 시작해 0 으로 떠오름) over `duration`
  // frames (ease-out). statement/base44 워드 등장의 "살짝 떠오르며 안착"에 쓴다.
  // revealGap(간격 좁아짐) + reflow 와 함께 그 "쫀득" 워드 등장을 만든다.
  revealMove?: { y?: number; duration?: number };
  // "off" (default) keeps the full sentence layout fixed and only toggles
  // each unit's opacity at reveal. No center bounce, no jump.
  // "smooth" applies a closed-form cumulative shift so the visible center
  // glides toward the screen center without the event-triggered easing
  // that the old reflow had — multiple in-flight reveals blend instead
  // of resetting each other. Effective for unit:"word" and unit:"char"
  // (char: 우측 edge 고정 = 오른쪽 끝에서 시작해 왼쪽으로 자라 정중앙 안착,
  //  easeOut 감속으로 마지막에 느리게 멈춘다).
  reflow?: "off" | "smooth" | "collapse";
  // Frames over which each word's reflow contribution eases in (closed-form).
  reflowSmoothing?: number;
  // Continuous line drift independent of reveals. Useful to make the whole
  // line slowly travel sideways instead of sitting completely still.
  flow?: "none" | "left" | "right";
  // px per frame for `flow`. Default 0.
  flowSpeed?: number;
  // Override the gap between unit 0 and unit 1 (frames). Lets the first
  // unit sit alone for a beat before the next one barges in. All later
  // gaps stay on charsPerSecond (or wordGap).
  firstGap?: number;
  // Direct gap between consecutive units in frames. When set, takes
  // precedence over charsPerSecond / cadence (units appear strictly on
  // this beat). Schedule becomes:
  //   reveal[0] = 0
  //   reveal[1] = firstGap ?? wordGap
  //   reveal[i in 2..N-2] = reveal[i-1] + wordGap
  //   reveal[N-1] = reveal[N-2] + (lastGap ?? wordGap)
  // Lets you decouple "how often a new unit shows up" from "how long
  // the per-unit settle takes" (revealGap / revealBlur duration).
  wordGap?: number;
  // Override the gap going INTO the last unit. Used to give the final
  // word breathing room without slowing the whole line. Only meaningful
  // alongside `wordGap` (the strict beat path).
  lastGap?: number;
  // How many frames the reflow shift leads the actual reveal. The shift
  // for unit i ramps up from (reveal_i - reflowLead), so the line opens
  // a hole first and the new unit drops into the existing space.
  reflowLead?: number;
  // Per-unit reveal-time gap settle. The space BEFORE the newly revealed
  // unit starts at `from` x the normal space width and shrinks back to 1
  // over `duration` frames. So a new word arrives with extra breathing
  // room around it and tightens up. Type mode only.
  revealGap?: { from?: number; duration?: number; easing?: EasingName };
  // 단어별 등장 frame 직접 지정(인덱스 순서 무관). 길이가 unit 수와 같으면
  // revealSchedule 대신 이 배열을 쓴다. "기본문장 먼저 + 강조어 나중 삽입"처럼
  // 문장 인덱스 순서가 아닌 커스텀 등장 순서용(biasafe 2막-C 태그라인).
  revealAt?: number[];
};

// Precompute cumulative reveal frames per unit so that "human" cadence
// (bursts and micro pauses) stays deterministic.
function revealSchedule(
  count: number,
  fps: number,
  cps: number,
  cadence: "uniform" | "human",
  seed: number,
  firstGap?: number,
  wordGap?: number,
  lastGap?: number,
): number[] {
  // wordGap path: strict frame-based beat, no cadence jitter. First unit
  // lands at frame 0, the gap leading into unit 1 is firstGap (falls back
  // to wordGap), the gap leading into the last unit is lastGap if set,
  // and every gap in between is wordGap.
  if (typeof wordGap === "number") {
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
      if (i === 0) {
        t = 0;
      } else if (i === 1) {
        t += Math.max(1, firstGap ?? wordGap);
      } else if (i === count - 1 && typeof lastGap === "number") {
        t += Math.max(1, lastGap);
      } else {
        t += Math.max(1, wordGap);
      }
      times.push(t);
    }
    return times;
  }
  // cps path: original cadence behaviour.
  const base = fps / clamp(cps, 2, 60);
  const rand = seededRandom(seed);
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    let step = base;
    if (cadence === "human") {
      step = base * lerp(0.55, 1.7, rand());
      if (rand() < 0.12) step += base * 2.2; // occasional pause
    }
    // firstGap overrides the gap leading into unit 1 (the second unit),
    // so the first reveal sits alone for `firstGap` frames before the
    // next one shows up. Later units stay on the cadence curve.
    if (i === 1 && typeof firstGap === "number") {
      step = Math.max(1, firstGap);
    }
    t += step;
    times.push(t);
  }
  return times;
}

export type TypewriterState = {
  visible: (l: Letter) => boolean;
  lastVisibleCharIdx: number;
  // Local frame at which the unit (char or word) containing this letter
  // first became fully visible (type mode) or -Infinity if not yet.
  unitRevealFrame: (l: Letter) => number;
  unit: "char" | "word";
  unitCount: number;
  shown: number; // number of units currently visible
  // Cumulative reveal frames indexed by unit (word or char). reflow uses
  // schedule[shown - 1] to know when the most recent unit appeared.
  unitSchedule: number[];
};

export function typewriterVisible(
  letters: Letter[],
  localFrame: number,
  fps: number,
  p: TypewriterProps,
): TypewriterState {
  const unit = p.unit ?? "char";
  const mode = p.mode ?? "type";
  const total =
    unit === "word"
      ? Math.max(...letters.map((l) => l.wordIdx)) + 1
      : Math.max(...letters.map((l) => l.charIdx)) + 1;
  const schedule =
    Array.isArray(p.revealAt) && p.revealAt.length === total
      ? p.revealAt
      : revealSchedule(
          total,
          fps,
          p.charsPerSecond ?? (unit === "word" ? 5 : 14),
          p.cadence ?? "uniform",
          p.seed ?? 7,
          p.firstGap,
          p.wordGap,
          p.lastGap,
        );
  let shown = 0;
  for (let i = 0; i < total; i++) {
    if (localFrame >= schedule[i]) shown = i + 1;
  }
  const unitIdx = (l: Letter) => (unit === "word" ? l.wordIdx : l.charIdx);
  const unitRevealFrame = (l: Letter) => {
    const idx = unitIdx(l);
    if (idx < 0 || idx >= total) return -Infinity;
    return schedule[idx];
  };

  if (mode === "type") {
    const visible = (l: Letter) => unitIdx(l) < shown;
    let last = -1;
    for (const l of letters) {
      if (!l.isSpace && visible(l)) last = Math.max(last, l.charIdx);
    }
    return {
      visible,
      lastVisibleCharIdx: last,
      unitRevealFrame,
      unit,
      unitCount: total,
      shown,
      unitSchedule: schedule,
    };
  }
  // erase mode: progressively consume units
  const erased = shown;
  const from = p.eraseFrom ?? "left";
  const visible = (l: Letter) => {
    const idx = unitIdx(l);
    if (from === "left") return idx >= erased;
    if (from === "right") return idx < total - erased;
    // edges: consume alternately from both sides
    const fromLeft = Math.ceil(erased / 2);
    const fromRight = Math.floor(erased / 2);
    return idx >= fromLeft && idx < total - fromRight;
  };
  let last = -1;
  for (const l of letters) {
    if (!l.isSpace && visible(l)) last = Math.max(last, l.charIdx);
  }
  return {
    visible,
    lastVisibleCharIdx: last,
    unitRevealFrame,
    unit,
    unitCount: total,
    shown,
    unitSchedule: schedule,
  };
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as TypewriterProps & { duration?: number };
  if (typeof p.duration === "number") return Math.max(1, p.duration);
  const SETTLE = 6;
  if (typeof p.wordGap === "number") {
    const wordGap = Math.max(1, p.wordGap);
    const firstGap = Math.max(1, p.firstGap ?? p.wordGap);
    const lastGap =
      typeof p.lastGap === "number" ? Math.max(1, p.lastGap) : wordGap;
    // total gap budget: firstGap (going into unit 1) + (N-3) middle gaps
    // + lastGap (going into unit N-1). When count < 3, the lastGap slot
    // doesn't exist as a separate beat — the firstGap already covers it.
    const middleGaps = Math.max(0, ctx.unitCount - 3);
    const beats =
      firstGap +
      middleGaps * wordGap +
      (ctx.unitCount >= 3 ? lastGap : 0);
    return Math.max(1, beats + SETTLE);
  }
  const cps = p.charsPerSecond ?? (p.unit === "word" ? 5 : 14);
  const cpsClamped = Math.max(2, Math.min(60, cps));
  return Math.ceil((ctx.unitCount / cpsClamped) * ctx.fps) + 4;
}

export const name = "typewriter";
export const labPreset = {
  role: "in" as const,
  props: {
    unit: "char",
    charsPerSecond: 13,
    cadence: "human",
    cursor: "none",
  } as Record<string, unknown>,
};
