"use client";

// RefVideo — 레퍼런스 영상을 플레이헤드에 동기화. startFrame 에 영상 t=0 을 맞추고,
// 재생 중엔 play + 드리프트 보정, 정지/스크럽 중엔 seek. 범위 밖이면 숨김.

import React from "react";
import { usePlayerFrame, usePlayerPlaying } from "@/editor/playerBridge";
import { FPS } from "@/engine/normalize";

export function RefVideo({
  url,
  startFrame,
  endFrame,
  style,
  className,
}: {
  url: string;
  startFrame: number;
  /** 지정 시 [startFrame, endFrame] 구간에 영상 전체(0..duration)를 늘려 맞춘다
   *  (시작·끝 둘 다 정렬). null 이면 자연 속도로 startFrame 부터 재생. */
  endFrame?: number | null;
  style?: React.CSSProperties;
  className?: string;
}) {
  const frame = usePlayerFrame();
  const playing = usePlayerPlaying();
  const ref = React.useRef<HTMLVideoElement>(null);
  const [dur, setDur] = React.useState(0);

  // 시작·끝 정렬(time-remap) vs 자연 속도
  const remap = endFrame != null && endFrame > startFrame;
  const target = remap
    ? ((frame - startFrame) / (endFrame! - startFrame)) * (dur || 0)
    : (frame - startFrame) / FPS;
  const inRange = frame >= startFrame && (dur === 0 || target <= dur + 0.05) && (endFrame == null || frame <= endFrame);

  React.useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!inRange) {
      if (!v.paused) v.pause();
      return;
    }
    const clamped = Math.max(0, dur ? Math.min(dur, target) : target);
    // remap 모드는 시간축이 다르므로 항상 seek(재생속도 안 맞음), 자연모드는 play.
    if (playing && !remap) {
      if (Math.abs(v.currentTime - clamped) > 0.18) v.currentTime = clamped;
      if (v.paused) void v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - clamped) > 0.02) v.currentTime = clamped;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, playing, inRange, dur, remap]);

  return (
    <video
      ref={ref}
      src={url}
      className={className}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
      style={{
        display: inRange ? "block" : "none",
        objectFit: "contain",
        ...style,
      }}
    />
  );
}
