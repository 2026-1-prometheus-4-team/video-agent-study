"use client";

import { AnimatePresence, motion } from "motion/react";
import { Film, Play, Pause, Volume2, VolumeX, Scissors, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAgentStore } from "./state";
import { formatSeconds } from "@/lib/format";
import {
  getSubtitleStyle,
  pathStem,
  type SubtitleStyle,
} from "./subtitle/subtitleApi";
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
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // videoWrap 은 CSS 상 고정 비율이 아니라 남는 flex 공간을 그대로 채우는 박스라,
  // 세로(9:16) 영상이 가로로 넓은 wrap 안에서 object-fit:contain 으로 작게
  // 레터박스되어 보이는 경우가 흔하다. 자막을 "실제 보이는 영상 영역"에 맞추려면
  // wrap 크기 + 영상 원본 비율로 그 영역을 직접 계산해야 한다.
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
  const [videoNatural, setVideoNatural] = useState<{ w: number; h: number } | null>(
    null
  );
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWrapSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // wrap 안에서 object-fit:contain 이 만드는 실제 영상 표시 영역(레터박스 제외).
  const frameRect = useMemo(() => {
    if (!videoNatural || !wrapSize.w || !wrapSize.h) return null;
    const scale = Math.min(
      wrapSize.w / videoNatural.w,
      wrapSize.h / videoNatural.h
    );
    const w = videoNatural.w * scale;
    const h = videoNatural.h * scale;
    return { w, h, left: (wrapSize.w - w) / 2, top: (wrapSize.h - h) / 2 };
  }, [videoNatural, wrapSize]);

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
    const m = p.match(/^(?:.*[/\\])?(videos|output|outputs|audio_files|bgm_files)\/(.+)$/);
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

  // 자막 cue 레이어 — 편집본은 자막을 굽지 않고(cue 만 생성) 여기서 실시간 렌더.
  // 편집본 재생(viewMode==="final") 일 때만 표시: transcript 타임스탬프가 편집된
  // 타임라인 기준이라 원본 재생 시에는 어긋난다.
  const subtitleCues = lastFinal?.transcript ?? videoContext?.transcript ?? [];
  const activeSubtitle = useMemo(() => {
    if (viewMode !== "final") return null;
    for (const seg of subtitleCues) {
      if (currentTime >= seg.start && currentTime <= seg.end) {
        return seg.text;
      }
    }
    return null;
  }, [subtitleCues, currentTime, viewMode]);

  // cue 문서에 저장된 자막 스타일을 오버레이에 반영해 스타일 카드와 WYSIWYG 유지.
  // 스타일을 못 불러오면(백엔드 미연결/큐 없음) CSS 기본 룩으로 둔다.
  const [subStyle, setSubStyle] = useState<SubtitleStyle | null>(null);
  const finalStem = pathStem(lastFinal?.outputPath);
  // 자막 스타일 카드에서 "저장"할 때마다 subtitleStyleVersion 이 증가 — 새로고침
  // 없이 바로 재조회해서 옆 미리보기에 즉시 반영되게 한다.
  const subtitleStyleVersion = useAgentStore((s) => s.subtitleStyleVersion);
  useEffect(() => {
    if (!finalStem || !hasFinal) {
      setSubStyle(null);
      return;
    }
    let alive = true;
    getSubtitleStyle(finalStem)
      .then((s) => {
        if (alive) setSubStyle(s);
      })
      .catch(() => {
        if (alive) setSubStyle(null);
      });
    return () => {
      alive = false;
    };
  }, [finalStem, hasFinal, subtitleStyleVersion]);

  const subtitleOverlayStyle = useMemo<CSSProperties>(() => {
    if (!subStyle) return {};
    const strokeShadow = (() => {
      if (!subStyle.stroke_width) return undefined;
      const s = Math.ceil(subStyle.stroke_width);
      const dirs: string[] = [];
      for (let x = -s; x <= s; x++) {
        for (let y = -s; y <= s; y++) {
          if (x !== 0 || y !== 0)
            dirs.push(`${x}px ${y}px 0 ${subStyle.stroke_color}`);
        }
      }
      return dirs.join(", ");
    })();
    const inset = 4 + (subStyle.margin_v / 100) * 40; // % from edge

    // frameRect 를 아직 모르면(메타데이터 로드 전) 예전처럼 wrap 기준 % 로 폴백.
    if (!frameRect) {
      const placement: CSSProperties =
        subStyle.position === "top"
          ? { top: `${inset}%`, bottom: "auto", left: "50%", transform: "translateX(-50%)" }
          : subStyle.position === "middle"
            ? { top: "50%", bottom: "auto", left: "50%", transform: "translate(-50%, -50%)" }
            : { bottom: `${inset}%`, top: "auto", left: "50%", transform: "translateX(-50%)" };
      return {
        ...placement,
        color: subStyle.color,
        fontWeight: subStyle.bold ? 800 : 500,
        textShadow: strokeShadow,
      };
    }

    // 실제 영상이 보이는 영역(frameRect) 기준으로 위치 계산 — wrap 에 생기는
    // 레터박스(여백)는 무시하고 항상 영상 프레임 안쪽에 자막이 들어오게 한다.
    const centerX = frameRect.left + frameRect.w / 2;
    const placement: CSSProperties =
      subStyle.position === "top"
        ? {
            top: frameRect.top + (inset / 100) * frameRect.h,
            bottom: "auto",
            transform: "translateX(-50%)",
          }
        : subStyle.position === "middle"
          ? {
              top: frameRect.top + frameRect.h / 2,
              bottom: "auto",
              transform: "translate(-50%, -50%)",
            }
          : {
              bottom:
                wrapSize.h - (frameRect.top + frameRect.h) + (inset / 100) * frameRect.h,
              top: "auto",
              transform: "translateX(-50%)",
            };
    return {
      left: centerX,
      maxWidth: frameRect.w * 0.86,
      ...placement,
      color: subStyle.color,
      fontWeight: subStyle.bold ? 800 : 500,
      textShadow: strokeShadow,
    };
  }, [subStyle, frameRect, wrapSize.h]);

  const displayDuration =
    videoDuration || lastFinal?.duration || videoContext?.duration || 0;
  const showName =
    viewMode === "final" && lastFinal?.outputPath
      ? lastFinal.outputPath
      : uploadedName ?? lastFinal?.outputPath ?? "";

  // 소스가 바뀌면 재생 상태 초기화 (자막 프레임 계산도 새 영상 메타데이터를
  // 다시 읽을 때까지 리셋 — 이전 소스의 비율로 잘못 계산되는 것 방지).
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setVideoDuration(0);
    setVideoNatural(null);
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
            <div className={styles.videoWrap} ref={wrapRef}>
              {activeSrc && (
                <video
                  ref={videoRef}
                  // key 를 src 에 물려서 src 바뀔 때 element 재초기화 (metadata 재로드)
                  key={activeSrc}
                  src={activeSrc}
                  className={styles.video}
                  onLoadedMetadata={(e) => {
                    if (e.currentTarget.videoWidth && e.currentTarget.videoHeight) {
                      setVideoNatural({
                        w: e.currentTarget.videoWidth,
                        h: e.currentTarget.videoHeight,
                      });
                    }
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

              {/* 자막 cue 오버레이 (편집본 재생 시) */}
              <AnimatePresence mode="wait">
                {activeSubtitle && (
                  <motion.div
                    key={activeSubtitle}
                    className={styles.subtitleOverlay}
                    style={subtitleOverlayStyle}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                  >
                    {activeSubtitle}
                  </motion.div>
                )}
              </AnimatePresence>

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
