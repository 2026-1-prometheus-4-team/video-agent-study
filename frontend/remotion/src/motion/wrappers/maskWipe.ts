// wrappers/maskWipe.ts
// 소프트 그라디언트 마스크 스윕 — 요소를 왼->오(기본)로 쓸며 드러낸다.
// AE 등가: Linear Wipe(고 feather) 또는 그라디언트 램프 트랙 매트 이동.
// masked_reveal 컴파운드가 move 와 함께 써서 "가려진 fade 가 빠지며 단어가
// 미끄러져 들어오는" 히어로 타이틀 리빌을 만든다 (레퍼런스 실측).

import { clamp, ease, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type MaskWipeProps = {
  duration?: number;
  /** 부드러운 경계 폭 (요소 폭 대비 0..1). 기본 0.35. */
  feather?: number;
  easing?: EasingName;
  /** 스윕 방향. 기본 ltr (왼->오 리빌). */
  direction?: "ltr" | "rtl";
};

export const maskWipe: WrapperFn = (f, rawProps, _ctx, role, window) => {
  const p = rawProps as MaskWipeProps;
  const t = ease(f, p.duration ?? window, p.easing ?? "easeOut");
  // out 이면 역방향 (보임 -> 가림)
  const progress = role === "out" ? 1 - t : t;
  return {
    maskProgress: clamp(progress, 0, 1),
    maskFeather: p.feather ?? 0.35,
    maskDir: p.direction === "rtl" ? -1 : 1,
  };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as MaskWipeProps;
  return Math.max(1, p.duration ?? 22);
}

export const name = "mask_wipe";
export const fn = maskWipe;
export const labPreset = { role: "in" as const, props: { duration: 22, feather: 0.35 } };
