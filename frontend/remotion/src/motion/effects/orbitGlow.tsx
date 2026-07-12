// orbitGlow — 라운드 사각 둘레를 도는 "스침광(grazing light)" 공용 헬퍼.
// neon_pill / glow_card / glow_menu 가 공유한다.
//
// 레퍼런스(AI 인풋박스류)는 균일 폭 네온 대시가 아니라, 실제 림 라이트처럼
//   - 하이라이트 중심은 굵고 밝게(흰기 도는 코어) + 큰 halo 가 번지고
//   - 양끝으로 갈수록 폭이 0 으로 수렴하며 뾰족하고 얇게 사그라든다.
// 구현: 둘레를 파라미터화해 하이라이트 구간을 ~90개 쿼드 띠로 그린다.
// 쿼드는 이웃과 정점을 공유해 이음매가 없고, 폭/투명도/색이 u(-1..1)의
// 연속 프로파일을 따른다. 대시 방식(끊긴 세그먼트 4겹)의 단절 문제를
// 이걸로 대체했다.
//
// conic-gradient 가 아니라 경로 파라미터화를 쓰는 이유: 경로 길이 기준이라
// 알약/카드처럼 길쭉한 rect 에서도 균일 속도로 돌고, 코너에서 왜곡이 없다.

import React from "react";
import { EASING, clamp01, lerp, type EasingName } from "../core/easing";

export type OrbitSpec = {
  period?: number; // 한 바퀴 프레임. 기본 96
  span?: number; // 밝은 구간 길이(경로 비율 0..1). 기본 0.38
  colors?: [string, string]; // [중심(밝음), 양끝(어두움)]. 기본 fallback
  dim?: string; // 나머지 테두리 색. 기본 rgba(124,92,246,0.16)
  bloom?: number; // halo/블룸 배율. 기본 1
  reverse?: boolean; // 반시계 방향
  phase?: number; // 시작 위치(경로 비율 0..1, 왼쪽 위에서 시계방향). 기본 0
  // 바퀴 내 이징 — 지정하면 한 바퀴 진행도에 이 커브를 걸어 속도가
  // 빨라졌다 느려진다 (예: easeInOut). 바퀴 경계에서 위치는 연속이고
  // 속도만 주기적으로 변한다. 미지정이면 등속.
  easing?: EasingName;
};

// 글로우 스트로크용 drop-shadow 2겹. intensity 0 이면 없음.
export function glowFilter(color: string, intensity: number): string | undefined {
  if (intensity <= 0) return undefined;
  const a = (8 * intensity).toFixed(1);
  const b = (26 * intensity).toFixed(1);
  return `drop-shadow(0 0 ${a}px ${color}) drop-shadow(0 0 ${b}px ${color})`;
}

// ---- 색 헬퍼 (hex 전용 — orbit 색은 spec 에서 hex 로 들어온다) ----
function hexRgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return [200, 160, 255];
  const p = parseInt(hex.slice(1), 16);
  return [(p >> 16) & 255, (p >> 8) & 255, p & 255];
}
function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function rgbStr(c: [number, number, number]): string {
  return `rgb(${c.map((v) => Math.round(v)).join(",")})`;
}

