"use client";

import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { PipelineHUD } from "./PipelineHUD";
import styles from "./studio-shell.module.css";

/**
 * StudioShell — v2 최상위 레이아웃.
 *
 * 3-region grid:
 *   [TopBar        ]
 *   [Sidebar│Stage ]
 *   [       │Time  ]
 *
 * 반응형:
 *   ≥1280px : 3열 (사이드바 고정)
 *   768-1279: 사이드바 overlay drawer (햄버거)
 *   <768   : 사이드바 bottom sheet (모바일)
 *
 * 접기 (⌘B / 버튼) — 사이드바 폭 spring 애니메이션.
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

  // 뷰포트 크기에 따라 mobile mode 전환
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = () => {
      // 데스크톱 → 모바일 전환 시 collapse 상태 유지
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
      <TopBar
        onToggleSidebar={toggleSidebar}
        onOpenMobileSidebar={() => setMobileOpen(true)}
      />

      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onToggleCollapse={toggleSidebar}
      />

      <div className={styles.right}>
        <div className={styles.stageWrap}>
          <Stage />
          <PipelineHUD />
        </div>
        <Timeline />
      </div>
    </div>
  );
}
