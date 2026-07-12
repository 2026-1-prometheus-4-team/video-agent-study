"use client";

// InspectorPanel — 우측 패널 디스패처. 선택 0 -> 씬, 1 -> 요소, 다중 -> 액션.

import React from "react";
import { useEditor } from "@/editor/store";
import { MultiInspector } from "./MultiInspector";
import { usePanelResize } from "@/editor/usePanelResize";
import { SceneInspector } from "./SceneInspector";
import { ElementInspector } from "./ElementInspector";
import { AudioClipInspector, AudioMultiInspector } from "./AudioClipInspector";
import { Section, Row, NumberInput } from "@/editor/controls";
import { snapshotForScale, applyScaleDeep, elementBoxFrac, type ScalePivot } from "@/editor/mutations";
import { getElement } from "@/editor/specPath";
import s from "./inspector.module.css";

// K(Scale 툴) 활성 시 패널 하단 — 선택 전체(자식·텍스트 포함)를 실제 값으로
// 비율 스케일. 캔버스 핸들 드래그와 같은 동작의 수치 입력판.
function ScaleToolSection() {
  const selection = useEditor((st) => st.selection);
  const doc = useEditor((st) => st.doc);
  const [mult, setMult] = React.useState(1);
  const [anchor, setAnchor] = React.useState<{ ax: number; ay: number }>({ ax: 0.5, ay: 0.5 });
  // 스크럽/타이핑 세션 스냅샷 — 라이브 적용 + 매 tick 재계산(드리프트 없음)
  const snapsRef = React.useRef<ReturnType<typeof snapshotForScale> | null>(null);
  // K 활성화 순간 이 섹션이 보이도록 패널 스크롤 (마운트 시 1회)
  const rootRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  if (selection.length === 0 || !doc) return null;

  const primary = getElement(doc, selection[0]) as Record<string, unknown> | null;
  const box = primary ? elementBoxFrac(primary) : null;
  const wPx = box ? box.w * 1920 : null;
  const hPx = box ? box.h * 1080 : null;
  const pivot: ScalePivot = { type: "anchor", ax: anchor.ax, ay: anchor.ay };

  const applyK = (k: number, live: boolean) => {
    if (!snapsRef.current) snapsRef.current = snapshotForScale(selection);
    applyScaleDeep(snapsRef.current, k, pivot, live);
    if (!live) {
      snapsRef.current = null;
      setMult(1);
    }
  };

  return (
    <div ref={rootRef}>
    <Section title="Scale (K)">
      {wPx != null && hPx != null && (
        <>
          <Row label="W">
            <NumberInput value={Math.round(wPx * 10) / 10} min={4} max={7680} step={1} unit="px"
              onChange={(v, o) => applyK(v / Math.max(1, wPx), o.live)} />
          </Row>
          <Row label="H">
            <NumberInput value={Math.round(hPx * 10) / 10} min={4} max={4320} step={1} unit="px"
              onChange={(v, o) => applyK(v / Math.max(1, hPx), o.live)} />
          </Row>
        </>
      )}
      <Row label="Scale">
        <NumberInput value={mult} min={0.05} max={20} step={0.05} unit="x"
          onChange={(v, o) => { setMult(v); applyK(v, o.live); }} />
      </Row>
      <Row label="Anchor">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 14px)", gap: 3, padding: "2px 0" }}>
          {[0, 0.5, 1].map((ay) =>
            [0, 0.5, 1].map((ax) => (
              <button
                key={`${ax}-${ay}`}
                onClick={() => setAnchor({ ax, ay })}
                title={`Anchor ${ax},${ay}`}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: anchor.ax === ax && anchor.ay === ay ? "var(--accent, #4C8DFF)" : "var(--bg-inset)",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            )),
          )}
        </div>
      </Row>
      <Row label="">
        <span style={{ color: "var(--text-4)", fontSize: 11 }}>드래그: 핸들 = 비율 고정 스케일 · 값 = 앵커 기준</span>
      </Row>
    </Section>
    </div>
  );
}

export default function InspectorPanel() {
  const selection = useEditor((st) => st.selection);
  const selectedAudio = useEditor((st) => st.ui.selectedAudio);
  const tool = useEditor((st) => st.ui.tool);
  const width = useEditor((st) => st.ui.rightWidth);
  const collapsed = useEditor((st) => st.ui.rightCollapsed);
  const setUI = useEditor((st) => st.setUI);
  // 왼쪽 가장자리 핸들 → 왼쪽으로 끌면 넓어짐(dir -1).
  const { dragging, handleProps } = usePanelResize({ key: "rightWidth", axis: "x", dir: -1, min: 220, max: 480 });

  let content: React.ReactNode;
  if (selection.length === 0 && selectedAudio.length === 1) {
    // 오디오 클립 선택 — 요소 선택과 배타 (store.select 가 보장)
    content = <AudioClipInspector clipId={selectedAudio[0]} />;
  } else if (selection.length === 0 && selectedAudio.length > 1) {
    content = <AudioMultiInspector clipIds={selectedAudio} />;
  } else if (selection.length === 0) {
    content = <SceneInspector />;
  } else if (selection.length === 1) {
    content = <ElementInspector elementPath={selection[0]} />;
  } else {
    // Figma 식 다중 선택 — 공통 속성(Mixed) + Selection colors
    content = <MultiInspector paths={selection} />;
  }

  return (
    <aside
      className={s.panel}
      data-collapsed={collapsed}
      data-dragging={dragging}
      style={{ width: collapsed ? 0 : width }}
    >
      {/* 왼쪽 가장자리 리사이즈 핸들 */}
      <div className={s.resizeLeft} {...handleProps} />
      <div className={s.panelScroll}>
        {content}
        {tool === "scale" && <ScaleToolSection />}
      </div>
    </aside>
  );
}