// ---- 라운드 사각 둘레 파라미터화 ----
// s(0..1) -> 점 + 바깥 법선. 경로는 SVG rect 와 동일: 왼쪽 위 코너 끝
// (x+r, y) 에서 시작해 시계방향.
type PathFn = { at: (s: number) => { px: number; py: number; nx: number; ny: number }; total: number };

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): PathFn {
  const rr = Math.max(0.01, Math.min(r, Math.min(w, h) / 2));
  const lt = Math.max(0, w - 2 * rr); // 가로 직선
  const lr = Math.max(0, h - 2 * rr); // 세로 직선
  const lc = (Math.PI * rr) / 2; // 코너 호
  const total = 2 * lt + 2 * lr + 4 * lc;
  // 누적 길이 테이블: [top, TR, right, BR, bottom, BL, left, TL]
  const segs = [lt, lc, lr, lc, lt, lc, lr, lc];
  const acc: number[] = [];
  let sum = 0;
  for (const l of segs) {
    acc.push(sum);
    sum += l;
  }
  const at = (sIn: number) => {
    const s = ((sIn % 1) + 1) % 1;
    let d = s * total;
    let i = segs.length - 1;
    for (let k = 0; k < segs.length; k++) {
      if (d < acc[k] + segs[k] || k === segs.length - 1) {
        i = k;
        break;
      }
    }
    d -= acc[i];
    const corner = (cx: number, cy: number, a0: number) => {
      const a = a0 + (d / lc) * (Math.PI / 2);
      return { px: cx + rr * Math.cos(a), py: cy + rr * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) };
    };
    switch (i) {
      case 0: // top: 좌->우
        return { px: x + rr + d, py: y, nx: 0, ny: -1 };
      case 1: // TR 코너: -90° -> 0°
        return corner(x + w - rr, y + rr, -Math.PI / 2);
      case 2: // right: 상->하
        return { px: x + w, py: y + rr + d, nx: 1, ny: 0 };
      case 3: // BR 코너: 0° -> 90°
        return corner(x + w - rr, y + h - rr, 0);
      case 4: // bottom: 우->좌
        return { px: x + w - rr - d, py: y + h, nx: 0, ny: 1 };
      case 5: // BL 코너: 90° -> 180°
        return corner(x + rr, y + h - rr, Math.PI / 2);
      case 6: // left: 하->상
        return { px: x, py: y + h - rr - d, nx: -1, ny: 0 };
      default: // TL 코너: 180° -> 270°
        return corner(x + rr, y + rr, Math.PI);
    }
  };
  return { at, total };
}

/** 궤도 스침광 — 시간(frame/period/easing)으로 하이라이트 위치 p 를 계산해
 *  grazingLight 로 렌더. preset(neon_pill/glow_card) 용. */
export function orbitArcRects(args: {
  orb: OrbitSpec;
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number; // 코너 반경(px)
  bw: number; // 하이라이트 최대 두께(px)
  glow: number; // halo 강도 배율 (glowPulse 등)
  opacity?: number; // 전체 배율(등장 램프 등). 기본 1
  fallback: [string, string]; // colors 미지정 시 [중심, 양끝]
}): React.ReactNode {
  const { orb, frame } = args;
  const period = Math.max(1, orb.period ?? 96);
  const dir = orb.reverse ? -1 : 1;
  const fract = (v: number) => ((v % 1) + 1) % 1;
  // 바퀴 진행도: 등속(laps) 또는 바퀴 내 이징(정수 바퀴 + 커브 소수부)
  const laps = frame / period;
  const eased = orb.easing ? Math.floor(laps) + EASING[orb.easing](fract(laps)) : laps;
  const p = fract((orb.phase ?? 0) + dir * eased); // 하이라이트 중심
  return grazingLight({
    p,
    span: orb.span,
    colors: orb.colors ?? args.fallback,
    bloom: orb.bloom,
    x: args.x,
    y: args.y,
    w: args.w,
    h: args.h,
    r: args.r,
    bw: args.bw,
    glow: args.glow,
    opacity: args.opacity,
  });
}

/** 스침광 렌더 (위치 p 직접 지정) — 반드시 overflow visible 인 <svg> 안에서.
 *  하이라이트 중심(p, 경로 비율 0..1)에 [halo / bloom 띠 / 본체 띠 / 코어 띠].
 *  edge_light 요소는 p 를 progress 키프레임에서 직접 받는다. */
