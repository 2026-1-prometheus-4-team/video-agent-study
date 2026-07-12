"use client";

// TopBar — 좌: 문서명/더티, 중: undo/redo/transport, 우: 비트/줌/이징/저장.

import React from "react";
import { useEditor } from "@/editor/store";
import { saveCurrentDoc } from "@/editor/library/saveDoc";
import { ExportDialog } from "./ExportDialog";
import s from "./topbar.module.css";

function PanelIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  // 클로드식 사이드바 토글 아이콘 — 열림이면 사이드 바 영역이 채워짐
  const bar = side === "left" ? { x: 2, w: 4.5 } : { x: 9.5, w: 4.5 };
  return (
    <svg width="15" height="15" viewBox="0 0 16 16">
      <rect x="2" y="2.8" width="12" height="10.4" rx="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <rect x={bar.x + 1} y="4.1" width={bar.w - 1.6} height="7.8" rx="1" fill="currentColor" opacity={open ? 0.85 : 0.3} />
    </svg>
  );
}

export default function TopBar() {
  const [exportOpen, setExportOpen] = React.useState(false);
  const leftCollapsed = useEditor((s) => s.ui.leftCollapsed);
  const rightCollapsed = useEditor((s) => s.ui.rightCollapsed);
  const meta = useEditor((st) => st.meta);
  const canvasZoom = useEditor((st) => st.ui.canvasZoom);
  const showBeat = useEditor((st) => st.ui.showBeatGrid);
  const jsonOpen = useEditor((st) => st.ui.jsonOpen);
  const undoLen = useEditor((st) => st.undoStack.length);
  const redoLen = useEditor((st) => st.redoStack.length);
  const setUI = useEditor((st) => st.setUI);

  const name = meta.relPath ? meta.relPath.split("/").pop() : "Untitled";
  const zoomPct = canvasZoom === "fit" ? "Fit" : `${Math.round((canvasZoom as number) * 100)}%`;

  const cycleZoom = () => {
    if (canvasZoom === "fit") setUI({ canvasZoom: 1 });
    else if (canvasZoom === 1) setUI({ canvasZoom: 2 });
    else setUI({ canvasZoom: "fit" });
  };

  return (
    <header className={s.bar}>
      <div className={s.left}>
        <button className="icon-btn" title={leftCollapsed ? "Show sidebar" : "Hide sidebar"} onClick={() => setUI({ leftCollapsed: !leftCollapsed })}>
          <PanelIcon side="left" open={!leftCollapsed} />
        </button>
        <span className={s.brand}>scene24 editor</span>
        <span className={s.divider} />
        <span className={s.docName}>{name}</span>
        {meta.dirty && <span className={s.dirtyDot} title="Unsaved" />}
        {meta.hadPresets && <span className={s.presetWarn} title="Editing an expanded preset — saving will flatten the preset structure">Preset expanded</span>}
      </div>

      {/* 상단 중앙 = undo/redo 만. 재생/REC/시간은 하단 타임라인 트랜스포트로 통합. */}
      <div className={s.center}>
        <button className="icon-btn" disabled={undoLen === 0} onClick={() => useEditor.getState().undo()} title="Undo (⌘Z)">
          <UndoIcon />
        </button>
        <button className="icon-btn" disabled={redoLen === 0} onClick={() => useEditor.getState().redo()} title="Redo (⌘⇧Z)">
          <UndoIcon flip />
        </button>
      </div>

      <div className={s.right}>
        <button className="icon-btn" data-active={showBeat} onClick={() => setUI({ showBeatGrid: !showBeat })} title="Beat grid 0.6s">
          <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 9l2-5 2 8 2-6 2 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" strokeLinecap="round" /></svg>
        </button>
        <button className={s.zoomBtn} onClick={cycleZoom} title="Canvas zoom">
          <span className="tnum">{zoomPct}</span>
        </button>
        <button className={s.easingBtn} onClick={() => setUI({ easingEditor: {} })} title="Browse easing">
          Easing
        </button>
        <button className={s.easingBtn} data-active={jsonOpen} onClick={() => setUI({ jsonOpen: !jsonOpen })} title="View/edit JSON source">
          {"{ }"}
        </button>
        <button className={s.easingBtn} onClick={() => setUI({ refPickerOpen: true })} title="Compare reference video">
          Reference
        </button>
        <button className={s.saveBtn} data-dirty={meta.dirty} onClick={() => void saveCurrentDoc()}>
          Save
        </button>
        <button className={s.saveBtn} onClick={() => setExportOpen(true)} title="Render to video">
          Export
        </button>
        <button className="icon-btn" title={rightCollapsed ? "Show inspector" : "Hide inspector"} onClick={() => setUI({ rightCollapsed: !rightCollapsed })}>
          <PanelIcon side="right" open={!rightCollapsed} />
        </button>
        {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      </div>
    </header>
  );
}

function UndoIcon({ flip }: { flip?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" style={{ transform: flip ? "scaleX(-1)" : undefined }}>
      <path d="M5 4L2.5 6.5 5 9" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.5 6.5H8a3.5 3.5 0 013.5 3.5v0" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}
