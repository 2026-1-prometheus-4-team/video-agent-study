"use client";

import { motion } from "motion/react";
import { AlertTriangle } from "lucide-react";
import type { StreamItem } from "../state";
import styles from "./rows.module.css";

export function ErrorRow({
  item,
}: {
  item: Extract<StreamItem, { kind: "error" }>;
}) {
  return (
    <motion.div
      className={styles.errorRow}
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2 }}
    >
      <AlertTriangle size={12} className={styles.errorIcon} />
      <div className={styles.errorBody}>
        <div className={styles.errorTitle}>{item.title}</div>
        {item.detail && <div className={styles.errorDetail}>{item.detail}</div>}
      </div>
    </motion.div>
  );
}
