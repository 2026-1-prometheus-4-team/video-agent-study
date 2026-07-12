// wrappers/flip.ts
// 3D Y축 플립(rotateY). 단어가 측면에서 회전해 정면으로 오거나, 정면에서
// 뒤집힌다. perspective 는 channelsToCss 가 rotateY != 0 일 때 자동 적용하므로
// 90도 부근에서 원근 압축(가로 폭이 0으로 수렴)이 브라우저 렌더로 자연히 생긴다.
//
// 측정 근거 (akhilfilms "Rotation Words"): 단어 전체가 rotateY 로 3D 플립,
// ease-in-out, 90도에서 원근 압축 후 정면 복귀. 별도 scaleX 수동 압축 불필요
// (perspective 가 처리). rotateY 채널을 반환하면 composeChannels 가 합산.

import { ease, lerp, type EasingName } from "../core/easing";
import type { WrapperFn } from "./index";

export type FlipProps = {
  // 시작 각도(deg). default -90 (측면 -> 정면). 180/360 을 주면 미러 통과 플립.
  fromDeg?: number;
  // 끝 각도(deg). default 0 (정면 안착).
  toDeg?: number;
  duration?: number;
  easing?: EasingName;
};

export const flip: WrapperFn = (f, rawProps, _ctx, _role, window) => {
  const p = rawProps as FlipProps;
  const t = ease(f, p.duration ?? window, p.easing ?? "easeInOut");
  return { rotateY: lerp(p.fromDeg ?? -90, p.toDeg ?? 0, t) };
};

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as FlipProps;
  return Math.max(1, p.duration ?? 16);
}

export const name = "flip";
export const fn = flip;
export const labPreset = {
  role: "in" as const,
  props: { fromDeg: -90, toDeg: 0, duration: 16, easing: "easeInOut" } as Record<string, unknown>,
};
