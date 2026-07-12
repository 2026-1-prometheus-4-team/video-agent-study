"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { useAgentStore } from "./state";
import { UserBubble } from "./rows/UserBubble";
import { AgentBubble } from "./rows/AgentBubble";
import { ToolCallCard } from "./rows/ToolCallCard";
import { InterruptCard } from "./rows/InterruptCard";
import { FinalCard } from "./rows/FinalCard";
import { InfoRow } from "./rows/InfoRow";
import { ErrorRow } from "./rows/ErrorRow";
import styles from "./thread.module.css";

/**
 * ThreadStream — 채팅 + 활동 흐름 통합 스트림.
 *
 * 각 StreamItem 을 layout-animated 카드로 렌더.
 * 하단 자동 스크롤 (스크롤이 아래에 있을 때만).
 */
export function ThreadStream() {
  const stream = useAgentStore((s) => s.stream);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // 자동 스크롤
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [stream.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = gap < 48;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={styles.wrap}>
      <div ref={containerRef} className={styles.scroll}>
        <div className={styles.spacer} />
        <AnimatePresence initial={false} mode="popLayout">
          {stream.map((item) => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{
                type: "spring",
                stiffness: 320,
                damping: 30,
                mass: 0.6,
              }}
              className={styles.row}
            >
              {renderRow(item)}
            </motion.div>
          ))}
        </AnimatePresence>
        <div className={styles.bottomAnchor} />
      </div>
    </div>
  );
}

function renderRow(item: ReturnType<typeof useAgentStore.getState>["stream"][number]) {
  switch (item.kind) {
    case "user":
      return <UserBubble item={item} />;
    case "agent":
      return <AgentBubble item={item} />;
    case "tool":
      return <ToolCallCard item={item} />;
    case "interrupt":
      return <InterruptCard item={item} />;
    case "final":
      return <FinalCard item={item} />;
    case "info":
      return <InfoRow item={item} />;
    case "error":
      return <ErrorRow item={item} />;
  }
}
