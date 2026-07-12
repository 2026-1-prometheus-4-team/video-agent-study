// keyframes.ts — 요소(text/shape/logo) 속성 키프레임 애니메이션.
// 카메라 키프레임(sampleCameraKeyframes)과 동일한 모델:
//   키프레임 리스트에서 채널별 독립 보간 + "오른쪽 키"의 easing 으로 구간 이징.
// 한 키프레임이 정의하지 않은 채널은 그 채널 보간에서 제외돼(= AE 처럼 속성별
// 독립 트랙). 프레임은 씬-로컬(useCurrentFrame 과 동일 시계).
//
// AE 방식의 핵심: 속성마다 키프레임 트랙 → 키 사이 보간 → 구간마다 이징.
// scale 은 wrapper 채널에 곱하고(*=1 기본), rotate 는 더하고(+=0), opacity 는
// 곱한다(*=1). x/y 는 base.position 을 덮어쓰는 fraction(0..1).

import { lerp, resolveEasing } from "./core/easing";

export type ElementKeyframe = {
  /** 씬-로컬 프레임. */
  frame: number;
  /** 위치 fraction(0..1). base.position 를 덮어씀. */
  x?: number;
  y?: number;
  /** 스케일 배수(1 = 무변화). wrapper scale 채널에 곱해짐. */
  scale?: number;
  /** 회전(deg). wrapper rotate 채널에 더해짐. */
  rotate?: number;
  /** 불투명도 배수(0..1). */
  opacity?: number;
  /** 블러(px, 가산). wrapper blur 채널에 더해짐. */
  blur?: number;
  /** 크기(vw/vh %). base.width/height 를 덮어씀 — 칩 자동 확장 같은 크기 애니메이션용. */
  w?: number;
  h?: number;
  /** 경로 진행도(0..1) — group layout(type:"path") 전용 채널. AE 의 Path
   *  Progress 키프레임과 등가: 키 간격이 속도, 세그먼트 이징이 가감속. */
  progress?: number;
  /** 깊이 z (comp-width %, AE 관례: +z = 화면 안쪽/멀어짐). 3D 씬에서만 렌더에
   *  반영 — CSS 방출 시 부호 반전(css_z = -z). verify3d.mjs 로 관례 고정. */
  z?: number;
  /** 채널 루프 (AE loopOut 등가) — 채널의 "마지막 키"에 선언하면 그 채널이
   *  마지막 키 이후 무한 반복된다. cycle=처음부터 반복(동전 회전: 0->360),
   *  pingpong=왕복, continue=마지막 구간 기울기로 등속 외삽. */
  loop?: "cycle" | "pingpong" | "continue";
  /** 요소 3D 자세(deg, 절대값). base.rotateX/rotateY 를 덮어씀. */
  rotateX?: number;
  rotateY?: number;
  /** 색(hex) — base.color 를 덮어씀. 키 사이는 sRGB 보간. 텍스트가 소비. */
  color?: string;
  /** 이 키로 들어오는 구간의 이징(이름 또는 cubic(...)). 기본 easeInOut. */
  easing?: string;
};

// 요소 트림(클립 in/out) — 씬-로컬 프레임. 이 창 밖이면 요소를 숨기고, 안이면
// 요소 clock 을 start 만큼 시프트해 애니메이션이 그 지점부터 자연 속도로 재생된다.
// (전체 duration 압축 아님 = 비파괴 트림.) 기본: start=0, end=sceneFrames.
export type ElementTiming = { start?: number; end?: number };

export type SampledKeyframes = {
  x: number | null; // null = x 키프레임 없음 → base.position 사용
  y: number | null;
  scale: number; // 기본 1
  rotate: number; // 기본 0
  opacity: number; // 기본 1
  blur: number; // 기본 0 (px, 가산)
  w: number | null; // null = 키 없음 → base.width 사용 (vw %)
  h: number | null; // null = 키 없음 → base.height 사용 (vh %)
  progress: number | null; // null = 키 없음 → layout.progress(loop) 사용
  z: number | null; // null = 키 없음 → base.z 사용 (comp-width %, +z = 안쪽)
  rotateX: number | null; // null = 키 없음 → base.rotateX 사용 (deg, 절대)
  rotateY: number | null;
  color: string | null; // null = 키 없음 → base.color 사용 (보간 결과는 hex)
};

