"use client";

// VideoStage — 프리뷰 플레이어. 레터박스 스테이지 + 미니 트랜스포트.
// 버전(src) 이 바뀌면 재생 위치 유지 없이 처음부터 (편집 결과 비교 용도).
// 키보드: Space 재생/정지, ←/→ 1초 시킹 (입력 필드 포커스 시 무시).

import React from "react";
import s from "./studio.module.css";

function fmt(t: number): string {
  if (!Number.isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
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
  const [loadError, setLoadError] = React.useState(false);
  const scrubRef = React.useRef<HTMLDivElement | null>(null);
  const draggingRef = React.useRef(false);

  React.useEffect(() => {
    setLoadError(false);
  }, [src]);

  const toggle = React.useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, [videoRef]);

  // 키보드 컨트롤 (전역 — 채팅 입력 중엔 무시)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const v = videoRef.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, videoRef]);

  // 스크러버: 클릭 + 드래그 (pointer capture)
  const seekFromEvent = React.useCallback(
    (clientX: number) => {
      const v = videoRef.current;
      const el = scrubRef.current;
      if (!v || !el || !v.duration) return;
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      v.currentTime = ratio * v.duration;
    },
    [videoRef],
  );

  const onScrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  };
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seekFromEvent(e.clientX);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
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
        {loadError ? (
          <div className={s.stageError}>
            <div className={s.stageErrorTitle}>영상을 불러올 수 없어요</div>
            <div className={s.stageErrorDesc}>
              백엔드가 꺼져 있거나 파일이 이동됐을 수 있어요.
              <br />
              {src}
            </div>
          </div>
        ) : (
          <div className={s.videoWrap}>
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
              onError={() => setLoadError(true)}
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
        )}
      </div>

      <div className={s.transport}>
        <button className={s.playBtn} onClick={toggle} title={playing ? "일시정지 (Space)" : "재생 (Space)"}>
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
        <div
          className={s.scrubber}
          ref={scrubRef}
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
        >
          <div className={s.scrubberTrack}>
            <div
              className={s.scrubberFill}
              style={{ width: duration ? `${(time / duration) * 100}%` : 0 }}
            />
            <div
              className={s.scrubberThumb}
              style={{ left: duration ? `${(time / duration) * 100}%` : 0 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
