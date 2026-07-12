"use client";

// FillStack — Figma식 멀티 fill 스택 UI. 모든 요소/배경이 공유.
// fill(단일 또는 배열)을 받아 페인트 리스트로 관리. 엔진 배열은 index0=바닥/최상단=끝이라
// 리스트는 **역순 표시**(맨 위 행 = 최상단 페인트). 행: 스와치(클릭→피커 팝오버) /
// opacity% / 눈(가시성) / 삭제. "+"로 추가. 드래그로 순서 변경.
// 쓰기: 0개→undefined, 1개→단일 페인트(뒤 호환), 2+개→배열.

import React from "react";
import type { FillPaint, FillSpec } from "@engine/motion/fill";
import { normalizeFills } from "@engine/motion/fill";
import { isGradient } from "@/editor/gradient";
import { FillEditor } from "./FillEditor";
import { collectDocColors } from "./ColorPicker";
import { useEditor } from "@/editor/store";
import s from "./fill.module.css";

// 문자열 페인트를 객체로(opacity/visible/blend 를 실으려면 필요).
function asObject(p: FillPaint): Exclude<FillPaint, string> {
  if (typeof p !== "string") return p;
  return isGradient(p) ? { type: "gradient", css: p } : { type: "solid", color: p };
}
function opacityOf(p: FillPaint): number {
  return typeof p === "string" ? 1 : p.opacity ?? 1;
}
function visibleOf(p: FillPaint): boolean {
  return typeof p === "string" ? true : p.visible !== false;
}
function previewStyle(p: FillPaint): React.CSSProperties {
  if (typeof p === "string") return { background: p };
  if (p.type === "solid") return { background: p.color };
  if (p.type === "gradient") return { background: p.css };
  if (p.type === "image") return { backgroundImage: `url(${p.src})`, backgroundSize: "cover", backgroundPosition: "center" };
  if (p.type === "video") return { background: "linear-gradient(135deg,#333,#111)" };
  if (p.type === "noise") return { background: p.color ?? "#888", opacity: 0.7 };
  if (p.type === "aurora") {
    const c = p.colors && p.colors.length > 0 ? p.colors : ["#7C4DFF", "#52C5FF"];
    return { background: `radial-gradient(circle at 30% 70%, ${c[0]}, transparent 70%), radial-gradient(circle at 70% 30%, ${c[1] ?? c[0]}, transparent 70%), #0b0d10` };
  }
  return {};
}
function labelOf(p: FillPaint): string {
  if (typeof p === "string") return (isGradient(p) as boolean) ? "Gradient" : p.toUpperCase();
  if (p.type === "solid") return p.color.toUpperCase();
  const t: string = p.type;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function FillStack({
  fill,
  onChange,
  label = "Fill",
  allowNone = true,
}: {
  fill: FillSpec | undefined;
  onChange: (f: FillSpec | undefined) => void;
  label?: string;
  allowNone?: boolean;
}) {
  const paints = normalizeFills(fill);
  const [openIdx, setOpenIdx] = React.useState<number | null>(null); // array index
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const dragRef = React.useRef<{ fromDisplay: number } | null>(null);
  const [dragOver, setDragOver] = React.useState<number | null>(null); // display index

  // 배열로 쓰되 0→undefined, 1→단일.
  const writeArr = (next: FillPaint[]) => {
    if (next.length === 0) onChange(undefined);
    else if (next.length === 1) onChange(next[0]);
    else onChange(next);
  };
  const patchAt = (arrIdx: number, p: FillPaint) => writeArr(paints.map((x, i) => (i === arrIdx ? p : x)));
  const removeAt = (arrIdx: number) => { writeArr(paints.filter((_, i) => i !== arrIdx)); if (openIdx === arrIdx) setOpenIdx(null); };
  const addPaint = () => { writeArr([...paints, "#7C4DFF"]); }; // 새 페인트는 최상단(배열 끝)
  const setOpacity = (arrIdx: number, o: number) => patchAt(arrIdx, { ...asObject(paints[arrIdx]), opacity: o });
  const toggleVisible = (arrIdx: number) => patchAt(arrIdx, { ...asObject(paints[arrIdx]), visible: !visibleOf(paints[arrIdx]) });

  // 드래그 순서변경 — 표시(역순) 기준. 배열 인덱스로 변환해 이동.
  const displayToArr = (d: number) => paints.length - 1 - d;
  const moveDisplay = (from: number, to: number) => {
    if (from === to) return;
    const arr = [...paints];
    const fromArr = displayToArr(from);
    const [m] = arr.splice(fromArr, 1);
    arr.splice(displayToArr(to), 0, m);
    writeArr(arr);
  };

  // 역순 표시: display 0 = paints[last] = 최상단.
  const display = paints.map((_, i) => paints.length - 1 - i).map((arrIdx) => ({ arrIdx, p: paints[arrIdx] }));

  return (
    <div className={s.fillStack}>
      <div className={s.fillStackHead}>
        {label ? <span className={s.fillStackTitle}>{label}</span> : <span />}
        <button className={s.fillStackAdd} onClick={addPaint} title="Add fill">+</button>
      </div>
      {display.length === 0 ? (
        <button className={s.fillStackEmpty} onClick={addPaint}>+ Add fill</button>
      ) : (
        <div className={s.fillRows}>
          {display.map(({ arrIdx, p }, d) => (
            <div
              key={arrIdx}
              className={s.fillRow}
              data-dragover={dragOver === d}
              onPointerMove={(e) => { if (dragRef.current) { const r = e.currentTarget.parentElement!.getBoundingClientRect(); const rowH = e.currentTarget.getBoundingClientRect().height || 28; const idx = Math.max(0, Math.min(display.length - 1, Math.floor((e.clientY - r.top) / rowH))); setDragOver(idx); } }}
            >
              <button className={s.fillDrag} title="Drag to reorder"
                onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); dragRef.current = { fromDisplay: d }; setDragOver(d); }}
                onPointerUp={(e) => { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); if (dragRef.current && dragOver != null) moveDisplay(dragRef.current.fromDisplay, dragOver); dragRef.current = null; setDragOver(null); }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3h6M2 5h6M2 7h6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
              </button>
              <button
                className={s.fillSwatch}
                style={previewStyle(p)}
                onClick={(e) => { setOpenIdx(openIdx === arrIdx ? null : arrIdx); setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); }}
                title="Edit fill"
              />
              <button className={s.fillLabel} onClick={(e) => { setOpenIdx(openIdx === arrIdx ? null : arrIdx); setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect()); }}>
                {labelOf(p)}
              </button>
              <input
                className={s.fillOpacity}
                type="text"
                inputMode="numeric"
                value={Math.round(opacityOf(p) * 100)}
                onChange={(e) => { const n = Math.max(0, Math.min(100, parseInt(e.target.value.replace(/\D/g, "") || "0", 10))); setOpacity(arrIdx, n / 100); }}
                aria-label="Opacity %"
              />
              <span className={s.fillPct}>%</span>
              <button className={s.fillEye} data-off={!visibleOf(p)} onClick={() => toggleVisible(arrIdx)} title={visibleOf(p) ? "Hide" : "Show"}>
                {visibleOf(p) ? (
                  <svg width="13" height="13" viewBox="0 0 14 14"><path d="M1 7s2.2-3.8 6-3.8S13 7 13 7s-2.2 3.8-6 3.8S1 7 1 7z" stroke="currentColor" strokeWidth="1" fill="none" /><circle cx="7" cy="7" r="1.6" fill="currentColor" /></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 14 14"><path d="M2 2l10 10M1 7s2.2-3.8 6-3.8c1 0 1.9.3 2.7.6M13 7s-2.2 3.8-6 3.8c-.5 0-1-.1-1.4-.2" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round" /></svg>
                )}
              </button>
              <button className={s.fillRemove} onClick={() => removeAt(arrIdx)} title="Remove fill">
                <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {openIdx != null && anchor && paints[openIdx] != null && (
        <FillPopover
          anchor={anchor}
          paint={paints[openIdx]}
          allowNone={allowNone}
          onChange={(p) => { if (p == null) removeAt(openIdx); else patchAt(openIdx, p); }}
          onClose={() => setOpenIdx(null)}
        />
      )}
    </div>
  );
}

// 페인트 편집 팝오버(fixed) — Figma 팝오버 셸: [Custom | Libraries] 탭 + 닫기,
// Custom = FillEditor(타입 아이콘 행 + 인라인 피커), Libraries = 브랜드/문서 색.
function FillPopover({
  anchor,
  paint,
  onChange,
  onClose,
}: {
  anchor: DOMRect;
  paint: FillPaint;
  allowNone?: boolean;
  onChange: (p: FillPaint | undefined) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<"custom" | "libraries">("custom");
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Select 드롭다운은 body 포털(#select-popover-active)이라 팝오버 밖으로
      // 판정되면 옵션 클릭 전에 팝오버가 닫혀 클릭이 증발한다 (실측 리포트)
      if (!t.closest("[data-fillpop]") && !t.closest("#select-popover-active")) onClose();
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const t = setTimeout(() => {
      window.addEventListener("mousedown", h);
      window.addEventListener("keydown", k);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);

  const width = 248;
  const left = Math.max(8, anchor.left - width - 10); // 인스펙터 왼쪽에 띄움
  // 실측 높이 기반 top 클램프 — 내용(그라디언트 모드가 가장 김)이 화면 아래로
  // 잘리지 않게. 타입 전환으로 높이가 바뀌면 ResizeObserver 가 재클램프.
  const popRef = React.useRef<HTMLDivElement>(null);
  const [top, setTop] = React.useState(() => Math.max(8, Math.min(anchor.top, window.innerHeight - 320)));
  React.useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const clamp = () => {
      const h = el.getBoundingClientRect().height;
      setTop(Math.max(8, Math.min(anchor.top, window.innerHeight - h - 12)));
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);
  return (
    <div ref={popRef} className={s.fillPop} data-fillpop style={{ position: "fixed", left, top, width }}>
      <div className={s.fillPopHead}>
        <div className={s.fillTabs}>
          <button className={s.fillTab} data-active={tab === "custom"} onClick={() => setTab("custom")}>Custom</button>
          <button className={s.fillTab} data-active={tab === "libraries"} onClick={() => setTab("libraries")}>Libraries</button>
        </div>
        <button className={s.fillPopClose} onClick={onClose} aria-label="Close">
          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      {tab === "custom" ? (
        <FillEditor fill={paint} onChange={onChange} />
      ) : (
        <LibrariesTab
          onPick={(hex) => {
            // Figma: 라이브러리 색 적용 = 페인트를 그 색 solid 로 교체.
            // opacity/blend 같은 공통 필드는 유지.
            if (typeof paint === "object" && paint != null) {
              const { visible, opacity, blend } = paint;
              onChange({ type: "solid", color: hex, ...(visible !== undefined ? { visible } : {}), ...(opacity !== undefined ? { opacity } : {}), ...(blend !== undefined ? { blend } : {}) });
            } else onChange(hex);
            setTab("custom");
          }}
        />
      )}
    </div>
  );
}

// Libraries 탭 — 스타일 시스템 전 단계: 브랜드 팔레트(brandDefaults) + 문서 사용 색.
function LibrariesTab({ onPick }: { onPick: (hex: string) => void }) {
  const doc = useEditor((s) => s.doc);
  const [query, setQuery] = React.useState("");
  const bd = (doc as { brandDefaults?: { colors?: string[]; background?: string } } | null)?.brandDefaults;
  const brand = [...new Set([...(bd?.colors ?? []), ...(bd?.background ? [bd.background] : [])])]
    .filter((c) => /^#[0-9a-fA-F]{6}$/.test(c))
    .map((c) => c.toUpperCase());
  const page = collectDocColors(doc).filter((c) => !brand.includes(c));
  const match = (c: string) => !query || c.toLowerCase().includes(query.toLowerCase());

  const grid = (colors: string[]) => (
    <div className={s.libGrid}>
      {colors.filter(match).map((c) => (
        <button key={c} className={s.libSwatch} style={{ background: c }} title={c} onClick={() => onPick(c)} />
      ))}
    </div>
  );

  return (
    <div className={s.libTab}>
      <input className={s.libSearch} placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
      {brand.length > 0 && (
        <>
          <span className={s.libSection}>Brand</span>
          {grid(brand)}
        </>
      )}
      <span className={s.libSection}>On this page</span>
      {page.length > 0 ? grid(page) : <span className={s.libEmpty}>No colors used yet</span>}
    </div>
  );
}