const IDENTITY: SampledKeyframes = { x: null, y: null, scale: 1, rotate: 0, opacity: 1, blur: 0, w: null, h: null, rotateX: null, rotateY: null, progress: null, z: null, color: null };

type Chan = "x" | "y" | "scale" | "rotate" | "opacity" | "blur" | "w" | "h" | "rotateX" | "rotateY" | "progress" | "z";

export function sampleElementKeyframes(
  keyframes: ElementKeyframe[] | undefined,
  frame: number,
): SampledKeyframes {
  if (!keyframes || keyframes.length === 0) return IDENTITY;
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);

  const channel = (key: Chan, dflt: number | null): number | null => {
    const pts = sorted.filter((k) => typeof k[key] === "number");
    if (pts.length === 0) return dflt;
    const first = pts[0];
    const last = pts[pts.length - 1];
    // 채널 루프 (AE loopOut) — 마지막 키의 loop 선언. 마지막 키 이후 프레임을
    // 키 구간 안으로 되접거나(cycle/pingpong) 등속 외삽(continue)한다.
    let f = frame;
    if (last.loop && pts.length >= 2 && f > last.frame) {
      const span = last.frame - first.frame;
      if (span > 0) {
        if (last.loop === "cycle") {
          f = first.frame + ((f - first.frame) % span);
        } else if (last.loop === "pingpong") {
          const m = ((f - first.frame) / span) % 2;
          f = first.frame + (m <= 1 ? m : 2 - m) * span;
        } else {
          // continue — 마지막 세그먼트 기울기 유지 (등속 무한. 회전 누적 등)
          const prev = pts[pts.length - 2];
          const v =
            ((last[key] as number) - (prev[key] as number)) /
            Math.max(1, last.frame - prev.frame);
          return (last[key] as number) + v * (f - last.frame);
        }
      }
    }
    if (f <= first.frame) return first[key] as number;
    if (f >= last.frame) return last[key] as number;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (f >= a.frame && f <= b.frame) {
        const span = Math.max(1, b.frame - a.frame);
        const t = resolveEasing(b.easing, "easeInOut")((f - a.frame) / span);
        return lerp(a[key] as number, b[key] as number, t);
      }
    }
    return dflt;
  };

  // color 채널 — 숫자 채널과 달리 hex 쌍을 sRGB 로 보간해 hex 로 반환
  const colorChannel = (): string | null => {
    const pts = sorted.filter((k) => typeof k.color === "string");
    if (pts.length === 0) return null;
    const hexRgb = (hx: string): [number, number, number] | null => {
      const m = /^#([0-9a-fA-F]{6})$/.exec(hx.trim());
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const toHex = (c: [number, number, number]) =>
      "#" + c.map((v) => ("0" + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2)).join("").toUpperCase();
    if (frame <= pts[0].frame) return pts[0].color as string;
    if (frame >= pts[pts.length - 1].frame) return pts[pts.length - 1].color as string;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const span = Math.max(1, b.frame - a.frame);
        const t = resolveEasing(b.easing, "easeInOut")((frame - a.frame) / span);
        const ca = hexRgb(a.color as string);
        const cb = hexRgb(b.color as string);
        if (!ca || !cb) return t < 0.5 ? (a.color as string) : (b.color as string); // hex 아님 — 스냅
        return toHex([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t)]);
      }
    }
    return null;
  };

  return {
    x: channel("x", null),
    y: channel("y", null),
    scale: channel("scale", 1) as number,
    rotate: channel("rotate", 0) as number,
    opacity: channel("opacity", 1) as number,
    blur: channel("blur", 0) as number,
    w: channel("w", null),
    h: channel("h", null),
    progress: channel("progress", null),
    z: channel("z", null),
    rotateX: channel("rotateX", null),
    rotateY: channel("rotateY", null),
    color: colorChannel(),
  };
}
