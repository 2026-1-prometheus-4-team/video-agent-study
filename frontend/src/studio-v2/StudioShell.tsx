"use client";

import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { Menu } from "lucide-react";
import { HistorySidebar } from "./HistorySidebar";
import { Sidebar } from "./Sidebar";
import { Stage } from "./Stage";
import { Timeline } from "./Timeline";
import { TopBar } from "./TopBar";
// PipelineHUD 는 phase 카드 rail 이랑 정보 중복이라 제거. 필요 시 재도입.
// StageToolbar 도 제거 — 영상 위에 뜨던 유리 알약 묶음이었고, 그 안의
// "● 연결됨" 은 사용자가 아무 것도 할 수 없는 장식이었다. 필요한 것은
// TopBar 로 옮기고 연결 문제는 끊겼을 때만 알린다.
import { checkHealth, restoreStudioSession } from "./backend";
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
  const [historyOpen, setHistoryOpen] = useState(true);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

  useHotkeys("meta+b, ctrl+b", (e) => {
    e.preventDefault();
    toggleSidebar();
  });

  useHotkeys("meta+shift+b, ctrl+shift+b", (e) => {
    e.preventDefault();
    setHistoryOpen((v) => !v);
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

  // 새로고침 후 이전 세션 복원 (localStorage → GET /session 검증 → WS 재연결).
  // restoreStudioSession 내부 래치로 StrictMode 이중 호출 방어.
  useEffect(() => {
    void restoreStudioSession();
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
      <TopBar
        historyOpen={historyOpen}
        chatOpen={!collapsed}
        onToggleHistory={() => {
          // HistorySidebar 는 자체 접힘 상태(⌘⇧B · localStorage)를 갖는다.
          // 여기서 언마운트하면 접힌 rail 까지 사라져 패널을 되살릴 방법이
          // 상단 버튼밖에 안 남는다. 토글 신호만 보낸다.
          window.dispatchEvent(new CustomEvent("va:toggle-history"));
          setHistoryOpen((v) => !v);
        }}
        onToggleChat={toggleSidebar}
      />

      <HistorySidebar />

      <div className={styles.center}>
        <Stage />

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

      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onToggleCollapse={toggleSidebar}
      />

      <Timeline />
    </div>
  );
}
