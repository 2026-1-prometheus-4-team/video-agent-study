"use client";

import { AnimatePresence, motion } from "motion/react";
import { Film, Play, Pause } from "lucide-react";
import { useState } from "react";
import { useAgentStore } from "./state";
import { formatSeconds } from "@/lib/format";
import styles from "./stage.module.css";

export function Stage() {
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const uploadedName = useAgentStore((s) => s.uploadedName);
  const videoContext = useAgentStore((s) => s.videoContext);
  const activeNode = useAgentStore((s) => s.activeNode);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);
  const [playing, setPlaying] = useState(false);

  const hasVideo = !!lastFinal || !!uploadedName;
  const duration = lastFinal?.duration ?? videoContext?.duration ?? 0;

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
                scale: [1, 1.04, 1],
                opacity: [0.85, 1, 0.85],
              }}
              transition={{
                duration: 3.4,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <Film size={28} strokeWidth={1.4} />
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
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className={styles.previewSurface}>
              <div className={styles.previewLabel}>
                {lastFinal ? "편집 결과" : "원본"}
              </div>
              <div className={styles.previewFilename}>
                {lastFinal?.outputPath ?? uploadedName}
              </div>
              {activeNode && (
                <div className={styles.previewActive}>
                  {getNodeLabel(activeNode)} 실행 중
                </div>
              )}
            </div>

            <div className={styles.transport}>
              <button
                type="button"
                className={styles.playBtn}
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? "일시정지" : "재생"}
              >
                {playing ? (
                  <Pause size={13} strokeWidth={2.4} />
                ) : (
                  <Play size={13} strokeWidth={2.4} />
                )}
              </button>
              <div className={styles.timecode}>
                <span className={styles.tabular}>{formatSeconds(0)}</span>
                <span className={styles.timecodeSep}>/</span>
                <span className={styles.tabular}>{formatSeconds(duration)}</span>
              </div>
              <div className={styles.scrubTrack}>
                <div className={styles.scrubFill} style={{ width: "0%" }} />
                <div className={styles.scrubHead} style={{ left: "0%" }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {sessionStatus === "streaming" && (
        <motion.div
          className={styles.streamBadge}
          initial={{ opacity: 0, y: -4 }}
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
