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
                <span>{videoContext.sceneCount} 씬</span>
                <span className={styles.headerSep} />
                <span>{videoContext.transcriptCount} 자막</span>
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
            {videoContext ? (
              renderScenes(videoContext.sceneCount, duration)
            ) : (
              <div className={styles.trackEmpty} />
            )}
          </div>
        </div>

        <div className={styles.trackRow}>
          <div className={styles.trackLabel}>자막</div>
          <div className={styles.track}>
            {videoContext ? (
              renderSubs(videoContext.transcriptCount, duration)
            ) : (
              <div className={styles.trackEmpty} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function renderScenes(count: number, duration: number) {
  const segments = Array.from({ length: count }).map((_, i) => {
    const start = (i / count) * 100;
    const width = (1 / count) * 100 - 0.6;
    return { start, width, key: i };
  });
  return segments.map((s, i) => (
    <motion.div
      key={s.key}
      className={styles.sceneBlock}
      style={{ left: `${s.start}%`, width: `${s.width}%` }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.24,
        delay: 0.03 * i,
        ease: [0.22, 1, 0.36, 1],
      }}
    />
  ));
}

function renderSubs(count: number, duration: number) {
  // 자막은 겹치는 블록으로. 임의로 60% 커버되게 흩뿌림.
  const items = Array.from({ length: count }).map((_, i) => {
    const start = (i / count) * 100 + (i * 3.1) % 4;
    const width = 100 / count / 1.4;
    return { start, width, key: i };
  });
  return items.map((s, i) => (
    <motion.div
      key={s.key}
      className={styles.subBlock}
      style={{
        left: `${Math.min(s.start, 96)}%`,
        width: `${s.width}%`,
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{
        duration: 0.24,
        delay: 0.015 * i,
      }}
    />
  ));
}