export function grazingLight(args: {
  p: number; // 하이라이트 중심 (경로 비율, 정수부는 랩 수 — fract 적용)
  span?: number; // 밝은 구간 길이. 기본 0.38
  colors: [string, string]; // [중심, 양끝]
  bloom?: number; // 기본 1
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
  bw: number;
  glow: number;
  opacity?: number;
}): React.ReactNode {
  const { x, y, w, h, r, bw } = args;
  const mul = (args.opacity ?? 1) * Math.min(1, Math.max(0, args.glow) + 0.25);
  if (mul <= 0.001) return null;
  const span = Math.min(0.92, Math.max(0.04, args.span ?? 0.38));
  const fract = (v: number) => ((v % 1) + 1) % 1;
  const p = fract(args.p);
  const bloom = args.bloom ?? 1;

  const cCore = hexRgb(args.colors[0]);
  const cEdge = hexRgb(args.colors[1]);
  const white: [number, number, number] = [255, 252, 255];
  const warm: [number, number, number] = [255, 168, 130]; // 뾰족한 끝의 미세 웜 틴트

  const path = roundedRectPath(x, y, w, h, r);
  const N = 90; // 쿼드 수 — 코너에서도 매끈할 만큼
  // 샘플: u(-1..1) -> 위치/폭/알파/색. 이웃 쿼드가 정점을 공유해 이음매 없음.
  const samples = Array.from({ length: N + 1 }, (_, i) => {
    const u = (i / N) * 2 - 1;
    const s = p + (u * span) / 2;
    const pt = path.at(s);
    const half = (bw / 2) * Math.pow(Math.max(0, 1 - u * u), 1.4); // 끝이 뾰족한 테이퍼
    const alpha = Math.pow(1 - Math.abs(u), 1.5);
    let col = mixRgb(cEdge, cCore, Math.pow(1 - Math.abs(u), 2));
    col = mixRgb(col, white, 0.6 * Math.pow(1 - Math.abs(u), 5)); // 중심 흰기
    col = mixRgb(col, warm, 0.35 * clamp01((Math.abs(u) - 0.78) / 0.22)); // 끝 웜 틴트
    return { ...pt, half, alpha, col, u };
  });

  const strip = (widthMul: number, alphaMul: number) =>
    samples.slice(0, -1).map((a, i) => {
      const b = samples[i + 1];
      const pts = [
        `${(a.px + a.nx * a.half * widthMul).toFixed(2)},${(a.py + a.ny * a.half * widthMul).toFixed(2)}`,
        `${(b.px + b.nx * b.half * widthMul).toFixed(2)},${(b.py + b.ny * b.half * widthMul).toFixed(2)}`,
        `${(b.px - b.nx * b.half * widthMul).toFixed(2)},${(b.py - b.ny * b.half * widthMul).toFixed(2)}`,
        `${(a.px - a.nx * a.half * widthMul).toFixed(2)},${(a.py - a.ny * a.half * widthMul).toFixed(2)}`,
      ].join(" ");
      const mid = (a.alpha + b.alpha) / 2;
      return <polygon key={i} points={pts} fill={rgbStr(a.col)} opacity={mid * alphaMul * mul} />;
    });

  // halo — 하이라이트 중심에서 바깥으로 크게 번지는 광원 (레퍼런스의 큰 보라 광)
  const hot = path.at(p);
  const arcPx = span * path.total;
  const haloR = Math.max(bw * 8, arcPx * 0.42);
  const gid = `og-${Math.round(x + y + w + h)}-${Math.round(hot.px)}-${Math.round(hot.py)}`;
  return (
    <>
      <defs>
        <radialGradient id={gid}>
          <stop offset="0%" stopColor={rgbStr(mixRgb(cCore, white, 0.25))} stopOpacity={0.34 * bloom * mul} />
          <stop offset="45%" stopColor={rgbStr(cCore)} stopOpacity={0.16 * bloom * mul} />
          <stop offset="100%" stopColor={rgbStr(cEdge)} stopOpacity={0} />
        </radialGradient>
      </defs>
      <circle cx={hot.px + hot.nx * bw} cy={hot.py + hot.ny * bw} r={haloR} fill={`url(#${gid})`} />
      {/* 넓은 블룸 띠 -> 본체 -> 얇고 밝은 코어 (모두 연속 테이퍼) */}
      <g style={{ filter: `blur(${(bw * 2.4).toFixed(1)}px)` }}>{strip(5.2, 0.5 * bloom)}</g>
      <g style={{ filter: `blur(${(bw * 0.65).toFixed(1)}px)` }}>{strip(2.0, 0.85)}</g>
      <g style={{ filter: `blur(${Math.max(0.4, bw * 0.1).toFixed(1)}px)` }}>{strip(0.9, 1)}</g>
    </>
  );
}
