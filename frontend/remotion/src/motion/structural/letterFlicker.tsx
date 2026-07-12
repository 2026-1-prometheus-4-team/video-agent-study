// structural/letterFlicker.tsx
// "Flicker Words" reveal — 각 글자가 랜덤하게 깜빡(off / dim / full)이며 켜지고,
// 시간이 갈수록 켜진(안착) 글자 비율이 늘어 revealFrames 에 전부 100% 안착한다.
//
// 설계 핵심 (요구사항 그대로):
//  - 깜빡임이 한 곳에 뭉치지 않고 "여기저기" 흩어진다. 글자마다 독립 seeded
//    hash 로 lit 여부를 정해(공간 흩어짐) 좌->우 순차가 아니고, 글자마다 flicker
//    phase 를 달리 줘서 같은 프레임에 동시에 안 바뀐다(시간 흩어짐).
//  - 초반엔 대부분 안 보이고 몇몇만 깜빡, 그중 한두 개는 dim(반투명).
//  - 마지막으로 갈수록 lit 확률이 오르고 안착 글자가 늘어 안 보이는 글자가 준다.
//  - 각 글자의 "안착 시각(계속 켜짐)"은 공간적으로 흩어진 순서로, 겹치지 않게
//    한 글자씩 stagger 되어 마지막 글자가 revealFrames 에 안착한다. 그래서 끝이
//    한꺼번에 팍 완성되지 않고, 1~2 글자만 남아 깜빡이다 flicker beat 에 맞춰
//    한 글자씩 딱딱 켜지며 단어가 완성된 뒤 opacity 1 로 hold.
//
// 타이밍 주의: Lab 스튜디오는 모든 스펙 컴포를 24fps 로 돌린다(Root FPS=24,
// 스펙의 fps 필드 무시). 프레임 단위 값이라 revealFrames 는 반드시 씬 프레임
// (= scene.duration x 24)보다 작아야 단어 완성 후 hold 가 생긴다. flickerHold
// 1 = 매 프레임 깜빡(24Hz, 최대 속도).

import React from "react";
import { clamp, clamp01, lerp } from "../core/easing";
import { seededRandom } from "../core/random";
import type { Letter } from "./splitText";

export type LetterFlickerProps = {
  unit?: "char";
  seed?: number;
  // 전부 안착(100%)되는 로컬프레임. 이후는 opacity 1 hold.
  revealFrames?: number;
  // 깜빡 한 틱이 유지되는 프레임 수(작을수록 빠르게 깜빡).
  flickerHold?: number;
  // lit 확률: 초반(litProbStart) -> 끝(litProbEnd) 으로 상승.
  litProbStart?: number;
  litProbEnd?: number;
  // lit 일 때 dim(반투명)으로 뜰 확률과 그 opacity.
  partialChance?: number;
  partialOpacity?: number;
  // 안착(계속 켜짐)이 시작되는 지점(revealFrames 대비 0..1). 이 전에는 전부
  // 깜빡이기만 하고, 이후 revealFrames 까지 한 글자씩 stagger 되어 켜진다.
  settleStartFrac?: number;
};

// (letter, tick) -> 0..1 독립 난수. 모든 난수는 seededRandom(mulberry32) 경유.
// Math.imul 로 32bit 곱을 섞어 인접 (i, tick) 가 상관되지 않게 한다.
function flickerRand(i: number, tick: number, seed: number): number {
  const s =
    (Math.imul(i + 1, 2654435761) ^ Math.imul(tick + 1, 40503) ^ seed) >>> 0;
  return seededRandom(s)();
}

// 글자별 distinct 안착 랭크(0..N-1). seeded key 로 정렬한 순위라 좌->우 순서가
// 아니라 흩어진 순서로, 두 글자가 같은 순위가 안 되게(한 글자씩) 안착시킨다.
function settleRank(i: number, N: number, seed: number): number {
  const key = flickerRand(i, 0, seed ^ 0x51ed270b);
  let rank = 0;
  for (let j = 0; j < N; j++) {
    if (j === i) continue;
    const kj = flickerRand(j, 0, seed ^ 0x51ed270b);
    if (kj < key || (kj === key && j < i)) rank++;
  }
  return rank;
}

// 한 글자의 이 프레임 opacity. 공백은 스타일 없음(빈칸).
export function letterFlickerStyle(
  l: Letter,
  totalChars: number,
  localFrame: number,
  p: LetterFlickerProps,
): React.CSSProperties {
  if (l.isSpace) return {};
  const seed = p.seed ?? 7;
  const revealFrames = clamp(p.revealFrames ?? 42, 6, 600);
  const flickerHold = clamp(p.flickerHold ?? 2, 1, 20);
  const litStart = clamp01(p.litProbStart ?? 0.15);
  const litEnd = clamp01(p.litProbEnd ?? 0.92);
  const partialChance = clamp01(p.partialChance ?? 0.35);
  const partialOpacity = clamp01(p.partialOpacity ?? 0.4);
  const settleStartFrac = clamp01(p.settleStartFrac ?? 0.3);
  const i = l.charIdx;
  const N = Math.max(1, totalChars);

  // 안착 시각: 흩어진 랭크 순서로 settleStart..revealFrames 를 한 글자씩 균등
  // stagger. 마지막 랭크가 정확히 revealFrames 에 안착 -> 끝에서 한꺼번에 완성
  // 되지 않고 한 글자씩 켜진다. flicker tick 격자에 스냅해 깜빡 beat 에 맞춘다.
  const rank = settleRank(i, N, seed);
  const settleStart = revealFrames * settleStartFrac;
  const rf = N <= 1 ? 1 : rank / (N - 1);
  let lockT = lerp(settleStart, revealFrames, rf);
  lockT = Math.round(lockT / flickerHold) * flickerHold;
  if (localFrame >= lockT) return { opacity: 1 };

  // 글자마다 flicker phase 를 달리 줘 틱 경계가 안 겹치게(시간 흩어짐 -> 전체가
  // 같은 프레임에 lockstep 으로 안 바뀜).
  const phase = Math.floor(flickerRand(i, 0xa5a5, seed) * flickerHold);
  const tick = Math.floor((localFrame + phase) / flickerHold);

  // lit 확률: 전역 진행 g 와 이 글자의 안착 근접도 중 큰 값으로 상승.
  const g = clamp01(localFrame / revealFrames);
  const own = clamp01(localFrame / Math.max(1, lockT));
  const litProb = lerp(litStart, litEnd, Math.max(g, own));

  const r = flickerRand(i, tick, seed);
  if (r < litProb) {
    // lit: full 또는 dim(반투명) 을 두 번째 hash 로 결정.
    const r2 = flickerRand(i, tick, seed + 99991);
    return { opacity: r2 < partialChance ? partialOpacity : 1 };
  }
  return { opacity: 0 };
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as LetterFlickerProps & { duration?: number };
  if (typeof p.duration === "number") return Math.max(1, p.duration);
  return clamp(p.revealFrames ?? 42, 6, 600);
}

export const name = "letter_flicker";
export const labPreset = {
  role: "in" as const,
  props: {
    unit: "char",
    seed: 7,
    revealFrames: 42,
    flickerHold: 2,
    litProbStart: 0.15,
    litProbEnd: 0.92,
    partialChance: 0.35,
    partialOpacity: 0.4,
    settleStartFrac: 0.3,
  } as Record<string, unknown>,
};
