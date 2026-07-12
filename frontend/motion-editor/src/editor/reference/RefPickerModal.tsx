"use client";

// RefPickerModal — 레퍼런스 영상 선택 모달. 카테고리별 그리드 + 프레임 썸네일
// (muted video 를 대표 프레임으로 seek) + 이름. 클릭하면 오버레이 대상으로 선택.

import React from "react";
import { useEditor } from "@/editor/store";
import { getPlayer } from "@/editor/playerBridge";
import s from "./reference.module.css";

type RefVid = { name: string; category: string; url: string; rel: string };

const CATEGORY_LABEL: Record<string, string> = {
  "app-launch": "App launch",
  "ui-demo": "UI demo",
  brand: "Brand",
  "bigtech-motion": "Big tech motion",
  explainer: "Explainer",
  inventory: "Inventory",
  misc: "Misc",
};

export function RefPickerModal() {
  const setUI = useEditor((st) => st.setUI);
  const current = useEditor((st) => st.ui.refOverlay.video);
  const [videos, setVideos] = React.useState<RefVid[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    fetch("/api/reference")
      .then((r) => r.json())
      .then((d) => setVideos(d.videos ?? []))
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, []);

  const close = () => setUI({ refPickerOpen: false });

  const pick = (v: RefVid) => {
    const frame = getPlayer()?.getCurrentFrame() ?? 0;
    // 선택 즉시: 현재 플레이헤드를 시작점으로 잡아 곧바로 정렬 편집 가능
    // doc.reference 에도 미러 — 파일 저장/복원 (setRefOverlay)
    useEditor.getState().setRefOverlay({ video: v.rel, visible: true, startFrame: Math.round(frame) });
    useEditor.getState().setUI({ refPickerOpen: false });
  };

  const filtered = q
    ? videos.filter((v) => (v.name + v.category).toLowerCase().includes(q.toLowerCase()))
    : videos;
  const groups = React.useMemo(() => {
    const g: Record<string, RefVid[]> = {};
    for (const v of filtered) (g[v.category] ??= []).push(v);
    return Object.entries(g).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className={s.modalWrap}>
      <div className={s.backdrop} onClick={close} />
      <div className={s.modal} role="dialog" aria-label="Choose reference video">
        <div className={s.modalHeader}>
          <span className={s.modalTitle}>Reference videos</span>
          <input
            className={s.search}
            placeholder="Search name or category"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <button className="icon-btn" onClick={close} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className={s.modalBody}>
          {loading ? (
            <div className={s.empty}>Loading...</div>
          ) : videos.length === 0 ? (
            <div className={s.empty}>
              No reference videos.<br />
              Drop mp4 files into <code>scene24/reference/&lt;category&gt;/</code>.
            </div>
          ) : (
            groups.map(([cat, vids]) => (
              <div key={cat} className={s.catGroup}>
                <div className={s.catLabel}>{CATEGORY_LABEL[cat] ?? cat} <span>{vids.length}</span></div>
                <div className={s.grid}>
                  {vids.map((v) => (
                    <Thumb key={v.rel} v={v} selected={v.rel === current} onPick={() => pick(v)} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Thumb({ v, selected, onPick }: { v: RefVid; selected: boolean; onPick: () => void }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  return (
    <button className={s.thumb} data-selected={selected} onClick={onPick} title={v.name}>
      <div className={s.thumbVideo}>
        <video
          ref={ref}
          src={v.url}
          muted
          playsInline
          preload="metadata"
          // 대표 프레임으로 이동(로드되면)
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration || 0;
            e.currentTarget.currentTime = Math.min(d * 0.25, 1.5);
          }}
          onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
          onMouseLeave={(e) => { e.currentTarget.pause(); const d = e.currentTarget.duration || 0; e.currentTarget.currentTime = Math.min(d * 0.25, 1.5); }}
        />
      </div>
      <span className={s.thumbName}>{v.name}</span>
    </button>
  );
}
