"use client";

import { motion } from "motion/react";
import { useMemo, useRef } from "react";
import { useAgentStore } from "@/studio-v2/state";
import { useEditorStore } from "./editorState";
import { formatSeconds } from "@/lib/format";
import styles from "./editor-timeline.module.css";

export function EditorTimeline() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const playhead = useEditorStore((s) => s.playhead);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const selectionKind = useEditorStore((s) => s.selectionKind);
  const selectionIndex = useEditorStore((s) => s.selectionIndex);
  const select = useEditorStore((s) => s.select);

  const duration = videoContext?.duration ?? lastFinal?.duration ?? 0;
  const scenes = videoContext?.scenes ?? lastFinal?.scenes ?? [];
  const transcript = videoContext?.transcript ?? lastFinal?.transcript ?? [];

  const rulerTicks = useMemo(() => {
    if (duration <= 0) return [];
    const targetCount = 8;
    const stepBase = duration / targetCount;
    // 예쁜 step (1, 2, 5, 10, ...)
    const magnitude = Math.pow(10, Math.floor(Math.log10(stepBase)));
    const norm = stepBase / magnitude;
    const step =
      (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
    const ticks: number[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) {
      ticks.push(t);
    }
    return ticks;
  }, [duration]);

  const trackRef = useRef<HTMLDivElement | null>(null);

  const onScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = trackRef.current;
    if (!el || duration <= 0) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number) => {
      const rect = el.getBoundingClientRect();
      const pct = Math.max(0, Math.min((clientX - rect.left) / rect.width, 1));
      setPlayhead(pct * duration);
    };
    move(e.clientX);

    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const playPct = duration ? (playhead / duration) * 100 : 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.title}>타임라인</div>
        {duration > 0 ? (
          <div className={styles.meta}>
            <span className={styles.tabular}>{duration.toFixed(1)}</span>
            <span className={styles.metaSuffix}>s</span>
            <span className={styles.sep} />
            <span>{scenes.length} 씬</span>
            <span className={styles.sep} />
            <span>{transcript.length} 자막</span>
          </div>
        ) : (
          <div className={styles.metaHint}>편집할 데이터가 없어</div>
        )}
      </div>

      <div className={styles.body}>
        {/* Ruler */}
        <div className={styles.ruler}>
          {rulerTicks.map((t) => (
            <div
              key={t}
              className={styles.rulerTick}
              style={{
                left: `${duration ? (t / duration) * 100 : 0}%`,
              }}
            >
              <span className={styles.rulerLabel}>{formatSeconds(t, false)}</span>
            </div>
          ))}
        </div>

        {/* Scene track */}
        <div className={styles.trackRow}>
          <div className={styles.trackLabel}>씬</div>
          <div className={styles.track}>
            {scenes.map((sc, i) => {
              const left = duration ? (sc.start / duration) * 100 : 0;
              const width = duration
                ? Math.max(0.6, ((sc.end - sc.start) / duration) * 100 - 0.4)
                : 0;
              const isSelected =
                selectionKind === "scene" && selectionIndex === i;
              return (
                <motion.button
                  key={i}
                  type="button"
                  className={styles.sceneBlock}
                  data-selected={isSelected || undefined}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    select("scene", i);
                    setPlayhead(sc.start);
                  }}
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: 0.02 * i }}
                />
              );
            })}
          </div>
        </div>

        {/* Subtitle track */}
        <div className={styles.trackRow}>
          <div className={styles.trackLabel}>자막</div>
          <div className={styles.track}>
            {transcript.map((seg, i) => {
              const left = duration ? (seg.start / duration) * 100 : 0;
              const width = duration
                ? Math.max(0.4, ((seg.end - seg.start) / duration) * 100 - 0.3)
                : 0;
              const isSelected =
                selectionKind === "subtitle" && selectionIndex === i;
              return (
                <motion.button
                  key={i}
                  type="button"
                  className={styles.subBlock}
                  data-selected={isSelected || undefined}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    select("subtitle", i);
                    setPlayhead(seg.start);
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2, delay: 0.012 * i }}
                />
              );
            })}
          </div>
        </div>

        {/* Playhead + scrubber overlay */}
        <div
          ref={trackRef}
          className={styles.scrubOverlay}
          onPointerDown={onScrub}
        >
          <div
            className={styles.playhead}
            style={{ left: `${playPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
