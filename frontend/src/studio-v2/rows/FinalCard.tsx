"use client";

import { motion } from "motion/react";
import { CheckCircle2, Film, PenLine } from "lucide-react";
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

  return (
    <motion.div
      className={styles.finalCard}
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
        <div className={styles.finalCheck}>
          <CheckCircle2 size={14} strokeWidth={2.4} />
        </div>
        <div className={styles.finalTitle}>편집 완료</div>
        <div className={styles.finalDuration}>
          {formatSeconds(item.duration, false)}
        </div>
      </div>

      <div className={styles.finalPath}>{item.outputPath}</div>

      {item.criticNote && (
        <div className={styles.finalNote}>{item.criticNote}</div>
      )}

      <div className={styles.finalActions}>
        <button type="button" className={styles.btnGhost}>
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
