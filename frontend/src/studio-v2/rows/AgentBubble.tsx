"use client";

import { motion } from "motion/react";
import type { StreamItem } from "../state";
import styles from "./rows.module.css";

const NODE_LABEL: Record<string, string> = {
  orchestrator: "총괄",
  research: "리서치",
  planning: "기획",
  edit: "편집",
  critic: "검증",
};

export function AgentBubble({
  item,
}: {
  item: Extract<StreamItem, { kind: "agent" }>;
}) {
  const paragraphs = item.text.split("\n\n");

  return (
    <div className={styles.agentRow}>
      {item.node && (
        <div className={styles.agentTag}>{NODE_LABEL[item.node]}</div>
      )}
      <div className={styles.agentText}>
        {paragraphs.map((p, i) => (
          <div key={i} className={styles.agentPara}>
            {renderInline(p)}
            {item.streaming && i === paragraphs.length - 1 && (
              <motion.span
                className={styles.caret}
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 0.9, repeat: Infinity }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderInline(text: string) {
  // 아주 얇은 markdown: **bold** 만 처리
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className={styles.agentStrong}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
