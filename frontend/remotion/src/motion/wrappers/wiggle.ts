// wrappers/wiggle.ts
// AE wiggle 등가 — 요소를 위치/회전/스케일에서 유기적으로 미세하게 흔든다.
// 결정론: 시간의 순수 함수인 시드 value-noise(정수 스텝 해시 + smoothstep 보간)
// 라 Math.random 없이 매 프레임 같은 값. 요소마다 seed 를 달리하면 "비슷하지만
// 다 다른" 무빙(AE 의 seedRandom(index) + wiggle 워크플로우와 동일한 결과).
// role 은 hold — 등장/퇴장 사이 전 구간에 얹힌다.

import type { WrapperFn } from "./index";

export type WiggleProps = {
  /** 초당 흔들림 횟수. 기본 2. */
  freq?: number;
  /** 위치 진폭 — 컨테이너 비율(0.02 = 화면의 2%). 기본 0.015. */
  posAmp?: number;
  /** 회전 진폭(deg). 기본 0. */
  rotAmp?: number;
  /** 스케일 진폭(±비율, 0.05 = ±5%). 기본 0. */
  scaleAmp?: number;
  /** 요소별 시드 — 같은 애니에 요소마다 다른 흔들림. 기본 1. */
  seed?: number;
};

// 정수 격자 해시 → [0,1) (결정론). sin 방식은 GPU/CPU 편차가 있어 정수 비트 해시.
function hash1(i: number, seed: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 부드러운 1D value noise: 정수 스텝 사이를 smoothstep 보간 → [-1,1]
function vnoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash1(i, seed);
  const b = hash1(i + 1, seed);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

export const wiggle: WrapperFn = (f, rawProps, ctx, _role, _window) => {
  const p = rawProps as WiggleProps;
  const t = (f / ctx.fps) * (p.freq ?? 2);
  const seed = p.seed ?? 1;
  const posAmp = p.posAmp ?? 0.015;
  const rotAmp = p.rotAmp ?? 0;
  const scaleAmp = p.scaleAmp ?? 0;
  // 채널마다 다른 시드 오프셋 → x/y/rot/scale 이 독립적으로 흔들림
  return {
    x: vnoise(t, seed * 101 + 1) * posAmp * ctx.width,
    y: vnoise(t, seed * 101 + 2) * posAmp * ctx.height,
    rotate: rotAmp !== 0 ? vnoise(t, seed * 101 + 3) * rotAmp : 0,
    scale: scaleAmp !== 0 ? 1 + vnoise(t, seed * 101 + 4) * scaleAmp : 1,
  };
};

export function intrinsicDuration(): number {
  return 1; // 지속 효과 — 전 구간(hold window) 채운다
}

export const name = "wiggle";
export const fn = wiggle;
export const labPreset = {
  role: "hold" as const,
  props: { freq: 2, posAmp: 0.015 } as Record<string, unknown>,
};
