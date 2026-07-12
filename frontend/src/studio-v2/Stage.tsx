"use client";

import { AnimatePresence, motion } from "motion/react";
import { Film, Play, Pause, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "./state";
import { formatSeconds } from "@/lib/format";
import styles from "./stage.module.css";

export function Stage() {
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const uploadedUrl = useAgentStore((s) => s.uploadedUrl);
  const videoContext = useAgentStore((s) => s.videoContext);
  const activeNode = useAgentStore((s) => s.activeNode);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  const hasVideo = !!uploadedUrl || !!lastFinal;
  const displayDuration =
    videoDuration || lastFinal?.duration || videoContext?.duration || 0;
  const showName = lastFinal?.outputPath ?? uploadedName;

  // 파일 바뀌면 재생 상태 초기화
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
  }, [uploadedUrl]);

  // 재생 상태 -> video element sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) {
      v.play().catch(() => setPlaying(false));
    } else {
      v.pause();
    }
  }, [playing]);

  // muted sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
  }, [muted]);

  // 스페이스바 = 재생/일시정지 (input 에 포커스 없을 때만)
  useEffect(() => {
    if (!hasVideo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      e.preventDefault();
      setPlaying((p) => !p);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasVideo]);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v || !videoDuration) return;
    const clamped = Math.max(0, Math.min(t, videoDuration));
    v.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const onScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrubRef.current;
    if (!el || !videoDuration) return;
    el.setPointerCapture(e.pointerId);
    setScrubbing(true);
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    seek(pct * videoDuration);
  };

  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    const el = scrubRef.current;
    if (!el || !videoDuration) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    seek(pct * videoDuration);
  };

  const onScrubEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrubRef.current;
    if (el) el.releasePointerCapture(e.pointerId);
    setScrubbing(false);
  };

  const percent = displayDuration
    ? (currentTime / displayDuration) * 100
    : 0;

  return (
    <div className={styles.stage}>
      <AnimatePresence mode="wait">
        {!hasVideo ? (
          <motion.div
            key="empty"
            className={styles.empty}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className={styles.emptyMark}
              animate={{
                scale: [1, 1.03, 1],
                opacity: [0.85, 1, 0.85],
              }}
              transition={{
                duration: 3.6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <Film size={26} strokeWidth={1.3} />
            </motion.div>
            <div className={styles.emptyTitle}>프리뷰 대기 중</div>
            <div className={styles.emptyCaption}>
              좌측에서 영상을 업로드하거나 예시 지시를 눌러 시작해봐
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="preview"
            className={styles.preview}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={styles.videoWrap}>
              {uploadedUrl && (
                <video
                  ref={videoRef}
                  src={uploadedUrl}
                  className={styles.video}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setVideoDuration(v.duration || 0);
                  }}
                  onTimeUpdate={(e) => {
                    setCurrentTime(e.currentTarget.currentTime);
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  playsInline
                  preload="metadata"
                />
              )}
              {!uploadedUrl && lastFinal && (
                <div className={styles.previewFallback}>
                  <div className={styles.fallbackLabel}>편집 결과</div>
                  <div className={styles.fallbackName}>{lastFinal.outputPath}</div>
                  <div className={styles.fallbackHint}>
                    (백엔드 연결 시 실제 mp4 로 로드)
                  </div>
                </div>
              )}

              {/* Filename overlay bottom */}
              {showName && (
                <div className={styles.nameOverlay}>
                  <span className={styles.nameLabel}>
                    {lastFinal ? "편집 결과" : "원본"}
                  </span>
                  <span className={styles.nameFile}>{showName}</span>
                </div>
              )}

              {/* Active node overlay top */}
              {activeNode && (
                <motion.div
                  className={styles.nodeOverlay}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                >
                  <motion.span
                    className={styles.nodeDot}
                    animate={{ opacity: [1, 0.4, 1] }}
                    transition={{ duration: 1.4, repeat: Infinity }}
                  />
                  {getNodeLabel(activeNode)} 실행 중
                </motion.div>
              )}
            </div>

            <div className={styles.transport}>
              <button
                type="button"
                className={styles.playBtn}
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? "일시정지" : "재생"}
                title="Space"
              >
                {playing ? (
                  <Pause size={13} strokeWidth={2.4} />
                ) : (
                  <Play size={13} strokeWidth={2.4} />
                )}
              </button>
              <div className={styles.timecode}>
                <span className={styles.tabular}>
                  {formatSeconds(currentTime)}
                </span>
                <span className={styles.timecodeSep}>/</span>
                <span className={styles.timecodeDur}>
                  {formatSeconds(displayDuration)}
                </span>
              </div>

              <div
                ref={scrubRef}
                className={styles.scrubTrack}
                onPointerDown={onScrubStart}
                onPointerMove={onScrubMove}
                onPointerUp={onScrubEnd}
                onPointerCancel={onScrubEnd}
              >
                <div
                  className={styles.scrubFill}
                  style={{ width: `${percent}%` }}
                />
                <div
                  className={styles.scrubHead}
                  style={{ left: `${percent}%` }}
                />
              </div>

              <button
                type="button"
                className={styles.iconTransportBtn}
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "음소거 해제" : "음소거"}
              >
                {muted ? (
                  <VolumeX size={13} strokeWidth={2.2} />
                ) : (
                  <Volume2 size={13} strokeWidth={2.2} />
                )}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {sessionStatus === "streaming" && (
        <motion.div
          className={styles.streamBadge}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
        >
          <motion.span
            className={styles.streamDot}
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1.2, repeat: Infinity }}
          />
          <span>스트리밍 중</span>
        </motion.div>
      )}
    </div>
  );
}

function getNodeLabel(node: string) {
  return (
    {
      orchestrator: "총괄",
      research: "리서치",
      planning: "기획",
      edit: "편집",
      critic: "검증",
    } as Record<string, string>
  )[node] ?? node;
}
