"use client";

import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
// PipelineHUD 는 phase 카드 rail 이랑 정보 중복이라 제거. 필요 시 재도입.
import { StageToolbar } from "./StageToolbar";
import { checkHealth } from "./backend";
import { useAgentStore } from "./state";
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

  // 백엔드 health check (마운트 + 주기적)
  useEffect(() => {
    let cancelled = false;
    const setConn = useAgentStore.getState().setConnection;

    const probe = async () => {
      const ok = await checkHealth();
      if (cancelled) return;
      const status = useAgentStore.getState().connection;
      if (ok) {
        // 이미 online 이면 그대로, 아니면 online 로 (WS 안 붙어있어도 REST 는 살아있다는 뜻)
        if (status === "offline" || status === "connecting") {
          setConn("online");
        }
      } else {
        if (status !== "reconnecting") setConn("offline");
      }
    };
    probe();
    const t = setInterval(probe, 6_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
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

          {/* PipelineHUD 제거됨 — phase 카드가 진행 상황을 rail 에 이미 표시 */}

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
