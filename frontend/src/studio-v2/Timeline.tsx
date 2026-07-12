"use client";

import { motion } from "motion/react";
import { useAgentStore } from "./state";
import styles from "./timeline.module.css";

export function Timeline() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const duration = lastFinal?.duration ?? videoContext?.duration ?? 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerLabel}>타임라인</div>
        {duration > 0 ? (
          <div className={styles.headerMeta}>
            <span className={styles.tabular}>{duration.toFixed(1)}</span>
            <span className={styles.headerMetaSuffix}>s</span>
            {videoContext && (
              <>
                <span className={styles.headerSep} />
                <span>{videoContext.scenes.length} 씬</span>
                <span className={styles.headerSep} />
                <span>{videoContext.transcript.length} 자막</span>
              </>
            )}
          </div>
        ) : (
          <div className={styles.headerHint}>
            편집 지시를 내리면 여기에 씬 · 자막이 표시돼
          </div>
        )}
      </div>

      <div className={styles.tracks}>
        <div className={styles.trackRow}>
          <div className={styles.trackLabel}>씬</div>
          <div className={styles.track}>
            {videoContext && videoContext.scenes.length > 0 ? (
              renderScenes(videoContext.scenes, duration)
            ) : (
              <div className={styles.trackEmpty} />
            )}
          </div>
        </div>

        <div className={styles.trackRow}>
          <div className={styles.trackLabel}>자막</div>
          <div className={styles.track}>
            {videoContext && videoContext.transcript.length > 0 ? (
              renderSubs(videoContext.transcript, duration)
            ) : (
              <div className={styles.trackEmpty} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderScenes(
  scenes: { start: number; end: number }[],
  duration: number
) {
  if (duration <= 0) return null;
  return scenes.map((sc, i) => {
    const start = (sc.start / duration) * 100;
    const width = Math.max(0.6, ((sc.end - sc.start) / duration) * 100 - 0.5);
    return (
      <motion.div
        key={i}
        className={styles.sceneBlock}
        style={{ left: `${start}%`, width: `${width}%` }}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.24,
          delay: 0.03 * i,
          ease: [0.22, 1, 0.36, 1],
        }}
      />
    );
  });
}

function renderSubs(
  segs: { start: number; end: number }[],
  duration: number
) {
  if (duration <= 0) return null;
  return segs.map((sg, i) => {
    const start = (sg.start / duration) * 100;
    const width = Math.max(0.4, ((sg.end - sg.start) / duration) * 100 - 0.3);
    return (
      <motion.div
        key={i}
        className={styles.subBlock}
        style={{ left: `${start}%`, width: `${width}%` }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, delay: 0.012 * i }}
      />
    );
  });
}
