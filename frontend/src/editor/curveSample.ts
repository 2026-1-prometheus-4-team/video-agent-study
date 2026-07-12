// curveSample.ts
// 이징 값(named 또는 "cubic(...)")을 실제 엔진 함수로 해석해 SVG 곡선 좌표로
// 샘플링한다. EasingChip 과 EasingEditorModal 이 공유 — 에디터가 보여주는 곡선이
// 엔진이 실제로 쓰는 곡선과 동일하도록 반드시 엔진 resolveEasing 을 쓴다.

import { resolveEasing, EASING, bezierEasing, type EasingName } from "@engine/motion/core/easing";

export { resolveEasing, EASING, bezierEasing };
export type { EasingName };

/**
 * 임의 이징 함수를 cubic-bezier 4-tuple 로 근사(coordinate descent). named 이징을
 * 클릭하면 커스텀 에디터에 그 곡선을 로드하기 위한 것. bounce/spring 처럼 베지어로
 * 표현 불가한 건 최선 근사(단조 곡선은 시각적으로 거의 일치).
 */
export function fitBezier(fn: (t: number) => number): [number, number, number, number] {
  const N = 24;
  const targets: number[] = [];
  for (let i = 0; i <= N; i++) targets.push(fn(i / N));
  const err = (p: [number, number, number, number]): number => {
    const b = bezierEasing(p[0], p[1], p[2], p[3]);
    let e = 0;
    for (let i = 0; i <= N; i++) {
      const d = b(i / N) - targets[i];
      e += d * d;
    }
    return e;
  };
  let best: [number, number, number, number] = [0.33, 0.33, 0.67, 0.67];
  let bestE = err(best);
  let step = 0.25;
  for (let iter = 0; iter < 60; iter++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      for (const dir of [1, -1]) {
        const cand = [...best] as [number, number, number, number];
        cand[k] += dir * step;
        // x1,x2 는 [0,1] 로 clamp(엔진 규약), y 는 오버슈트 허용 [-1,2]
        if (k === 0 || k === 2) cand[k] = Math.max(0, Math.min(1, cand[k]));
        else cand[k] = Math.max(-1, Math.min(2, cand[k]));
        const e = err(cand);
        if (e < bestE) {
          bestE = e;
          best = cand;
          improved = true;
        }
      }
    }
    if (!improved) step *= 0.6;
    if (step < 0.002) break;
  }
  return best.map((v) => Number(v.toFixed(3))) as [number, number, number, number];
}

export const EASING_NAMES = Object.keys(EASING) as EasingName[];

/** 이징 함수를 n+1 점으로 샘플. [{x:0..1, y:f(x)}]. y 는 [0,1] 밖(overshoot)일 수 있음. */
export function sampleEasing(
  value: string | undefined,
  n = 48,
  fallback: EasingName = "easeOut",
): { x: number; y: number }[] {
  const fn = resolveEasing(value, fallback);
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push({ x, y: fn(x) });
  }
  return pts;
}

/** 샘플점들의 y 범위 (overshoot 표시용) */
export function yRange(pts: { x: number; y: number }[]): { min: number; max: number } {
  let min = 0;
  let max = 1;
  for (const p of pts) {
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  return { min, max };
}

/**
 * 샘플점을 SVG 폴리라인 path 로. 뷰박스 w×h, y 는 위로 갈수록 증가(뒤집기).
 * yMin/yMax 로 세로 스케일(overshoot 곡선은 범위를 넓혀 잘리지 않게).
 */
export function pointsToPath(
  pts: { x: number; y: number }[],
  w: number,
  h: number,
  pad: number,
  yMin: number,
  yMax: number,
): string {
  const span = yMax - yMin || 1;
  return pts
    .map((p, i) => {
      const px = pad + p.x * (w - 2 * pad);
      const py = h - pad - ((p.y - yMin) / span) * (h - 2 * pad);
      return `${i === 0 ? "M" : "L"}${px.toFixed(2)},${py.toFixed(2)}`;
    })
    .join(" ");
}

/** "cubic(a,b,c,d)" 이면 4-tuple, 아니면 null */
export function parseCubicValue(value: string | undefined): [number, number, number, number] | null {
  if (!value) return null;
  const m = value.match(/^cubic\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

export function isNamedEasing(value: string | undefined): value is EasingName {
  return !!value && value in EASING;
}
