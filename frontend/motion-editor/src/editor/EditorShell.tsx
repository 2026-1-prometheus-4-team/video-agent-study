"use client";

// EditorShell — 패널 조립. 각 패널은 props 없이 스토어만 본다 (CONTRACT.md).
// 레이아웃: TopBar / (Left | Canvas | Inspector) / Timeline.

import React from "react";
import { useEditor } from "@/editor/store";
import TopBar from "@/editor/topbar/TopBar";
import { DialogHost } from "@/editor/ui/dialogs";
import LibraryPanel from "@/editor/library/LibraryPanel";
import LayersPanel from "@/editor/layers/LayersPanel";
import AIPanel from "@/editor/ai/AIPanel";
import CanvasStage from "@/editor/canvas/CanvasStage";
import InspectorPanel from "@/editor/inspector/InspectorPanel";
import TimelinePanel from "@/editor/timeline/TimelinePanel";
import EasingEditorModal from "@/editor/easing/EasingEditorModal";
import JsonPanel from "@/editor/jsonview/JsonPanel";
import Dock from "@/editor/dock/Dock";
import { RefPickerModal } from "@/editor/reference/RefPickerModal";
import { useEditorShortcuts } from "@/editor/shortcuts";
import { useAutoSave } from "@/editor/library/saveDoc";
import { useImagePaste } from "@/editor/useImagePaste";
import { useSessionPersist, readSession, restorePlayhead } from "@/editor/sessionPersist";
import { useDevCssWatchdog } from "@/editor/devCssWatchdog";
import { usePanelResize } from "@/editor/usePanelResize";
import ScenePlayheadSync from "@/editor/ScenePlayheadSync";
import styles from "./EditorShell.module.css";

// 접기 화살표(‹ ›) 아이콘.
function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: dir === "right" ? "scaleX(-1)" : undefined }}>
      <path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const LeftPanel: React.FC = () => {
  const leftTab = useEditor((s) => s.ui.leftTab);
  const width = useEditor((s) => s.ui.leftWidth);
  const collapsed = useEditor((s) => s.ui.leftCollapsed);
  const setUI = useEditor((s) => s.setUI);
  const { dragging, handleProps } = usePanelResize({ key: "leftWidth", axis: "x", dir: 1, min: 190, max: 460 });
  return (
    <aside
      className={styles.left}
      data-collapsed={collapsed}
      data-dragging={dragging}
      style={{ width: collapsed ? 0 : width }}
    >
      <div className={styles.leftTabs} role="tablist">
        <button
          role="tab"
          aria-selected={leftTab === "library"}
          data-active={leftTab === "library"}
          className={styles.leftTab}
          onClick={() => setUI({ leftTab: "library" })}
        >
          Specs
        </button>
        <button
          role="tab"
          aria-selected={leftTab === "layers"}
          data-active={leftTab === "layers"}
          className={styles.leftTab}
          onClick={() => setUI({ leftTab: "layers" })}
        >
          Layers
        </button>
        <button
          role="tab"
          aria-selected={leftTab === "ai"}
          data-active={leftTab === "ai"}
          className={styles.leftTab}
          onClick={() => setUI({ leftTab: "ai" })}
        >
          {/* 생성(음악/SFX/나레이션) — 이후 AI 채팅 편집도 이 탭 */}
          <svg width="11" height="11" viewBox="0 0 12 12" style={{ marginRight: 4, verticalAlign: "-1px" }}>
            <path d="M6 1l1.1 2.7L10 4.8 7.4 6.4 8 9.5 6 7.8 4 9.5l.6-3.1L2 4.8l2.9-1.1z" fill="currentColor" opacity="0.85" />
          </svg>
          AI
        </button>
      </div>
      <div className={styles.leftBody}>
        {leftTab === "library" ? <LibraryPanel /> : leftTab === "layers" ? <LayersPanel /> : <AIPanel />}
      </div>
      {/* 오른쪽 가장자리 리사이즈 핸들 */}
      <div className={styles.resizeRight} {...handleProps} />
    </aside>
  );
};

export default function EditorShell() {
  useEditorShortcuts();
  useAutoSave();
  useImagePaste();
  useSessionPersist();
  useDevCssWatchdog();
  const easingOpen = useEditor((s) => s.ui.easingEditor !== null);
  const jsonOpen = useEditor((s) => s.ui.jsonOpen);
  const refPickerOpen = useEditor((s) => s.ui.refPickerOpen);
  const hasDoc = useEditor((s) => s.doc !== null);
  const leftCollapsed = useEditor((s) => s.ui.leftCollapsed);
  const rightCollapsed = useEditor((s) => s.ui.rightCollapsed);
  const setUI = useEditor((s) => s.setUI);

  // 첫 진입 — 지난 세션의 파일/위치/패널 복원. 세션 없으면 데모 스펙(빈 화면 방지).
  React.useEffect(() => {
    if (hasDoc) return;
    const sess = readSession();
    if (sess?.ui) useEditor.getState().setUI(sess.ui);
    const wanted = sess?.relPath ?? "text-motion/words-test.json";
    const fallback = "text-motion/words-test.json";
    const open = (path: string, json: unknown, restore: boolean) => {
      if (!json || useEditor.getState().doc) return;
      useEditor.getState().loadDoc(path, json);
      if (restore && sess) {
        // loadDoc 이 activeScene 을 0 으로 리셋하므로 이후에 복원.
        useEditor.getState().setActiveScene(sess.activeScene ?? 0);
        restorePlayhead(sess.frame ?? 0);
      }
    };
    fetch("/api/specs/file?path=" + encodeURIComponent(wanted))
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json) open(wanted, json, true);
        else if (wanted !== fallback) {
          // 저장된 파일이 사라짐 → 데모로 폴백
          return fetch("/api/specs/file?path=" + encodeURIComponent(fallback))
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => open(fallback, j, false));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.root}>
      <TopBar />
      <DialogHost />
      <div className={styles.main}>
        <LeftPanel />
        <main className={styles.canvas}>
          <CanvasStage />
          <Dock />
        </main>
        <InspectorPanel />
        {jsonOpen ? <JsonPanel /> : null}

      </div>
      <TimelinePanel />
      <ScenePlayheadSync />
      {easingOpen ? <EasingEditorModal /> : null}
      {refPickerOpen ? <RefPickerModal /> : null}
    </div>
  );
}
