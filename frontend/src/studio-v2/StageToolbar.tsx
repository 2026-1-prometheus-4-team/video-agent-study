"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useAgentStore } from "./state";
import styles from "./stage-toolbar.module.css";

const CONNECTION_LABEL: Record<string, string> = {
  online: "연결됨",
  connecting: "연결 중",
  reconnecting: "재연결 중",
  offline: "오프라인",
};

/**
 * StageToolbar — 스테이지 우상단 미니 툴바.
 * 세션 정보 · 연결 상태 · 모션 에디터 링크.
 * 얇고 절제된, 시선을 뺏지 않는 chrome.
 */
export function StageToolbar() {
  const connection = useAgentStore((s) => s.connection);
  const sessionId = useAgentStore((s) => s.sessionId);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);

  return (
    <div className={styles.wrap}>
      <SessionPill sessionId={sessionId} status={sessionStatus} />
      <ConnectionPill status={connection} />
      <Link href="/motion" className={styles.link} title="심화 편집기">
        <span>모션 에디터</span>
        <ArrowUpRight size={11} strokeWidth={2.2} />
      </Link>
    </div>
  );
}

function ConnectionPill({ status }: { status: string }) {
  const isOnline = status === "online";
  const isOffline = status === "offline";

  return (
    <div
      className={styles.connect}
      data-online={isOnline || undefined}
      data-offline={isOffline || undefined}
      title={CONNECTION_LABEL[status]}
    >
      <motion.span
        className={styles.dot}
        animate={
          isOnline
            ? { opacity: [0.7, 1, 0.7] }
            : isOffline
              ? { opacity: [0.5, 1, 0.5] }
              : { opacity: 0.6 }
        }
        transition={{
          duration: isOffline ? 1.2 : 2.4,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      <span className={styles.connectLabel}>{CONNECTION_LABEL[status]}</span>
    </div>
  );
}

function SessionPill({
  sessionId,
  status,
}: {
  sessionId: string | null;
  status: string;
}) {
  const statusLabel =
    status === "streaming"
      ? "실행 중"
      : status === "awaiting-interrupt"
        ? "승인 대기"
        : status === "completed"
          ? "완료"
          : status === "error"
            ? "오류"
            : "대기";
  const active =
    status === "streaming" ||
    status === "awaiting-interrupt";

  if (!sessionId) {
    return (
      <div className={styles.session} data-empty>
        <span className={styles.sessionEmpty}>세션 없음</span>
      </div>
    );
  }

  return (
    <div className={styles.session} data-active={active || undefined}>
      <span className={styles.sessionMono}>{sessionId}</span>
      <span className={styles.sessionSep} />
      <span className={styles.sessionStatus}>{statusLabel}</span>
    </div>
  );
}
