"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import {
  Film,
  History,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  PanelLeftClose,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  fetchSessions,
  loadSession,
  startNewSession,
  type SessionSummary,
} from "./backend";
import { useAgentStore } from "./state";
import styles from "./history-sidebar.module.css";

const COLLAPSE_KEY = "studio.histCollapsed";

/**
 * HistorySidebar — 지난 대화 목록.
 *
 * 데스크톱(>=1024px): 좌측 rail — 접기/펼치기 (⌘⇧B, localStorage 기억).
 * 접힌 상태는 아이콘 rail (펼치기 · 새 대화)만 남는다.
 * 그 이하: 좌상단 FAB → drawer.
 *
 * 마운트 시 GET /sessions. 세션 전환/턴 완료 시 재조회(새 대화가 목록에 뜨게).
 * 항목 클릭 → loadSession(소켓 교체 + 스트림 재구성 + WS 재연결).
 * '새 대화' → startNewSession(초기화 → EmptyState).
 */
export function HistorySidebar() {
  const router = useRouter();
  const sessionId = useAgentStore((s) => s.sessionId);
  const sessionStatus = useAgentStore((s) => s.sessionStatus);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // SSR 과 첫 페인트를 일치시키기 위해 false 로 시작, 마운트 후 저장값 반영.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (window.localStorage.getItem(COLLAPSE_KEY) === "1") setCollapsed(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  }, []);

  // 상단바 버튼도 같은 토글을 쓴다 (단축키와 동작이 갈라지지 않게).
  useEffect(() => {
    const onToggle = () => toggleCollapsed();
    window.addEventListener("va:toggle-history", onToggle);
    return () => window.removeEventListener("va:toggle-history", onToggle);
  }, [toggleCollapsed]);

  useHotkeys("meta+shift+b, ctrl+shift+b", (e) => {
    e.preventDefault();
    toggleCollapsed();
  });

  const refresh = useCallback(async () => {
    const list = await fetchSessions();
    setSessions(list);
    setLoading(false);
  }, []);

  // 마운트 시 1회.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 새 세션이 생기거나(첫 발화 후 sessionId 변경) 턴이 끝나면(메시지 DB 반영)
  // 목록을 다시 불러와 최신 대화가 뜨게 한다.
  useEffect(() => {
    if (sessionStatus === "completed" || sessionStatus === "idle") {
      void refresh();
    }
  }, [sessionId, sessionStatus, refresh]);

  // 모바일 drawer 열렸을 때 최신화 + Esc 로 닫기.
  useEffect(() => {
    if (!mobileOpen) return;
    void refresh();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, refresh]);

  const onNew = () => {
    startNewSession();
    setMobileOpen(false);
    void refresh();
  };

  const onOpen = async (s: SessionSummary) => {
    if (busyId) return;
    if (s.session_id === sessionId) {
      setMobileOpen(false);
      return;
    }
    setBusyId(s.session_id);
    try {
      await loadSession(s);
    } finally {
      setBusyId(null);
      setMobileOpen(false);
    }
  };

  const panel = (
    <div className={styles.inner}>
      <div className={styles.head}>
        <span className={styles.headTitle}>대화</span>
        <div className={styles.headActions}>
          <button type="button" className={styles.newBtn} onClick={onNew}>
            <Plus size={13} strokeWidth={2.4} />
            <span>새 대화</span>
          </button>
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={toggleCollapsed}
            title="대화 목록 접기 (⌘⇧B)"
            aria-label="대화 목록 접기"
          >
            <PanelLeftClose size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.hint}>불러오는 중…</div>
        ) : sessions.length === 0 ? (
          <div className={styles.empty}>
            <MessageSquare size={18} strokeWidth={1.8} />
            <span>아직 대화가 없어</span>
            <span className={styles.emptyHint}>
              영상을 올리고 편집을 지시하면 여기에 쌓여
            </span>
          </div>
        ) : (
          sessions.map((s) => (
            <button
              key={s.session_id}
              type="button"
              className={styles.item}
              data-active={s.session_id === sessionId || undefined}
              onClick={() => onOpen(s)}
              disabled={busyId !== null}
            >
              <span className={styles.itemTitle}>{s.title || "새 대화"}</span>
              <span className={styles.itemMeta}>
                <span className={styles.itemTime}>
                  {relativeTime(s.created_at ?? s.updated_at)}
                </span>
                {s.video_paths && s.video_paths.length > 0 && (
                  <span className={styles.badge}>
                    <Film size={9} strokeWidth={2.4} />
                    {s.video_paths.length}
                  </span>
                )}
                {busyId === s.session_id && (
                  <Loader2 className={styles.spin} size={11} />
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* 데스크톱 rail — 접으면 아이콘 컬럼으로 크로스페이드 */}
      <aside className={styles.rail} data-collapsed={collapsed || undefined}>
        {panel}
        <div className={styles.collapsedCol} aria-hidden={!collapsed}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={toggleCollapsed}
            tabIndex={collapsed ? 0 : -1}
            title="대화 목록 펼치기 (⌘⇧B)"
            aria-label="대화 목록 펼치기"
          >
            <History size={15} strokeWidth={2} />
          </button>
          {/* 이 레일은 "기록" 패널이다. 여기서 할 수 있는 일은 두 가지뿐이라
              그 두 개만 둔다. 다른 기능 버튼을 얹으면 패널의 역할이 흐려진다. */}
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.iconBtnAccent}`}
            onClick={onNew}
            tabIndex={collapsed ? 0 : -1}
            title="새 대화"
            aria-label="새 대화"
          >
            <Plus size={15} strokeWidth={2.4} />
          </button>
        </div>
      </aside>

      {/* 모바일 토글 FAB */}
      <button
        type="button"
        className={styles.fab}
        onClick={() => setMobileOpen(true)}
        aria-label="지난 대화 열기"
      >
        <History size={15} />
      </button>

      {/* 모바일 drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="hist-scrim"
              className={styles.scrim}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              key="hist-drawer"
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
              {panel}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

/** ISO 시각 → 상대 표기(한국어). tz 없는 문자열은 UTC 로 간주. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  const then = new Date(s).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 0) return "방금";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}주 전`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}개월 전`;
  return `${Math.floor(day / 365)}년 전`;
}
