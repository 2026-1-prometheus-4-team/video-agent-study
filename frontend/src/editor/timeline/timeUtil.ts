// timeUtil.ts — 타임코드 포맷 + 눈금 스텝 선택.

import { FPS } from "@/engine/normalize";

export function formatTC(frame: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSec = Math.floor(f / FPS);
  const ff = f % FPS;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

// 라벨이 최소 minPx 간격이 되도록 눈금 스텝(프레임) 선택.
const STEPS = [1, 2, 5, 10, 24, 48, 96, 240];
export function tickStep(pxPerFrame: number, minPx = 52): number {
  for (const st of STEPS) {
    if (st * pxPerFrame >= minPx) return st;
  }
  return STEPS[STEPS.length - 1];
}
