"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { CheckCircle2, Film, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { StreamItem } from "../state";
import { useAgentStore } from "../state";
import { planRefine, saveRefineSpec } from "../refine";
import { formatSeconds } from "@/lib/format";
import styles from "./rows.module.css";

const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

export function FinalCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "final" }>;
}) {
  const router = useRouter();
  const [refining, setRefining] = useState(false);
  const uploadedUrl = useAgentStore((s) => s.uploadedUrl);
  const serverVideoPath = useAgentStore((s) => s.serverVideoPath);
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);

  const onRefine = async () => {
    if (refining) return;
    setRefining(true);
    const plan = planRefine({
      lastFinal,
      uploadedUrl,
      serverVideoPath,
      videoContext,
      apiBase: API_BASE,
    });
    if (!plan) {
      toast.error("열 수 있는 영상이 없어요");
      setRefining(false);
      return;
    }
    try {
      const link = await saveRefineSpec(plan);
      toast.success("모션 에디터 열기", { description: plan.label });
      router.push(link);
    } catch (err) {
      toast.error("spec 저장 실패", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefining(false);
    }
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
          disabled={refining}
        >
          <Film size={12} />
          <span>{refining ? "여는 중…" : "모션 에디터에서 다듬기"}</span>
        </button>
      </div>
    </motion.div>
  );
}
