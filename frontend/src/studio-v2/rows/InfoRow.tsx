"use client";

import type { StreamItem } from "../state";
import styles from "./rows.module.css";

export function InfoRow({
  item,
}: {
  item: Extract<StreamItem, { kind: "info" }>;
}) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoDot} />
      <span className={styles.infoText}>{item.text}</span>
    </div>
  );
}
