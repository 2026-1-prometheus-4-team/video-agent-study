"use client";

import { motion } from "motion/react";
import { AlertCircle, CheckCircle2, Film, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import type { StreamItem } from "../state";
import { formatSeconds } from "@/lib/format";
import styles from "./rows.module.css";

export function FinalCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "final" }>;
}) {
  const router = useRouter();

  const onRefine = () => {
    // 우리 프로젝트 전용 모션 에디터 (studio-v2 store 를 그대로 참조).
    router.push("/motion");
  };

  const onRetry = () => {
    const prompt = item.criticNote
      ? `미완료된 편집을 이어서 완료해줘. 이전 오류: ${item.criticNote}`
      : "미완료된 편집 단계부터 다시 실행해서 최종 결과물을 완성해줘.";
    window.dispatchEvent(new CustomEvent("va:fill-composer", { detail: prompt }));
  };

  return (
    <motion.div
      className={`${styles.finalCard} ${item.success === false ? styles.finalCardFailed : ""}`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        type: "spring",
        stiffness: 320,
        damping: 28,
        mass: 0.7,
      }}
    >
      <div className={styles.finalHeader}>
        <div className={item.success === false ? styles.finalFailed : styles.finalCheck}>
          {item.success === false ? (
            <AlertCircle size={14} strokeWidth={2.4} />
          ) : (
            <CheckCircle2 size={14} strokeWidth={2.4} />
          )}
        </div>
        <div className={styles.finalTitle}>
          {item.success === false ? "편집 미완료" : "편집 완료"}
        </div>
        <div className={styles.finalDuration}>
          {formatSeconds(item.duration, false)}
        </div>
      </div>

      <div className={styles.finalPath}>{item.outputPath}</div>

      {item.criticNote && (
        <div className={styles.finalNote}>{item.criticNote}</div>
      )}

      <div className={styles.finalActions}>
        <button type="button" className={styles.btnGhost} onClick={onRetry}>
          <PenLine size={12} />
          <span>다시 편집</span>
        </button>
        <button
          type="button"
          className={styles.finalMotionLink}
          onClick={onRefine}
        >
          <Film size={12} />
          <span>모션 에디터에서 다듬기</span>
        </button>
      </div>
    </motion.div>
  );
}
