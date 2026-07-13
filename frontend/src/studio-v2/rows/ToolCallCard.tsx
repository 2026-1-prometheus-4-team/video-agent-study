"use client";

import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import type { StreamItem } from "../state";
import { Markdown } from "../Markdown";
import { formatDuration } from "@/lib/format";
import styles from "./rows.module.css";

const NODE_LABEL: Record<string, string> = {
  orchestrator: "총괄",
  research: "리서치",
  planning: "기획",
  edit: "편집",
  critic: "검증",
};

export function ToolCallCard({
  item,
}: {
  item: Extract<StreamItem, { kind: "tool" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tick, setTick] = useState(Date.now());

  useEffect(() => {
    if (item.state !== "running") return;
    const t = setInterval(() => setTick(Date.now()), 100);
    return () => clearInterval(t);
  }, [item.state]);

  const durationMs =
    item.state === "running"
      ? tick - item.startedAt
      : (item.endedAt ?? item.startedAt) - item.startedAt;

  return (
    <motion.div
      className={styles.toolCard}
      data-state={item.state}
      layout
      animate={
        item.state === "running"
          ? {
              boxShadow: [
                "0 0 0 1px var(--hairline)",
                "0 0 0 1px rgba(124, 141, 241, 0.35), 0 0 0 4px rgba(124, 141, 241, 0.08)",
                "0 0 0 1px var(--hairline)",
              ],
            }
          : undefined
      }
      transition={
        item.state === "running"
          ? { duration: 1.8, repeat: Infinity, ease: [0.4, 0, 0.6, 1] }
          : { duration: 0.16 }
      }
    >
      <button
        type="button"
        className={styles.toolHeader}
        onClick={() => setExpanded((e) => !e)}
      >
        <div className={styles.toolLeftIcon}>
          {item.state === "running" ? (
            <motion.span
              className={styles.spinner}
              animate={{ rotate: 360 }}
              transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
            />
          ) : item.state === "success" ? (
            <motion.span
              className={styles.checkMark}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{
                type: "spring",
                stiffness: 500,
                damping: 15,
              }}
            >
              <Check size={11} strokeWidth={3} />
            </motion.span>
          ) : (
            <span className={styles.errorMark}>
              <X size={11} strokeWidth={3} />
            </span>
          )}
        </div>

        <div className={styles.toolMeta}>
          <div className={styles.toolTitleRow}>
            <span className={styles.toolNodeTag}>{NODE_LABEL[item.node]}</span>
            <span className={styles.toolName}>{item.tool}</span>
          </div>
          <div className={styles.toolSubRow}>
            <span className={styles.toolDuration}>
              {item.state === "running" ? "실행 중" : ""}
              <span className={styles.tabular}>{formatDuration(durationMs)}</span>
            </span>
            {item.state === "error" && item.errorMessage && (
              <span className={styles.toolErrorSub}>{item.errorMessage}</span>
            )}
          </div>
        </div>

        <ChevronRight
          size={12}
          className={styles.chev}
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
      </button>

      {expanded && (
        <motion.div
          className={styles.toolBody}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
        >
          <div className={styles.toolSection}>
            <div className={styles.toolSectionLabel}>인자</div>
            <ToolValue value={item.args} />
          </div>
          {item.result !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>결과</div>
              <ToolValue value={item.result} />
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

/**
 * tool 의 args / result 를 상황에 맞게 렌더.
 * - string 이면 Markdown 으로 (자연어 답변 · 요약)
 * - object 이면 JSON 코드 블록으로
 * - null/undefined 는 표시 X
 */
function ToolValue({ value }: { value: unknown }) {
  const rendered = useMemo(() => {
    if (value == null) return null;
    if (typeof value === "string") {
      // 문자열이 JSON 처럼 생겼으면 파싱해서 pretty print, 아니면 그대로 md
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          const parsed = JSON.parse(trimmed);
          return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
        } catch {
          return value;
        }
      }
      return value;
    }
    return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
  }, [value]);

  if (rendered == null) return null;
  return <Markdown text={rendered} />;
}
