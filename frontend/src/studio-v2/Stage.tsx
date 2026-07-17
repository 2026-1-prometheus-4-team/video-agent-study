"use client";

import { AnimatePresence, motion } from "motion/react";
import { Film, Play, Pause, Volume2, VolumeX, Scissors, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

  // playhead · playing 은 store 에서 공유 (Timeline 이 seek/play 함께 조작)
  const playing = useAgentStore((s) => s.playing);
  const setPlaying = useAgentStore((s) => s.setPlaying);
  const playhead = useAgentStore((s) => s.playhead);
  const setPlayhead = useAgentStore((s) => s.setPlayhead);
  const [muted, setMuted] = useState(false);
  const [videoDuration, setVideoDurationLocal] = useState(0);
  // Timeline 이 참조할 실제 mp4 길이를 store 로 전파.
  const setStageVideoDuration = useAgentStore((s) => s.setStageVideoDuration);
  const setVideoDuration = (v: number) => {
    setVideoDurationLocal(v);
    setStageVideoDuration(v);
  };
  const [scrubbing, setScrubbing] = useState(false);
  const currentTime = playhead;
  const setCurrentTime = setPlayhead;
  // 편집 결과가 도착하면 자동으로 편집본으로 스위치. 사용자가 명시적으로 원본
  // 다시 보기를 눌러야 원본으로 돌아감. Timeline 도 이 값을 봐서 씬/자막 소스 결정.
  const viewMode = useAgentStore((s) => s.stageViewMode);
  const setViewMode = useAgentStore((s) => s.setStageViewMode);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  // Timeline 이 playhead 바꾸면 video seek. 재생 중이 아닐 때만 (재생 중엔
  // onTimeUpdate 가 이미 store 를 갱신 중이라 재바인딩 하면 stutter).
  useEffect(() => {
    const v = videoRef.current;
    if (!v || playing) return;
    if (Math.abs(v.currentTime - playhead) > 0.12) {
      v.currentTime = playhead;
    }
  }, [playhead, playing]);

  // 명시적 시킹 요청 (채팅 카드 칩·타임스탬프 링크) — playing 여부와 무관하게
  // 이동 (재생은 유지). 소스 전환 직후엔 metadata 미로드 상태일 수 있으므로
  // pendingSeekRef 에 담아 onLoadedMetadata 에서 적용.
  const seekRequest = useAgentStore((s) => s.seekRequest);
  const pendingSeekRef = useRef<number | null>(null);
  const lastSeekNonceRef = useRef(seekRequest?.nonce ?? 0);
  useEffect(() => {
    if (!seekRequest || seekRequest.nonce === lastSeekNonceRef.current) return;
    lastSeekNonceRef.current = seekRequest.nonce;
    const v = videoRef.current;
    const t = Math.max(0, seekRequest.t);
    if (v && v.readyState >= 1) {
      const dur = v.duration;
      const clamped =
        Number.isFinite(dur) && dur > 0 ? Math.min(t, dur) : t;
      v.currentTime = clamped;
      setCurrentTime(clamped);
    } else {
      pendingSeekRef.current = t;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest]);

  // 백엔드 output_url 이 비어있어도 output_path 로 fallback 유추 (videos/, outputs/
  // 접두사 케이스). _to_file_url 매핑 실패 시 stage 가 원본 계속 재생하는 버그
  // 방어. API_BASE 는 backend.ts 와 동일한 규칙.
  const finalUrl = useMemo(() => {
    if (!lastFinal) return null;
    if (lastFinal.outputUrl) return lastFinal.outputUrl;
    const p = lastFinal.outputPath;
    if (!p) return null;
    const API_BASE = (
      process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
    ).replace(/\/+$/, "");
    // 상대경로 videos/... outputs/... audio_files/... bgm_files/... → /files/<sub>/...
    const m = p.match(/^(?:.*[/\\])?(videos|outputs|audio_files|bgm_files)\/(.+)$/);
    if (m) {
      const sub =
        m[1] === "audio_files" ? "audio" : m[1] === "bgm_files" ? "bgm" : m[1];
      return `${API_BASE}/files/${sub}/${m[2]}`;
    }
    return null;
  }, [lastFinal]);

  const hasFinal = !!finalUrl;
  const hasSource = !!uploadedUrl;
  const hasVideo = hasFinal || hasSource || !!lastFinal;

  // 새 편집 결과 도착 → 자동으로 편집본으로 스위치.
  useEffect(() => {
    if (hasFinal) setViewMode("final");
  }, [hasFinal, finalUrl]);

  // 실 재생 src — 편집본이 있고 viewMode==="final" 이면 편집본, 아니면 원본.
  const activeSrc = useMemo(() => {
    if (viewMode === "final" && finalUrl) return finalUrl;
    if (uploadedUrl) return uploadedUrl;
    return finalUrl ?? null;
  }, [viewMode, finalUrl, uploadedUrl]);

  const displayDuration =
    videoDuration || lastFinal?.duration || videoContext?.duration || 0;
  const showName =
    viewMode === "final" && lastFinal?.outputPath
      ? lastFinal.outputPath
      : uploadedName ?? lastFinal?.outputPath ?? "";

  // 소스가 바뀌면 재생 상태 초기화
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
  }, [activeSrc]);

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
      setPlaying(!playing);
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
              {activeSrc && (
                <video
                  ref={videoRef}
                  // key 를 src 에 물려서 src 바뀔 때 element 재초기화 (metadata 재로드)
                  key={activeSrc}
                  src={activeSrc}
                  className={styles.video}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setVideoDuration(v.duration || 0);
                    // 소스 전환 중 요청됐던 시킹을 metadata 로드 후 적용.
                    if (pendingSeekRef.current != null) {
                      const dur = v.duration;
                      const t =
                        Number.isFinite(dur) && dur > 0
                          ? Math.min(pendingSeekRef.current, dur)
                          : pendingSeekRef.current;
                      pendingSeekRef.current = null;
                      v.currentTime = t;
                      setCurrentTime(t);
                    }
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
              {!activeSrc && lastFinal && (
                <div className={styles.previewFallback}>
                  <div className={styles.fallbackLabel}>편집 결과</div>
                  <div className={styles.fallbackName}>{lastFinal.outputPath}</div>
                  <div className={styles.fallbackHint}>
                    (백엔드 연결 시 실제 mp4 로 로드)
                  </div>
                </div>
              )}

              {/* Source / Final 토글 — 편집본이 있을 때만 표시 */}
              {hasFinal && hasSource && (
                <div className={styles.viewToggle}>
                  <button
                    type="button"
                    className={styles.viewToggleBtn}
                    data-active={viewMode === "final" || undefined}
                    onClick={() => setViewMode("final")}
                  >
                    <Scissors size={11} strokeWidth={2.2} />
                    <span>편집본</span>
                  </button>
                  <button
                    type="button"
                    className={styles.viewToggleBtn}
                    data-active={viewMode === "source" || undefined}
                    onClick={() => setViewMode("source")}
                  >
                    <Upload size={11} strokeWidth={2.2} />
                    <span>원본</span>
                  </button>
                </div>
              )}

              {/* Filename overlay bottom */}
              {showName && (
                <div className={styles.nameOverlay}>
                  <span className={styles.nameLabel}>
                    {viewMode === "final" && hasFinal ? "편집 결과" : "원본"}
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
                onClick={() => setPlaying(!playing)}
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
