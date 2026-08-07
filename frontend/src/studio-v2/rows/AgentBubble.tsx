"use client";

import { motion } from "motion/react";
import { Check, X, Bot } from "lucide-react";
import type { StreamItem } from "../state";
import { Markdown } from "../Markdown";
import styles from "./rows.module.css";

const NODE_LABEL: Record<string, string> = {
  orchestrator: "총괄",
  research: "리서치",
  planning: "기획",
  edit: "편집",
  critic: "검증",
};

const EXPERT_LABEL: Record<string, string> = {
  edit_expert: "편집",
  text_expert: "자막",
  audio_expert: "오디오",
  effect_expert: "이팩트",
  research_expert: "리서치",
};

// sub-agent 리턴 텍스트 관습: "[<expert>] status=<ok|error> (<X>s)\n<body>"
const EXPERT_HEADER_RE =
  /^\[(\w+_expert)\]\s+status=(ok|error)\s+\(([\d.]+)s\)\s*\n?/;

interface ExpertHeader {
  expert: string;
  ok: boolean;
  seconds: number;
  body: string;
}

function parseExpertHeader(text: string): ExpertHeader | null {
  const m = text.match(EXPERT_HEADER_RE);
  if (!m) return null;
  return {
    expert: m[1],
    ok: m[2] === "ok",
    seconds: parseFloat(m[3]),
    body: text.slice(m[0].length),
  };
}

export function AgentBubble({
  item,
}: {
  item: Extract<StreamItem, { kind: "agent" }>;
}) {
  const header = parseExpertHeader(item.text);

  return (
    <div className={styles.agentRow}>
      {item.node && (
        <div className={styles.agentTag}>{NODE_LABEL[item.node]}</div>
      )}
      {header && (
        <motion.div
          className={styles.expertHeader}
          data-ok={header.ok || undefined}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className={styles.expertIcon}>
            {header.ok ? (
              <Check size={11} strokeWidth={3} />
            ) : (
              <X size={11} strokeWidth={3} />
            )}
          </div>
          <div className={styles.expertLabel}>
            <Bot
              size={10}
              strokeWidth={2.2}
              className={styles.expertSpark}
            />
            <span className={styles.expertName}>
              {EXPERT_LABEL[header.expert] ?? header.expert}
            </span>
            <span className={styles.expertName2}>
              · {header.expert}
            </span>
          </div>
          <div className={styles.expertDur}>
            <span className={styles.tabular}>{header.seconds.toFixed(1)}</span>
            <span className={styles.expertDurSuffix}>s</span>
          </div>
        </motion.div>
      )}
      <div className={styles.agentText}>
        <Markdown text={header ? header.body : item.text} />
        {item.streaming && (
          <motion.span
            className={styles.caret}
            animate={{ opacity: [1, 0.2, 1] }}
            transition={{ duration: 0.9, repeat: Infinity }}
          />
        )}
      </div>
    </div>
  );
}
