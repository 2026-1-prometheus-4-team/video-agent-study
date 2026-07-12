// easing.ts
// Easing functions and the math primitives (clamp / lerp) that the rest of
// the motion engine depends on. LOGIC layer: the LLM never touches anything
// in this file.
//
// Default convention (TEXT_MOTION_SPEC 0.2):
//   in -> easeOutExpo, letter y rise -> easeOutBack,
//   hold drift -> easeInOut, out -> easeIn.

export type EasingName =
  | "linear"
  | "easeIn"
  | "easeInQuad"
  | "easeInQuart"
  | "easeInBack"
  | "easeInExpo"
  | "easeInBlast"
  | "easeInCirc"
  | "easeInBoost"
  | "easeInAccel"
  | "easeOut"
  | "easeOutQuad"
  | "easeOutQuart"
  | "easeOutBack"
  | "easeOutExpo"
  | "easeOutCirc"
  | "easeInOut"
  | "bounceOut"
  | "springOut"
  | "step";

export const EASING: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  // easeIn (cubic, t^3) ramps slowly and finishes fastest. easeInQuad
  // (quadratic, t^2) gets to noticeable speed sooner — use it when you
  // want acceleration to feel "already underway" instead of dawdling.
  easeIn: (t) => t * t * t,
  easeInQuad: (t) => t * t,
  // easeInQuart (t^4): one step harsher than easeIn — derivative at t=1
  // is 4 (vs 3 for cubic). Slower start, stronger finish.
  easeInQuart: (t) => t * t * t * t,
  // easeInCirc: quarter-circle curve. Derivative at t=1 is infinite, so
  // the final frames hit harder than any polynomial in here — the most
  // extreme acceleration available without overshoot or back-dip.
  easeInCirc: (t) => 1 - Math.sqrt(Math.max(0, 1 - t * t)),
  // easeInBoost: starts at non-zero speed (no dead zone at t=0) AND
  // keeps accelerating. Linear + quadratic mix — derivative goes
  // 0.4 -> 1.6 across the duration. Use when an "easeIn" feels like
  // it's standing still at the start.
  easeInBoost: (t) => 0.4 * t + 0.6 * t * t,
  // easeInAccel: nearly linear at the start (so it doesn't feel stuck)
  // and noticeably faster at the end. Derivative goes 0.7 -> 1.3 — the
  // tightest "fast already + still accelerating" you can get under the
  // f(0)=0 / f(1)=1 normalization (any harder start needs overshoot,
  // see easeInBack).
  easeInAccel: (t) => 0.7 * t + 0.3 * t * t,
  // easeInBack: dips slightly backwards at the start then accelerates
  // hard. Use when you want the change to feel "already in motion"
  // before it really takes off (sling-shot acceleration).
  easeInBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return c3 * t * t * t - c1 * t * t;
  },
  // easeInExpo: very slow start then exponentially explodes — the
  // sharpest acceleration available without overshoot.
  easeInExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  // easeInBlast: 40% linear + 60% easeInExpo, normalised to [0,1].
  // Slope at t=0 is ~0.4 (no dead zone — already moving from the first
  // frame) and slope at t=1 is ~4.5 (steep exponential blast). Use when
  // you want "already in motion + still accelerates exponentially".
  // Kept as a registry primitive — currently no preset uses it (zoom_cut
  // picks easeInBoost for the gentler quadratic acceleration shape).
  easeInBlast: (t) =>
    0.4 * t + 0.6 * (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  // easeOutQuad: gentler deceleration than easeOut (cubic). Useful when
  // you want the tail to land softly without the cubic "stuck" feel.
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  // easeOutCirc: quarter-circle mirror of easeInCirc — derivative at
  // t=0 is infinite, so the move starts with a sudden burst then
  // decelerates fast. Strongest "shoot-out" entry.
  easeOutCirc: (t) => Math.sqrt(Math.max(0, 1 - (t - 1) * (t - 1))),
  easeInOut: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  // step: 보간 없이 도착 프레임에만 점프(hard cut). 글자 사라짐을 fade 가
  // 아니라 딱 끊기게 할 때 opacity keyframe 에 쓴다. t=1 에서만 1, 그 전엔 0.
  // bounceOut: 공이 떨어져 여러 번 튀는 곡선(표준 Penner bounce). 4단
  // 감쇠 진동으로 t=1 에 안착. easeOutBack(1회 오버슈트)과 달리 "통통통"
  // 여러 번 튄다. scale/move layer 에 걸면 "통통 떨어지는" 바운드.
  bounceOut: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
  // springOut: 부드러운 damped spring(감쇠 사인). overshoot 후 말랑하게
  // 몇 번 흔들려 안착한다. bounceOut(땅에 막혀 딱딱하게 튀는 공튀김)과 달리
  // "탄성 있는" 바운스 — 실측 Bounce 계열 느낌. zeta(감쇠비) 0.35, omega 9.
  // 더 통통 = zeta 낮추고, 더 차분 = zeta 높인다.
  springOut: (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const zeta = 0.35;
    const omega = 13;
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    return (
      1 -
      Math.exp(-zeta * omega * t) *
        (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t))
    );
  },
  step: (t) => (t >= 1 ? 1 : 0),
};

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// 커스텀 cubic-bezier 이징 ("cubic(x1,y1,x2,y2)" 문자열).
// 에디터가 named 프리셋 밖의 곡선을 spec 에 쓸 수 있게 하는 확장.
// 알고리즘은 gre/bezier-easing v2.1.0(= WebKit/Blink UnitBezier)과 동일:
// x(t) 샘플 테이블 11개 사전계산 -> Newton-Raphson 4회 -> 기울기가 거의 0인
// 평탄 구간에서는 이분탐색으로 폴백. 외부 의존성 없음.
// ---------------------------------------------------------------------------

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 10;
const SPLINE_TABLE_SIZE = 11;
const SAMPLE_STEP_SIZE = 1 / (SPLINE_TABLE_SIZE - 1);

