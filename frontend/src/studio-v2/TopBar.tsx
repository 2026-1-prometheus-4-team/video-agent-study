"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen, Menu, Sparkles } from "lucide-react";
import { useAgentStore } from "./state";
import styles from "./topbar.module.css";

interface TopBarProps {
  onToggleSidebar: () => void;
  onOpenMobileSidebar: () => void;
}

const CONNECTION_LABEL: Record<string, string> = {
  online: "연결됨",
  connecting: "연결 중",
  reconnecting: "재연결 중",
  offline: "오프라인",
};

export function TopBar({ onToggleSidebar, onOpenMobileSidebar }: TopBarProps) {
  const connection = useAgentStore((s) => s.connection);
  const sessionId = useAgentStore((s) => s.sessionId);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {/* Mobile hamburger */}
        <button
          type="button"
          className={styles.iconBtn + " " + styles.mobileOnly}
          onClick={onOpenMobileSidebar}
          aria-label="사이드바 열기"
        >
          <Menu size={18} />
        </button>

        {/* Desktop collapse */}
        <button
          type="button"
          className={styles.iconBtn + " " + styles.desktopOnly}
          onClick={onToggleSidebar}
          aria-label="사이드바 접기/펴기 (⌘B)"
          title="⌘B"
        >
          <PanelLeftClose size={16} className={styles.collapseIcon} />
          <PanelLeftOpen size={16} className={styles.expandIcon} />
        </button>

        <div className={styles.brand}>
          <div className={styles.brandMark}>
            <Sparkles size={12} strokeWidth={2.2} />
          </div>
          <div className={styles.brandText}>Video Agent</div>
        </div>
      </div>

      <div className={styles.center}>
        <SessionPill sessionId={sessionId} status={sessionStatus} />
      </div>

      <div className={styles.right}>
        <ConnectionPill status={connection} />

        <Link
          href="/motion"
          className={styles.motionLink}
          title="심화 편집기 (모션 에디터)"
        >
          <span>모션 에디터</span>
        </Link>
      </div>
    </div>
  );
}

function ConnectionPill({ status }: { status: string }) {
  const isOnline = status === "online";
  const isOffline = status === "offline";

  return (
    <div
      className={styles.connectPill}
      data-online={isOnline || undefined}
      data-offline={isOffline || undefined}
    >
      <motion.span
        className={styles.connectDot}
        animate={
          isOnline
            ? { scale: [1, 1.15, 1], opacity: [0.85, 1, 0.85] }
            : isOffline
              ? { opacity: [0.6, 1, 0.6] }
              : {}
        }
        transition={
          isOnline
            ? { duration: 2.4, repeat: Infinity, ease: "easeInOut" }
            : isOffline
              ? { duration: 1.2, repeat: Infinity, ease: "easeInOut" }
              : {}
        }
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

  return (
    <div className={styles.sessionPill} data-active={active || undefined}>
      {sessionId ? (
        <>
          <span className={styles.sessionMono}>{sessionId}</span>
          <span className={styles.sessionDot} />
          <span className={styles.sessionStatus}>{statusLabel}</span>
        </>
      ) : (
        <span className={styles.sessionEmpty}>세션 없음</span>
      )}
    </div>
  );
}
