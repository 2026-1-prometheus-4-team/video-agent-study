"use client";

import { motion } from "motion/react";
import { useAgentStore, type Node } from "./state";
import styles from "./hud.module.css";

const NODES: { key: Node; label: string }[] = [
  { key: "orchestrator", label: "총괄" },
  { key: "research", label: "리서치" },
  { key: "planning", label: "기획" },
  { key: "edit", label: "편집" },
  { key: "critic", label: "검증" },
];

export function PipelineHUD() {
  const activeNode = useAgentStore((s) => s.activeNode);
  const nodeToolCount = useAgentStore((s) => s.nodeToolCount);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);

  const visible =
    sessionStatus === "streaming" ||
    sessionStatus === "awaiting-interrupt" ||
    activeNode !== null;

  if (!visible) return null;

  return (
    <motion.div
      className={styles.hud}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className={styles.title}>파이프라인</div>
      <div className={styles.nodes}>
        {NODES.map((n, i) => {
          const active = activeNode === n.key;
          const count = nodeToolCount[n.key];
          return (
            <div key={n.key} className={styles.nodeCol}>
              <motion.div
                className={styles.node}
                data-active={active || undefined}
                animate={
                  active
                    ? {
                        boxShadow: [
                          "0 0 0 1px rgba(124, 141, 241, 0.4)",
                          "0 0 0 2px rgba(124, 141, 241, 0.6), 0 0 0 6px rgba(124, 141, 241, 0.12)",
                          "0 0 0 1px rgba(124, 141, 241, 0.4)",
                        ],
                      }
                    : undefined
                }
                transition={{
                  duration: 1.6,
                  repeat: active ? Infinity : 0,
                  ease: [0.4, 0, 0.6, 1],
                }}
              >
                {n.label}
              </motion.div>
              {count > 0 && (
                <div className={styles.nodeCount}>
                  <span className={styles.tabular}>{count}</span>
                </div>
              )}
              {i < NODES.length - 1 && (
                <div className={styles.connector} data-lit={active || undefined} />
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
