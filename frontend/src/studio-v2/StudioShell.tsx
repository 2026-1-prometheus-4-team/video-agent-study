"use client";

import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { PipelineHUD } from "./PipelineHUD";
import { StageToolbar } from "./StageToolbar";
import styles from "./studio-shell.module.css";

/**
 * StudioShell — v2 최상위 레이아웃.
 *
 * 레이아웃 (topbar 없음):
 *   [Sidebar│Stage (툴바 top-right)]
 *   [       │Timeline               ]
 *
 * 반응형:
 *   ≥768px : 데스크톱 사이드바 (collapse 가능)
 *   <768   : 사이드바가 drawer 로 (햄버거 FAB)
 *
 * 사이드바 접기 = ⌘B / 사이드바 헤더 버튼.
 */
export function StudioShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

  useHotkeys("meta+b, ctrl+b", (e) => {
    e.preventDefault();
    toggleSidebar();
  });

  // 모바일 → 데스크톱 전환 시 drawer 자동 닫기
  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = () => {
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return (
    <div
      className={styles.shell}
      data-collapsed={collapsed}
      data-mobile-open={mobileOpen}
    >
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onToggleCollapse={toggleSidebar}
      />

      <div className={styles.right}>
        <div className={styles.stageWrap}>
          <Stage />

          <div className={styles.stageOverlay}>
            <StageToolbar />
          </div>

          <PipelineHUD />

          {/* Mobile FAB — 사이드바가 없을 때만 */}
          <button
            type="button"
            className={styles.mobileFab}
            onClick={() => setMobileOpen(true)}
            aria-label="대화 열기"
          >
            <Menu size={16} />
            <span>대화</span>
          </button>
        </div>

        <Timeline />
      </div>
    </div>
  );
}
