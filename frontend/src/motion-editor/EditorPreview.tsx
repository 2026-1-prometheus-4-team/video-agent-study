"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef } from "react";
import { Play, Pause, Volume2, VolumeX } from "lucide-react";
import { useState } from "react";
import { useAgentStore } from "@/studio-v2/state";
import { useEditorStore } from "./editorState";
import { formatSeconds } from "@/lib/format";
import styles from "./editor-preview.module.css";

const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

export function EditorPreview() {
  const uploadedUrl = useAgentStore((s) => s.uploadedUrl);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const videoContext = useAgentStore((s) => s.videoContext);
  const playhead = useEditorStore((s) => s.playhead);
  const playing = useEditorStore((s) => s.playing);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);
  const overrides = useEditorStore((s) => s.subtitleOverrides);
  const globalSubtitleStyle = useEditorStore((s) => s.globalSubtitleStyle);

  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Prefer the agent result. The upload is only a fallback before a result exists.
  const src = useMemo(() => {
    if (lastFinal?.outputUrl) return lastFinal.outputUrl;
    if (lastFinal?.outputPath?.startsWith("/"))
      return `${API_BASE}${lastFinal.outputPath}`;
    const match = lastFinal?.outputPath?.match(
      /^(?:.*[/\\])?(output|outputs|videos)\/(.+)$/
    );
    if (match) return `${API_BASE}/files/${match[1]}/${match[2]}`;
    return uploadedUrl || null;
  }, [uploadedUrl, lastFinal]);

  const transcript = lastFinal?.transcript ?? videoContext?.transcript ?? [];
  const duration =
    lastFinal?.duration ?? videoContext?.duration ?? 0;

  // 재생/일시정지 sync
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, setPlaying]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = muted;
  }, [muted]);

  // 외부 (SubtitleList 클릭) 로 인해 playhead 가 바뀌면 video seek
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - playhead) > 0.15) {
      v.currentTime = playhead;
    }
  }, [playhead]);

  // 현재 표시할 자막 세그먼트 (playhead 안에 있는 것)
  const activeSubtitle = useMemo(() => {
    for (let i = 0; i < transcript.length; i++) {
      const seg = transcript[i];
      if (playhead >= seg.start && playhead <= seg.end) {
        const override = overrides[i];
        return {
          text: override?.text ?? seg.text,
          override,
        };
      }
    }
    return null;
  }, [transcript, playhead, overrides]);

  return (
    <div className={styles.wrap}>
      <div className={styles.videoFrame}>
        {src ? (
          <video
            ref={videoRef}
            src={src}
            className={styles.video}
            preload="metadata"
            playsInline
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <div className={styles.emptySrc}>영상 소스가 없어</div>
        )}

        <AnimatePresence mode="wait">
          {activeSubtitle && (
            <motion.div
              key={activeSubtitle.text}
              className={styles.subtitlePositioner}
              style={{
                bottom:
                  activeSubtitle.override?.position === "top"
                    ? "auto"
                    : activeSubtitle.override?.position === "middle"
                      ? "50%"
                      : "8%",
                top:
                  activeSubtitle.override?.position === "top" ? "8%" : "auto",
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <div
                className={styles.subtitleOverlay}
                style={{
                  fontSize: activeSubtitle.override?.fontSize
                    ?? (globalSubtitleStyle ? Math.round(globalSubtitleStyle.size * 1.5) : 26),
                  fontWeight: activeSubtitle.override?.fontWeight
                    ?? (globalSubtitleStyle ? (globalSubtitleStyle.bold ? 700 : 400) : 600),
                  color: activeSubtitle.override?.color ?? globalSubtitleStyle?.color ?? "#ffffff",
                  // 외곽선까지 맞춰야 미리보기와 같은 자막으로 보인다. 굵기/크기만
                  // 맞추고 외곽선을 빼면 밝은 화면에서 글자가 묻혀 다르게 읽힌다.
                  WebkitTextStrokeWidth: globalSubtitleStyle
                    ? `${globalSubtitleStyle.strokeWidth}px`
                    : undefined,
                  WebkitTextStrokeColor: globalSubtitleStyle?.strokeColor,
                  paintOrder: "stroke fill",
                }}
              >
                {activeSubtitle.text}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={styles.transport}>
        <button
          type="button"
          className={styles.playBtn}
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? "일시정지" : "재생"}
        >
          {playing ? (
            <Pause size={13} strokeWidth={2.4} />
          ) : (
            <Play size={13} strokeWidth={2.4} />
          )}
        </button>
        <div className={styles.timecode}>
          <span className={styles.tabular}>{formatSeconds(playhead)}</span>
          <span className={styles.sep}>/</span>
          <span className={styles.tabular}>{formatSeconds(duration)}</span>
        </div>
        <button
          type="button"
          className={styles.muteBtn}
          onClick={() => setMuted(!muted)}
          aria-label={muted ? "음소거 해제" : "음소거"}
        >
          {muted ? (
            <VolumeX size={13} strokeWidth={2.2} />
          ) : (
            <Volume2 size={13} strokeWidth={2.2} />
          )}
        </button>
      </div>
    </div>
  );
}
