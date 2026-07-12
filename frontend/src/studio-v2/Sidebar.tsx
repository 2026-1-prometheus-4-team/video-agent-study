"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { PanelLeftClose } from "lucide-react";
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
  const isEmpty = streamLength === 0;

  // Esc → mobile drawer close
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
          width: collapsed ? 60 : 384,
        }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 32,
          mass: 0.9,
        }}
      >
        <AnimatePresence mode="wait">
          {!collapsed && (
            <motion.div
              key="content"
              className={styles.content}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
            >
              <div className={styles.header}>
                <div className={styles.headerLabel}>대화</div>
                <button
                  type="button"
                  className={styles.collapseBtn}
                  onClick={onToggleCollapse}
                  aria-label="사이드바 접기"
                  title="⌘B"
                >
                  <PanelLeftClose size={14} />
                </button>
              </div>

              <div className={styles.body}>
                {isEmpty ? <EmptyState /> : <ThreadStream />}
              </div>

              <div className={styles.foot}>
                <Composer />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {collapsed && (
          <motion.div
            key="collapsed"
            className={styles.collapsedRail}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.12, delay: 0.12 }}
          >
            <button
              type="button"
              className={styles.expandBtn}
              onClick={onToggleCollapse}
              aria-label="사이드바 펴기"
              title="⌘B"
            >
              <span className={styles.expandGlyph} />
            </button>
          </motion.div>
        )}
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
                stiffness: 320,
                damping: 34,
                mass: 0.8,
              }}
            >
              <div className={styles.content}>
                <div className={styles.header}>
                  <div className={styles.headerLabel}>대화</div>
                  <button
                    type="button"
                    className={styles.collapseBtn}
                    onClick={onCloseMobile}
                    aria-label="사이드바 닫기"
                  >
                    <PanelLeftClose size={14} />
                  </button>
                </div>
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