// Horner 형태 다항식 계수 (x 축이면 a1=x1, a2=x2 / y 축이면 y1, y2)
const bezA = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
const bezB = (a1: number, a2: number) => 3 * a2 - 6 * a1;
const bezC = (a1: number) => 3 * a1;
const calcBezier = (t: number, a1: number, a2: number) =>
  ((bezA(a1, a2) * t + bezB(a1, a2)) * t + bezC(a1)) * t;
const getSlope = (t: number, a1: number, a2: number) =>
  3 * bezA(a1, a2) * t * t + 2 * bezB(a1, a2) * t + bezC(a1);

/**
 * CSS cubic-bezier(x1,y1,x2,y2) 와 동일한 (t)=>progress 함수를 만든다.
 * x1/x2 는 x(t) 가 단사여야 하므로 [0,1] 로 클램프. y1/y2 는 자유
 * (범위 밖 = overshoot/anticipation).
 */
export function bezierEasing(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const cx1 = clamp01(x1);
  const cx2 = clamp01(x2);
  // 직선이면 항등 함수 (EASING.linear 와 같은 동작)
  if (cx1 === y1 && cx2 === y2) return EASING.linear;

  // x(t) 샘플 테이블 사전계산 — getTForX 의 초기 추정에 쓴다.
  const samples = new Float32Array(SPLINE_TABLE_SIZE);
  for (let i = 0; i < SPLINE_TABLE_SIZE; i++) {
    samples[i] = calcBezier(i * SAMPLE_STEP_SIZE, cx1, cx2);
  }

  const getTForX = (x: number): number => {
    // 1) 테이블에서 x 를 감싸는 구간을 찾아 선형보간으로 초기 t 추정
    let intervalStart = 0;
    let currentSample = 1;
    const lastSample = SPLINE_TABLE_SIZE - 1;
    for (
      ;
      currentSample !== lastSample && samples[currentSample] <= x;
      currentSample++
    ) {
      intervalStart += SAMPLE_STEP_SIZE;
    }
    currentSample--;
    const dist =
      (x - samples[currentSample]) /
      (samples[currentSample + 1] - samples[currentSample]);
    const guessForT = intervalStart + dist * SAMPLE_STEP_SIZE;

    // 2) 기울기가 충분하면 Newton-Raphson 4회 고정 반복
    const initialSlope = getSlope(guessForT, cx1, cx2);
    if (initialSlope >= NEWTON_MIN_SLOPE) {
      let t = guessForT;
      for (let i = 0; i < NEWTON_ITERATIONS; i++) {
        const slope = getSlope(t, cx1, cx2);
        if (slope === 0) return t;
        t -= (calcBezier(t, cx1, cx2) - x) / slope;
      }
      return t;
    }
    if (initialSlope === 0) return guessForT;

    // 3) 평탄 구간(Newton 발산) — 구간 내 이분탐색 폴백
    let lo = intervalStart;
    let hi = intervalStart + SAMPLE_STEP_SIZE;
    let t = guessForT;
    let err = 0;
    let i = 0;
    do {
      t = lo + (hi - lo) / 2;
      err = calcBezier(t, cx1, cx2) - x;
      if (err > 0) hi = t;
      else lo = t;
    } while (Math.abs(err) > SUBDIVISION_PRECISION && ++i < SUBDIVISION_MAX_ITERATIONS);
    return t;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return calcBezier(getTForX(t), y1, y2);
  };
}

