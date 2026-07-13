"use client";

import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import { Type } from "lucide-react";
import { useAgentStore } from "@/studio-v2/state";
import { useEditorStore } from "./editorState";
import { formatSeconds } from "@/lib/format";
import styles from "./subtitle-list.module.css";

export function SubtitleList() {
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const overrides = useEditorStore((s) => s.subtitleOverrides);
  const selectionKind = useEditorStore((s) => s.selectionKind);
  const selectionIndex = useEditorStore((s) => s.selectionIndex);
  const select = useEditorStore((s) => s.select);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);

  const transcript = useMemo(() => {
    const src = videoContext?.transcript ?? lastFinal?.transcript ?? [];
    return src;
  }, [videoContext, lastFinal]);

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Type size={12} strokeWidth={2.2} />
          <span>자막</span>
        </div>
        <span className={styles.headerMeta}>{transcript.length}</span>
      </div>

      {transcript.length === 0 ? (
        <div className={styles.empty}>
          자막이 아직 없어. 스튜디오에서 편집을 완료하면 여기에 표시돼.
        </div>
      ) : (
        <div className={styles.list}>
          <AnimatePresence initial={false}>
            {transcript.map((seg, i) => {
              const override = overrides[i];
              const displayText = override?.text ?? seg.text;
              const isSelected =
                selectionKind === "subtitle" && selectionIndex === i;
              const isEdited = !!override;

              return (
                <motion.button
                  key={i}
                  type="button"
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className={styles.row}
                  data-selected={isSelected || undefined}
                  data-edited={isEdited || undefined}
                  onClick={() => {
                    select("subtitle", i);
                    setPlayhead(seg.start);
                  }}
                >
                  <div className={styles.rowMeta}>
                    <span className={styles.rowTime}>
                      {formatSeconds(seg.start)}
                    </span>
                    {isEdited && <span className={styles.editedDot} />}
                  </div>
                  <div className={styles.rowText}>{displayText}</div>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
