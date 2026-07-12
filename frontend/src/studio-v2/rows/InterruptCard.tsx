"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Check, MessageSquare, Sparkles } from "lucide-react";
import type { StreamItem } from "../state";
import { useAgentStore } from "../state";
import { playApprovedContinuation } from "../mock/mockStream";
import styles from "./rows.module.css";

const NODE_LABEL: Record<string, string> = {
  orchestrator: "총괄",
  research: "리서치",
  planning: "기획",
  edit: "편집",
  critic: "검증",
};

export function InterruptCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "interrupt" }>;
}) {
  const resolve = useAgentStore((s) => s.resolveInterrupt);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const resolved = item.resolved;

  const approve = () => {
    if (resolved) return;
    resolve(true);
    void playApprovedContinuation();
  };

  const submitFeedback = () => {
    if (!feedback.trim() || resolved) return;
    resolve(false, feedback.trim());
    setFeedback("");
    setShowFeedback(false);
  };

  useHotkeys(
    "meta+enter, ctrl+enter",
    () => {
      if (showFeedback) submitFeedback();
      else approve();
    },
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
    [showFeedback, feedback]
  );

  return (
    <motion.div
      className={styles.interruptCard}
      data-resolved={resolved || undefined}
      initial={{ opacity: 0, y: -12, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        type: "spring",
        stiffness: 300,
        damping: 32,
        mass: 0.9,
      }}
    >
      <div className={styles.interruptHeader}>
        <motion.span
          className={styles.interruptDot}
          animate={
            !resolved
              ? { scale: [1, 1.35, 1], opacity: [0.6, 1, 0.6] }
              : { scale: 1 }
          }
          transition={{
            duration: 1.6,
            repeat: !resolved ? Infinity : 0,
            ease: "easeInOut",
          }}
        />
        <div className={styles.interruptTitle}>
          {resolved === "approved"
            ? "계획 승인됨"
            : resolved === "revised"
              ? "수정 요청됨"
              : "계획 검토가 필요해"}
        </div>
        {!resolved && (
          <div className={styles.interruptHint}>
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
          </div>
        )}
      </div>

      <div className={styles.interruptSub}>
        <Sparkles size={11} className={styles.interruptSubIcon} />
        <span>총 {item.plan.length}단계 · 예상 실행 시간 약 {estTotal(item.plan)}초</span>
      </div>

      <div className={styles.planList}>
        {item.plan.map((step, idx) => (
          <div key={step.id} className={styles.planStep}>
            <div className={styles.planStepIdx}>{idx + 1}</div>
            <div className={styles.planStepBody}>
              <div className={styles.planStepTitle}>
                <span className={styles.planStepAction}>{step.action}</span>
                <span className={styles.planStepNode}>
                  {NODE_LABEL[step.expert]}
                </span>
                {step.estimatedSec && (
                  <span className={styles.planStepEst}>~{step.estimatedSec}s</span>
                )}
              </div>
              <div className={styles.planStepReason}>{step.rationale}</div>
              {step.parallelGroup && (
                <div className={styles.planStepBadge}>병렬 실행</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {!resolved && (
        <div className={styles.interruptFoot}>
          {showFeedback ? (
            <>
              <textarea
                className={styles.interruptInput}
                placeholder="어떻게 수정할까?"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={2}
                autoFocus
              />
              <div className={styles.interruptActions}>
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={() => {
                    setShowFeedback(false);
                    setFeedback("");
                  }}
                >
                  취소
                </button>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={submitFeedback}
                  disabled={!feedback.trim()}
                >
                  피드백 전송
                </button>
              </div>
            </>
          ) : (
            <div className={styles.interruptActions}>
              <button
                type="button"
                className={styles.btnGhost}
                onClick={() => setShowFeedback(true)}
              >
                <MessageSquare size={12} />
                <span>수정 요청</span>
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={approve}
              >
                <Check size={12} />
                <span>이대로 진행</span>
              </button>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function estTotal(plan: { estimatedSec?: number }[]) {
  return plan.reduce((sum, p) => sum + (p.estimatedSec ?? 0), 0);
}