// "cubic(a,b,c,d)" 정확한 형태만 허용. 숫자는 음수/소수 가능, 공백 관대.
const CUBIC_RE =
  /^\s*cubic\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\)\s*$/;

/** "cubic(0.16,1,0.3,1)" -> [0.16, 1, 0.3, 1]. 형태가 아니면 null. */
export function parseCubic(
  s: string,
): [number, number, number, number] | null {
  const m = CUBIC_RE.exec(s);
  if (!m) return null;
  const nums = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3]];
}

// 파싱된 cubic 함수 메모이즈 — 같은 문자열이면 같은 fn 재사용 (프레임마다
// 샘플 테이블을 다시 만들지 않는다).
const CUBIC_CACHE = new Map<string, (t: number) => number>();

/**
 * 이징 이름 -> 함수 해석. 우선순위:
 *   1) EASING named 프리셋 (기존과 동일한 fn 객체 반환 — 비트 동일 보장)
 *   2) "cubic(a,b,c,d)" 커스텀 베지어 (메모이즈)
 *   3) fallback 프리셋
 * 에디터의 커스텀 cubic() 지원을 위해 atom 들의 EASING[...] 직접 조회를
 * 전부 이 함수로 대체한다.
 */
export function resolveEasing(
  name: string | undefined,
  fallback: EasingName = "easeOut",
): (t: number) => number {
  if (!name) return EASING[fallback];
  const named = (EASING as Record<string, ((t: number) => number) | undefined>)[
    name
  ];
  if (named) return named;
  const cached = CUBIC_CACHE.get(name);
  if (cached) return cached;
  const parsed = parseCubic(name);
  if (parsed) {
    const fn = bezierEasing(parsed[0], parsed[1], parsed[2], parsed[3]);
    CUBIC_CACHE.set(name, fn);
    return fn;
  }
  return EASING[fallback];
}

// easing 파라미터 타입을 string 으로 넓힘 — named 프리셋 외에 에디터가 쓰는
// "cubic(...)" 커스텀 문자열도 받는다. named 는 기존과 완전히 동일하게 동작.
export function ease(
  localFrame: number,
  duration: number,
  easing?: string,
): number {
  const fn = resolveEasing(easing, "easeOut");
  return fn(clamp01(localFrame / Math.max(1, duration)));
}
