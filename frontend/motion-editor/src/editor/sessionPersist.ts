"use client";

// sessionPersist — 새로고침해도 작업 위치가 유지되게 세션 상태를 localStorage 에.
// 저장: 현재 파일(relPath) / 재생헤드 프레임 / 활성 씬 / 패널 레이아웃.
// 문서 내용은 저장하지 않는다 — 파일은 autosave(saveDoc)가 담당.

import React from "react";
import { useEditor } from "./store";
import { getPlayer, seekTo } from "./playerBridge";

const KEY = "scene24:editor-session";

export type EditorSession = {
  relPath: string | null;
  frame: number;
  activeScene: number;
  ui: {
    leftWidth: number;
    rightWidth: number;
    bottomHeight: number;
    leftCollapsed: boolean;
    rightCollapsed: boolean;
    bottomCollapsed: boolean;
    pxPerFrame: number;
    leftTab: "library" | "layers" | "ai" | "agent";
  };
};

export function readSession(): EditorSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as EditorSession;
    if (typeof s !== "object" || s === null) return null;
    return s;
  } catch {
    return null;
  }
}

function writeSession() {
  try {
    const st = useEditor.getState();
    if (!st.doc) return;
    const { leftWidth, rightWidth, bottomHeight, leftCollapsed, rightCollapsed, bottomCollapsed, pxPerFrame, leftTab } = st.ui;
    const sess: EditorSession = {
      relPath: st.meta.relPath,
      frame: Math.round(getPlayer()?.getCurrentFrame() ?? 0),
      activeScene: st.activeScene,
      ui: { leftWidth, rightWidth, bottomHeight, leftCollapsed, rightCollapsed, bottomCollapsed, pxPerFrame, leftTab },
    };
    localStorage.setItem(KEY, JSON.stringify(sess));
  } catch {
    /* localStorage 불가(사파리 프라이빗 등) — 조용히 무시 */
  }
}

/** 플레이어가 마운트되면 저장된 프레임으로 시크 (최대 5초 재시도). */
export function restorePlayhead(frame: number) {
  if (!Number.isFinite(frame) || frame <= 0) return;
  let tries = 0;
  const tick = () => {
    if (getPlayer()) seekTo(frame);
    else if (++tries < 50) setTimeout(tick, 100);
  };
  tick();
}

/** EditorShell 에 마운트 — 주기 저장 + 떠날 때 저장. */
export function useSessionPersist() {
  React.useEffect(() => {
    const t = setInterval(writeSession, 3000);
    const onHide = () => writeSession();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      clearInterval(t);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);
}
