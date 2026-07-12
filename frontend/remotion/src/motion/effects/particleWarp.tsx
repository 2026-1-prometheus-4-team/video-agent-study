// motion/effects/particleWarp.tsx
// 방사형 파티클 워프 터널 (Canvas 2D). 중심(vanishing point)에서 streak/spark 가
// 방출되며 터널을 전진하는 느낌. biasafe 2막-A 측정 기반:
//   - nebula 벽: 보라/마젠타 radial blob 5개가 회전 drift (터널 벽 텍스처)
//   - streak: 청록, 중심에서 방사. 깊이 가속(t^1.6)으로 멀수록 빨라짐
//   - spark: 주황/노랑 짧은 막대, 방사
//   - core: 중심 흰+연보라 글로우
// 전부 frame 의 결정론적 함수(seeded) — 렌더마다 동일, sub-pixel 누적 없음.
//
// CSS div streak 로는 깊이 터널 + nebula 벽이 안 나와서 Canvas 로 다시 짰다.
// 측정 색(30fps 원본): streak #9DCDCD, nebula #7634CA~#C04ADE, spark #FF8A3D, core 흰+연보라.

import React, { useRef, useEffect } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { seededRandom } from "../core/random";

export type ParticleWarpSpec = {
  element: "particles";
  id?: string;
  variant?: "warp_tunnel";
  count?: number; // streak 수, default 90
  sparkCount?: number; // spark 수, default 14
  streakColor?: string; // 청록 streak
  sparkColor?: string; // 주황 spark
  coreColor?: string; // 중심 코어(흰 다음 색)
  nebula?: string[]; // 터널 벽 성운 색들
  speed?: number; // streak 수명(frame). 작을수록 빠름
  seed?: number;
  lineWidth?: number; // streak 기본 두께 배율, default 1
  frameOffset?: number; // 씬 간 연속성 유지용 프레임 오프셋
};

function drawTunnel(
  ctx: CanvasRenderingContext2D,
  frame: number,
  W: number,
  H: number,
  p: ParticleWarpSpec,
): void {
  const cx = W / 2;
  const cy = H / 2;
  const maxR = Math.hypot(W, H) * 0.6;
  const seed = p.seed ?? 11;
  ctx.clearRect(0, 0, W, H);

  // 1. nebula 벽: 보라/마젠타 blob 5개, 천천히 회전 drift.
  ctx.save();
  ctx.filter = "blur(50px)";
  const neb = p.nebula ?? ["#7634CA", "#9336DC", "#C04ADE"];
  const nr = seededRandom(seed + 7);
  for (let i = 0; i < 9; i++) {
    const a = nr() * Math.PI * 2 + frame * 0.005;
    const dist = maxR * (0.12 + nr() * 0.5);
    const x = cx + Math.cos(a) * dist;
    const y = cy + Math.sin(a) * dist;
    const rad = maxR * (0.2 + nr() * 0.3);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, neb[i % neb.length]);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 2. streak: 방사, 깊이 가속. 중심 가까울 땐 짧고 느림, 멀수록 길고 빠름.
  const count = p.count ?? 90;
  const speed = p.speed ?? 36;
  const streakColor = p.streakColor ?? "#9DCDCD";
  const sr = seededRandom(seed);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = streakColor;
  for (let i = 0; i < count; i++) {
    const angle = sr() * Math.PI * 2;
    const delay = sr() * speed;
    const spd = speed * (0.7 + sr() * 0.6);
    const lw = p.lineWidth ?? 1;
    const thick = lw + sr() * lw * 2.5;
    const lenF = 0.04 + sr() * 0.12;
    const local = frame - delay;
    if (local < 0) continue;
    const t = (local % spd) / spd;
    const td = Math.pow(t, 1.6); // 깊이 가속
    const r1 = td * maxR;
    const len = maxR * lenF * (0.4 + t);
    const r2 = r1 + len;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const op = t < 0.1 ? t / 0.1 : t > 0.85 ? (1 - t) / 0.15 : 1;
    ctx.globalAlpha = op;
    ctx.lineWidth = thick;
    ctx.beginPath();
    ctx.moveTo(cx + ca * r1, cy + sa * r1);
    ctx.lineTo(cx + ca * r2, cy + sa * r2);
    ctx.stroke();
  }
  ctx.restore();

  // 3. spark: 주황/노랑 짧은 막대.
  const sparkCount = p.sparkCount ?? 14;
  const sparkColor = p.sparkColor ?? "#FF8A3D";
  const spr = seededRandom(seed + 99);
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < sparkCount; i++) {
    const angle = spr() * Math.PI * 2;
    const delay = spr() * speed;
    const spd = speed * (0.6 + spr() * 0.5);
    const local = frame - delay;
    if (local < 0) continue;
    const t = (local % spd) / spd;
    const r1 = Math.pow(t, 1.4) * maxR;
    const len = 12 + t * 30;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const op = t < 0.1 ? t / 0.1 : t > 0.8 ? (1 - t) / 0.2 : 1;
    ctx.globalAlpha = op;
    ctx.strokeStyle = i % 3 === 0 ? "#F0D060" : sparkColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx + ca * r1, cy + sa * r1);
    ctx.lineTo(cx + ca * (r1 + len), cy + sa * (r1 + len));
    ctx.stroke();
  }
  ctx.restore();

  // 3.5 dust: 점박이 입자(점박이 nebula 흉내). frame 기반 방사.
  const dust = seededRandom(seed + 211);
  ctx.save();
  for (let i = 0; i < 120; i++) {
    const angle = dust() * Math.PI * 2;
    const delay = dust() * speed;
    const spd = speed * (0.6 + dust() * 0.7);
    const local = frame - delay;
    if (local < 0) continue;
    const t = (local % spd) / spd;
    const r = Math.pow(t, 1.7) * maxR;
    const sz = 0.8 + t * 2;
    const op = t < 0.15 ? t / 0.15 : t > 0.85 ? (1 - t) / 0.15 : 1;
    ctx.globalAlpha = op * 0.7;
    ctx.fillStyle = i % 4 === 0 ? "#FFFFFF" : streakColor;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 4. core: 중심 흰->연보라 글로우.
  ctx.save();
  ctx.filter = "blur(8px)";
  const coreColor = p.coreColor ?? "#C8B0F0";
  const coreR = maxR * 0.08;
  const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  cg.addColorStop(0, "#FFFFFF");
  cg.addColorStop(0.35, coreColor);
  cg.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = 0.65;
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export const ParticleField: React.FC<{ spec: ParticleWarpSpec }> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    drawTunnel(ctx, frame + (spec.frameOffset ?? 0), width, height, spec);
  }, [frame, width, height, spec]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    />
  );
};

export const name = "particles";
