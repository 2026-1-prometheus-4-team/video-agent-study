"use client";

// Playhead — 재생 프레임을 구독하는 격리 컴포넌트. 스크럽 중 rows 재렌더 방지.

import React from "react";
import { usePlayerFrame } from "@/editor/playerBridge";
import s from "./timeline.module.css";

export function Playhead({
  sceneStart,
  sceneFrames,
  pxPerFrame,
  gutter,
  onScrubDown,
  onScrubMove,
  onScrubUp,
}: {
  sceneStart: number;
  sceneFrames: number;
  pxPerFrame: number;
  gutter: number;
  onScrubDown?: (e: React.PointerEvent) => void;
  onScrubMove?: (e: React.PointerEvent) => void;
  onScrubUp?: (e: React.PointerEvent) => void;
}) {
  const frame = usePlayerFrame();
  const local = frame - sceneStart;
  if (local < 0 || local > sceneFrames) return null;
  const x = gutter + local * pxPerFrame;
  return (
    <>
      {/* 시각 라인 — 트랙 영역만. z7 이라 sticky 씬 스트립(9)/눈금(8) 아래로
          들어가 스크롤해도 위로 안 뚫는다. 삼각형 캡은 PlayheadCap(눈금 안,
          sticky 와 함께 고정)이 담당. */}
      <div className={s.playhead} style={{ left: x }} />
      {/* 그랩 스트립 — 라인과 같은 x, 트랙 전체 높이. z3 이라 키프레임 다이아
          (z6)/트림 핸들(z4) 등 상호작용 요소가 겹치면 그쪽이 우선(요구사항:
          라인은 다른 데서도 잡을 수 있으니 겹치는 곳은 양보). */}
      {onScrubDown && (
        <div
          className={s.playheadGrab}
          style={{ left: x }}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
        />
      )}
    </>
  );
}

// 눈금(sticky) 안에 사는 재생헤드 캡(삼각형) — 스크롤과 무관하게 눈금에 고정.
export function PlayheadCap({
  sceneStart,
  sceneFrames,
  pxPerFrame,
}: {
  sceneStart: number;
  sceneFrames: number;
  pxPerFrame: number;
}) {
  const frame = usePlayerFrame();
  const local = frame - sceneStart;
  if (local < 0 || local > sceneFrames) return null;
  return <div className={s.playheadCap} style={{ left: local * pxPerFrame }} />;
}

// 헤더 시간 표시 (격리)
export function TransportTime({ total }: { total: number }) {
  const frame = usePlayerFrame();
  return (
    <span className={`${s.timeReadout} mono`}>
      {fmt(frame)} <span className={s.timeSep}>/</span> {fmt(total)}
      <span className={s.frameNum}>f{Math.round(frame)}</span>
    </span>
  );
}

function fmt(frame: number): string {
  const f = Math.max(0, Math.round(frame));
  const totalSec = Math.floor(f / 24);
  const ff = f % 24;
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${m}:${String(sec).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}
