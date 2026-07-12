"use client";

// VideoStage — 프리뷰 플레이어. 레터박스 스테이지 + 미니 트랜스포트.
// 버전(src) 이 바뀌면 재생 위치 유지 없이 처음부터 (편집 결과 비교 용도).

import React from "react";
import s from "./studio.module.css";

function fmt(t: number): string {
  if (!Number.isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

export default function VideoStage({
  videoRef,
  src,
  label,
  onTime,
}: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  src: string | null;
  label: string | null;
  onTime: (time: number, duration: number) => void;
}) {
  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(0);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - r.left) / r.width) * v.duration;
  };

  if (!src) {
    return (
      <div className={s.stage}>
        <div className={s.stageEmpty}>
          <div className={s.stageEmptyMark}>VA</div>
          <div className={s.stageEmptyText}>
            좌측에서 영상을 업로드하면 여기서 미리보기가 시작됩니다
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s.stage}>
      <div className={s.stageInner}>
        <video
          key={src}
          ref={(el) => {
            videoRef.current = el;
          }}
          className={s.stageVideo}
          src={src}
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDuration(v.duration || 0);
            onTime(v.currentTime, v.duration || 0);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setTime(v.currentTime);
            onTime(v.currentTime, v.duration || 0);
          }}
          onClick={toggle}
        />
        {label ? <span className={s.stageBadge}>{label}</span> : null}
      </div>

      <div className={s.transport}>
        <button className={s.playBtn} onClick={toggle} title={playing ? "일시정지" : "재생"}>
          {playing ? (
            <svg width="11" height="11" viewBox="0 0 10 10">
              <path d="M2 1.5h2v7H2zM6 1.5h2v7H6z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 10 10">
              <path d="M2.5 1.5v7L8 5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <span className={`${s.timeLabel} tnum`}>
          {fmt(time)} / {fmt(duration)}
        </span>
        <div className={s.scrubber} onClick={scrub}>
          <div
            className={s.scrubberFill}
            style={{ width: duration ? `${(time / duration) * 100}%` : 0 }}
          />
        </div>
      </div>
    </div>
  );
}
