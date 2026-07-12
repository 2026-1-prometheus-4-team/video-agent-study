"use client";

import { Paperclip } from "lucide-react";
import type { StreamItem } from "../state";
import styles from "./rows.module.css";

export function UserBubble({
  item,
}: {
  item: Extract<StreamItem, { kind: "user" }>;
}) {
  return (
    <div className={styles.userRow}>
      <div className={styles.userBubble}>
        {item.files && item.files.length > 0 && (
          <div className={styles.attach}>
            <Paperclip size={11} />
            <span>{item.files[0]}</span>
            {item.files.length > 1 && (
              <span className={styles.attachMore}>+{item.files.length - 1}</span>
            )}
          </div>
        )}
        <div className={styles.userText}>{item.text}</div>
      </div>
    </div>
  );
}
