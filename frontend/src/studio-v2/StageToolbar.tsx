"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { useAgentStore } from "./state";
import { planRefine, saveRefineSpec } from "./refine";
import styles from "./stage-toolbar.module.css";

const API_BASE = (
  process.env.NEXT_PUBLIC_AGENT_API || "http://localhost:8000"
).replace(/\/+$/, "");

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
  const uploadedUrl = useAgentStore((s) => s.uploadedUrl);
  const serverVideoPath = useAgentStore((s) => s.serverVideoPath);
  const videoContext = useAgentStore((s) => s.videoContext);
  const lastFinal = useAgentStore((s) => s.lastFinal);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const openMotionEditor = async (
    e: React.MouseEvent<HTMLAnchorElement>
  ) => {
    e.preventDefault();
    if (busy) return;

    const plan = planRefine({
      lastFinal,
      uploadedUrl,
      serverVideoPath,
      videoContext,
      apiBase: API_BASE,
    });

    // 편집 컨텍스트 없으면 빈 에디터로.
    if (!plan) {
      router.push("/motion");
      return;
    }

    setBusy(true);
    try {
      const link = await saveRefineSpec(plan);
      toast.success("모션 에디터 열기", { description: plan.label });
      router.push(link);
    } catch (err) {
      toast.error("spec 저장 실패, 빈 에디터로 열기", {
        description: err instanceof Error ? err.message : String(err),
      });
      router.push("/motion");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <SessionPill sessionId={sessionId} status={sessionStatus} />
      <ConnectionPill status={connection} />
      <a
        href="/motion"
        onClick={openMotionEditor}
        className={styles.link}
        title={
          uploadedUrl || lastFinal
            ? "현재 편집 컨텍스트로 모션 에디터 열기"
            : "심화 편집기"
        }
      >
        <span>{busy ? "여는 중…" : "모션 에디터"}</span>
        <ArrowUpRight size={11} strokeWidth={2.2} />
      </a>
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
