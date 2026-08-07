"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import {
  Check,
  Film,
  ScanLine,
  ListChecks,
  ShieldCheck,
  Loader2,
  Wand2,
} from "lucide-react";
import type { StreamItem } from "../state";
import { formatDuration } from "@/lib/format";
import styles from "./rows.module.css";

const PHASE_ICON: Record<string, typeof Film> = {
  pending: Loader2,
  analysis: ScanLine,
  script: Wand2,
  interrupt_gate: ListChecks,
  supervisor: Film,
  critic: ShieldCheck,
};

const PHASE_TINT: Record<string, string> = {
  pending: "var(--text-3)",
  analysis: "#7c8df1",
  script: "#c084fc",
  interrupt_gate: "#f0a76f",
  supervisor: "#7c8df1",
  critic: "#3ecf8e",
};

export function PhaseCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "phase" }>;
}) {
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (item.state !== "running") return;
    const t = setInterval(() => setTick(Date.now()), 100);
    return () => clearInterval(t);
  }, [item.state]);

  const elapsed =
    item.state === "running"
      ? tick - item.startedAt
      : (item.endedAt ?? item.startedAt) - item.startedAt;

  const Icon = PHASE_ICON[item.phase] ?? Film;
  const tint = PHASE_TINT[item.phase] ?? "var(--accent-strong)";
  const running = item.state === "running";

  return (
    <motion.div
      className={styles.phaseCard}
      data-state={item.state}
      layout
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 32, mass: 0.6 }}
      style={{ ["--phase-tint" as string]: tint }}
    >
      {/* Shimmer stripe — 실행 중일 때만 */}
      {running && (
        <motion.div
          className={styles.phaseShimmer}
          animate={{ x: ["-40%", "140%"] }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: [0.4, 0, 0.2, 1],
          }}
        />
      )}

      <div className={styles.phaseHead}>
        <motion.div
          className={styles.phaseIcon}
          animate={
            running
              ? item.phase === "pending"
                ? { rotate: 360 }
                : {
                    scale: [1, 1.12, 1],
                    opacity: [0.85, 1, 0.85],
                  }
              : { scale: 1, opacity: 1 }
          }
          transition={
            running
              ? item.phase === "pending"
                ? { duration: 0.9, repeat: Infinity, ease: "linear" }
                : { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.24 }
          }
        >
          {item.state === "done" ? (
            <motion.span
              className={styles.phaseCheck}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 15 }}
            >
              <Check size={11} strokeWidth={3} />
            </motion.span>
          ) : (
            <Icon size={13} strokeWidth={2} />
          )}
        </motion.div>

        <div className={styles.phaseMeta}>
          <div className={styles.phaseLabel}>{item.label}</div>
          <div className={styles.phaseDetail}>{item.detail}</div>
        </div>

        <div className={styles.phaseElapsed}>
          {running && (
            <motion.span
              className={styles.phaseLiveDot}
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 1.2, repeat: Infinity }}
            />
          )}
          <span className={styles.tabular}>{formatDuration(elapsed)}</span>
        </div>
      </div>

      {/* progress bar 하단 — 실행 중일 때 indeterminate */}
      {running && (
        <div className={styles.phaseTrack}>
          <motion.div
            className={styles.phaseTrackFill}
            animate={{ x: ["-100%", "100%"] }}
            transition={{
              duration: 1.6,
              repeat: Infinity,
              ease: [0.4, 0, 0.2, 1],
            }}
          />
        </div>
      )}
    </motion.div>
  );
}
