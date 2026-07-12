"use client";

// RefControls — 레퍼런스 오버레이 컨트롤 바(캔버스 상단). 영상 변경/모드/불투명도/
// 시작·끝 정렬/클리어. 레퍼런스가 선택됐을 때만 뜬다.

import React from "react";
import { useEditor } from "@/editor/store";
import { getPlayer } from "@/editor/playerBridge";
import { Segmented } from "@/editor/controls";
import s from "./reference.module.css";

export function RefControls() {
  const ref = useEditor((st) => st.ui.refOverlay);
  const setUI = useEditor((st) => st.setUI);
  // setRefOverlay — ui + doc.reference 동시 갱신 (파일에 저장돼 재오픈 시 복원)
  const patch = (p: Partial<typeof ref>) => useEditor.getState().setRefOverlay(p);

  if (!ref.video) return null;
  const name = ref.video.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ref.video;
  const nowFrame = () => Math.round(getPlayer()?.getCurrentFrame() ?? 0);

  return (
    <div className={s.controls} data-hidden={!ref.visible}>
      {/* 눈 버튼: 보이기/숨기기 (피그마 레이어식 — 숨겨도 영상·정렬 유지) */}
      <button className={s.eyeBtn} data-off={!ref.visible} onClick={() => patch({ visible: !ref.visible })} title={ref.visible ? "Hide" : "Show"}>
        {ref.visible ? (
          <svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" stroke="currentColor" strokeWidth="1.1" fill="none" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5c1 0 1.9.3 2.7.7M14.5 8s-2.5 4.5-6.5 4.5c-1 0-1.9-.3-2.7-.7" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" /><path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
        )}
      </button>
      <button className={s.refName} onClick={() => setUI({ refPickerOpen: true })} title="Choose another video">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 3.5h8v6H2z" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M5 5l2.5 1.5L5 8z" fill="currentColor" /></svg>
        {name}
      </button>
      <span className={s.sep} />
      <Segmented<"overlay" | "side">
        value={ref.mode}
        options={[{ value: "overlay", label: "Overlay" }, { value: "side", label: "Side by side" }]}
        onChange={(v) => patch({ mode: v })}
      />
      {ref.mode === "overlay" && (
        <div className={s.opacity}>
          <span className={s.ctrlLabel}>Opacity</span>
          <input type="range" min={0} max={1} step={0.05} value={ref.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} />
        </div>
      )}
      {ref.mode === "side" && (
        <button className={s.smallBtn} onClick={() => patch({ side: ref.side === "right" ? "left" : "right" })} title="Swap sides">
          {ref.side === "right" ? "Reference right" : "Reference left"}
        </button>
      )}
      <span className={s.sep} />
      <div className={s.align}>
        <span className={s.ctrlLabel}>Align</span>
        <button className={s.alignBtn} onClick={() => patch({ startFrame: nowFrame() })} title="Set current frame as start">
          Start <b className="tnum">f{ref.startFrame}</b>
        </button>
        <button className={s.alignBtn} data-active={ref.endFrame != null} onClick={() => patch({ endFrame: nowFrame() })} title="Set current frame as end (stretch to range)">
          End <b className="tnum">{ref.endFrame != null ? `f${ref.endFrame}` : "Natural"}</b>
        </button>
        {ref.endFrame != null && (
          <button className={s.clearEnd} onClick={() => patch({ endFrame: null })} title="Clear end align">×</button>
        )}
      </div>
      <span className={s.sep} />
      <button className={s.trashBtn} onClick={() => patch({ video: null, visible: true })} title="Remove reference">
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 4h8M5.5 4V2.8h3V4M4 4l.6 7.2h4.8L10 4" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}
