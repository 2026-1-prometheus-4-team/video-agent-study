"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ThreadStream } from "./ThreadStream";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { useAgentStore } from "./state";
import styles from "./sidebar.module.css";

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleCollapse: () => void;
}

export function Sidebar({
  collapsed,
  mobileOpen,
  onCloseMobile,
  onToggleCollapse,
}: SidebarProps) {
  const streamLength = useAgentStore((s) => s.stream.length);
  const activeNode = useAgentStore((s) => s.activeNode);
  const isEmpty = streamLength === 0;

  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseMobile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {/* Desktop sidebar (motion width) */}
      <motion.aside
        className={styles.sidebar}
        data-collapsed={collapsed}
        initial={false}
        animate={{
          width: collapsed ? 64 : 384,
        }}
        transition={{
          type: "spring",
          stiffness: 320,
          damping: 32,
          mass: 0.8,
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {!collapsed ? (
            <motion.div
              key="content"
              className={styles.content}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, delay: 0.08 }}
            >
              <SidebarHeader
                collapsed={false}
                onToggle={onToggleCollapse}
                activePulse={!!activeNode}
              />

              <div className={styles.body}>
                {isEmpty ? <EmptyState /> : <ThreadStream />}
              </div>

              <div className={styles.foot}>
                <Composer />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="rail"
              className={styles.collapsedRail}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, delay: 0.08 }}
            >
              <SidebarCollapsedTop
                onToggle={onToggleCollapse}
                activePulse={!!activeNode}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="scrim"
              className={styles.scrim}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onCloseMobile}
            />
            <motion.aside
              key="drawer"
              ref={drawerRef}
              className={styles.drawer}
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{
                type: "spring",
                stiffness: 340,
                damping: 34,
                mass: 0.8,
              }}
            >
              <div className={styles.content}>
                <SidebarHeader
                  collapsed={false}
                  onToggle={onCloseMobile}
                  activePulse={!!activeNode}
                  closeIconIsX
                />
                <div className={styles.body}>
                  {isEmpty ? <EmptyState /> : <ThreadStream />}
                </div>
                <div className={styles.foot}>
                  <Composer />
                </div>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

// -----------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------

function SidebarHeader({
  collapsed,
  onToggle,
  activePulse,
  closeIconIsX,
}: {
  collapsed: boolean;
  onToggle: () => void;
  activePulse: boolean;
  closeIconIsX?: boolean;
}) {
  // 브랜드는 TopBar 에만 둔다. 여기까지 로고를 반복하면 같은 화면에 제품명이
  // 두 번 나오고, 정작 이 패널이 무엇인지는 안 알려준다.
  // 펄스하던 glow 도 제거 — 유휴 상태에서 숨쉬는 요소는 두지 않는다.
  return (
    <div className={styles.header}>
      <span className={styles.panelLabel}>대화</span>

      <button
        type="button"
        className={styles.headerBtn}
        onClick={onToggle}
        aria-label={closeIconIsX ? "닫기" : "사이드바 접기"}
        title="⌘B"
      >
        <PanelLeftClose size={14} />
      </button>
    </div>
  );
}

function SidebarCollapsedTop({
  onToggle,
  activePulse,
}: {
  onToggle: () => void;
  activePulse: boolean;
}) {
  return (
    <div className={styles.railStack}>
      <button
        type="button"
        className={styles.railBtn}
        onClick={onToggle}
        aria-label="사이드바 펴기"
        title="⌘B"
      >
        <PanelLeftOpen size={14} />
      </button>
      {/* 진행 중일 때만 표시. 유휴 상태에서는 아무것도 그리지 않는다. */}
      {activePulse && <span className={styles.railBusy} aria-label="실행 중" />}
    </div>
  );
}
