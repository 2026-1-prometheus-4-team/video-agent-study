// wrappers/shake.ts
// 등장 시 미세 떨림(micro-tremor) 효과. 사인/코사인 x/y 진동을 decay
// 엔벨로프에 태워 글자가 나타나는 순간 흔들리다 안착하게 한다.
//
// Props:
//   amplitude : px 진폭, default 5
//   frequency : 초당 진동 횟수(Hz), default 8
//   decay     : 진폭이 0까지 감쇠하는 프레임 수, default 14 (0 = 감쇠 없음)
//   seed      : x/y 위상 오프셋, default 2.3

import type { WrapperFn } from "./index";

export type ShakeProps = {
  amplitude?: number; // Max px, default 5
  frequency?: number; // Hz, default 8
  decay?: number;     // frames, default 14
  seed?: number;
};

export const shake: WrapperFn = (localFrame, rawProps, ctx, _role, _window) => {
  const p = rawProps as ShakeProps;
  const amp = p.amplitude ?? 5;
  const freq = p.frequency ?? 8;
  const decay = p.decay ?? 14;
  const seed = p.seed ?? 2.3;

  // Exponential decay envelope: 1 → 0 over `decay` frames
  const envelope = decay > 0 ? Math.exp(-localFrame / (decay * 0.4)) : 1;

  // Angular frequency in radians per frame
  const w = (2 * Math.PI * freq) / ctx.fps;

  const px = amp * envelope * Math.sin(w * localFrame + seed);
  const py = amp * envelope * Math.cos(w * localFrame + seed * 1.6);

  return { x: px, y: py };
};

export const name = "shake";
export const fn = shake;
export const labPreset = {
  role: "in" as const,
  props: {
    amplitude: 5,
    frequency: 8,
    decay: 14,
  } as Record<string, unknown>,
};
