"use client";

// LayerStack — 요소의 layers 편집. role 배지 + 이름 + 펼침 노브 + 삭제/순서.
// 추가 메뉴: 등장/퇴장 리빌(structural) + 래퍼. structural 은 STRUCTURAL 로 판정.

import React from "react";
import { useEditor } from "@/editor/store";
import { STRUCTURAL } from "@/editor/timing";
import { getByPath } from "@/editor/setByPath";
import {
  atomFallbackKnobs,
  displayNameForLayer,
  buildLayersForEffect,
  STRUCTURAL_SCHEMA,
  WRAPPER_SCHEMA,
  MENU_HIDDEN_EFFECTS,
  type Knob,
} from "@/editor/schema";
import { getElement, type ElementPath } from "@/editor/specPath";
import type { MotionLayer } from "@engine/motion/core/timing";
import { createPortal } from "react-dom";
import { Player, type PlayerRef } from "@remotion/player";
import { Ad, type VideoSpec } from "@engine/motion/SceneRenderer";
import { KnobField } from "./KnobField";
import { writeLayerKnob, removeLayer, moveLayer } from "./writes";
import { useEditor as store } from "@/editor/store";
import s from "./inspector.module.css";

const ROLE_LABEL: Record<string, string> = { in: "In", out: "Out", hold: "Hold", afterIn: "After" };
const ROLE_CLASS: Record<string, string> = { in: s.badgeIn, out: s.badgeOut, hold: s.badgeHold, afterIn: s.badgeAfter };

export function LayerStack({ elementPath }: { elementPath: ElementPath }) {
  const doc = useEditor((st) => st.doc);
  const [expanded, setExpanded] = React.useState<number | null>(0);
  const [addOpen, setAddOpen] = React.useState(false);
  const [swapFor, setSwapFor] = React.useState<number | null>(null);
  // 스왑 드롭다운은 트리거 버튼 rect 기준 position:fixed 로 띄운다(부모 overflow 탈출).
  const [swapAnchor, setSwapAnchor] = React.useState<DOMRect | null>(null);

  const el = doc ? getElement(doc, elementPath) : null;
  if (!el || el.element === "logo") return null;
  const layers: MotionLayer[] = (el as { layers?: MotionLayer[] }).layers ?? [];

  // 효과 교체(swap) — 레이어 i 를 다른 효과로 바꾼다(삭제+추가 대신). delay 는 보존.
  const swapEffect = (layerIdx: number, name: string) => {
    const built = buildLayersForEffect(name);
    if (built.length === 0) return;
    const isStructural = built.some((l) => STRUCTURAL.has(l.type));
    const newRole = built[0].role;
    const curDoc = store.getState().doc;
    const curEl = curDoc ? getElement(curDoc, elementPath) : null;
    const curLayers = ((curEl as { layers?: MotionLayer[] } | null)?.layers ?? []) as MotionLayer[];
    const prevDelay = (curLayers[layerIdx]?.props as { delay?: number } | undefined)?.delay;
    const builtLayers = built.map((l, i) =>
      i === 0 && prevDelay != null ? { ...l, props: { ...l.props, delay: prevDelay } } : l,
    ) as MotionLayer[];
    let next = [...curLayers];
    next.splice(layerIdx, 1, ...builtLayers);
    // 새 효과가 structural 이면 같은 role 의 다른 structural 제거(슬롯 1개 규칙)
    if (isStructural) {
      const start = layerIdx;
      const end = layerIdx + builtLayers.length;
      next = next.filter(
        (l, idx) => (idx >= start && idx < end) || !(STRUCTURAL.has(l.type) && (l.role ?? "in") === newRole),
      );
    }
    store.getState().updateDoc(`Change effect: ${name}`, (draft) => {
      const t = getElement(draft, elementPath);
      if (!t || t.element === "logo") return;
      (t as { layers?: MotionLayer[] }).layers = next;
    });
    setSwapFor(null);
    setExpanded(layerIdx);
  };

  const addEffect = (name: string) => {
    const built = buildLayersForEffect(name);
    if (built.length === 0) return;
    const isStructural = built.some((l) => STRUCTURAL.has(l.type));
    const role = built[0].role;
    store.getState().updateDoc(`Add layer: ${name}`, (draft) => {
      const target = getElement(draft, elementPath);
      if (!target || target.element === "logo") return;
      const t = target as { layers?: MotionLayer[] };
      if (!t.layers) t.layers = [];
      // structural 은 슬롯 1개 — 같은 role 의 기존 structural 제거
      if (isStructural) {
        t.layers = t.layers.filter(
          (l) => !(STRUCTURAL.has(l.type) && (l.role ?? "in") === role),
        );
      }
      t.layers.push(...(built as MotionLayer[]));
    });
    setAddOpen(false);
    setExpanded(layers.length);
  };

  return (
    <div className={s.layerStack}>
      {layers.length === 0 && (
        <div className={s.layerEmpty}>No layers — use + to add In/Out</div>
      )}
      {layers.map((layer, i) => {
        const role = layer.role ?? "in";
        const isOpen = expanded === i;
        const isStruct = STRUCTURAL.has(layer.type);
        return (
          <div key={i} className={s.layerItem} data-open={isOpen}>
            {/* 헤더 아무 데나 클릭 = 레이어 펼침/접기. 효과 이름(스왑)·액션 버튼은
                stopPropagation 으로 제외. */}
            <div className={s.layerHead} onClick={() => setExpanded(isOpen ? null : i)}>
              <button
                className={s.layerExpand}
                onClick={(e) => { e.stopPropagation(); setExpanded(isOpen ? null : i); }}
              >
                <svg width="8" height="8" viewBox="0 0 10 10" style={{ transform: isOpen ? "rotate(90deg)" : undefined, transition: "transform 120ms" }}>
                  <path d="M3.5 2.5l3 2.5-3 2.5z" fill="currentColor" />
                </svg>
              </button>
              <span className={`${s.roleBadge} ${ROLE_CLASS[role] ?? ""}`}>
                {ROLE_LABEL[role] ?? role}
              </span>
              <button
                className={s.layerName}
                onClick={(e) => {
                  e.stopPropagation(); // 이름 클릭은 스왑 드롭다운만(펼침 X)
                  const open = swapFor === i ? null : i;
                  setSwapFor(open);
                  setSwapAnchor(open === null ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
                }}
                title="Change effect type"
              >
                {displayNameForLayer(layer.type, role)}
                {isStruct && <span className={s.structTag}>Reveal</span>}
                <svg className={s.layerNameCaret} width="8" height="8" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6l2.5-2.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {swapFor === i && swapAnchor && (
                <SwapEffectMenu
                  role={role}
                  currentType={layer.type}
                  currentProps={(layer.props ?? {}) as Record<string, unknown>}
                  anchor={swapAnchor}
                  onPick={(name) => swapEffect(i, name)}
                  onClose={() => { setSwapFor(null); setSwapAnchor(null); }}
                  elementPath={elementPath}
                />
              )}
              <div className={s.layerActions} onClick={(e) => e.stopPropagation()}>
                {!isStruct && (
                  <>
                    <button className={s.layerAct} disabled={i === 0} onClick={() => moveLayer(elementPath, i, i - 1, "Reorder layer")} title="Move up">
                      <ArrowIcon up />
                    </button>
                    <button className={s.layerAct} disabled={i === layers.length - 1} onClick={() => moveLayer(elementPath, i, i + 1, "Reorder layer")} title="Move down">
                      <ArrowIcon />
                    </button>
                  </>
                )}
                <button className={s.layerAct} data-danger onClick={() => removeLayer(elementPath, i, "Delete layer")} title="Delete">
                  <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
                </button>
              </div>
            </div>
            {isOpen && (
              <LayerKnobs elementPath={elementPath} layerIdx={i} layer={layer} />
            )}
          </div>
        );
      })}

      <div className={s.addLayerWrap}>
        <button className={s.addLayerBtn} onClick={() => setAddOpen((v) => !v)}>
          + Add layer
        </button>
        {addOpen && (
          <AddLayerMenu onPick={addEffect} onClose={() => setAddOpen(false)} elementPath={elementPath} />
        )}
      </div>
    </div>
  );
}

function LayerKnobs({
  elementPath,
  layerIdx,
  layer,
}: {
  elementPath: ElementPath;
  layerIdx: number;
  layer: MotionLayer;
}) {
  const knobs = atomFallbackKnobs(layer.type);
  // exposed(상황 선택 노브)는 항상 노출. cemented(실측 락)는 레이어에 실제 값이
  // 있을 때만 — 평범한 typewriter 에 characters_settle 의 reveal 노브가 안 뜨게.
  const exposed = knobs.filter((k) => !k.cemented);
  const cemented = knobs.filter(
    (k) => k.cemented && getByPath(layer, k.path) !== undefined,
  );
  const delayKnob: Knob = { key: "delay", label: "Delay", kind: "number", path: "props.delay", cemented: false, min: 0, max: 120, step: 1, unit: "frames" };

  const render = (k: Knob) => {
    const val = getByPath(layer, k.path);
    return (
      <KnobField
        key={k.path}
        knob={k}
        value={val}
        onChange={(v, o) => writeLayerKnob(elementPath, layerIdx, k.path, v, o.live, k.label)}
        easingTarget={{ path: elementPath, layerIdx, propPath: k.path, value: typeof val === "string" ? val : undefined }}
      />
    );
  };

  return (
    <div className={s.layerBody}>
      {render(delayKnob)}
      {exposed.map(render)}
      {cemented.length > 0 && (
        <div className={s.cementedGroup}>
          <div className={s.cementedTitle} title="Measured baseline from a reference — still editable; changing it departs from the captured look">Measured · editable</div>
          {cemented.map(render)}
        </div>
      )}
    </div>
  );
}

// ---- 이펙트 hover 라이브 프리뷰 ----------------------------------------------
// 메뉴 항목에 마우스를 올리면 그 효과를 실제 엔진으로 재생하는 미니 플레이어
// 카드를 메뉴 왼쪽에 띄운다 (같은 렌더 경로 = 결과와 동일). 120ms 디바운스로
// 목록 훑기 중 마운트 폭주 방지, 항목/메뉴 이탈 시 즉시 언마운트.
const PREVIEW_W = 236;
const PREVIEW_H = 132;
const PreviewVideo: React.FC<{ spec: VideoSpec }> = ({ spec }) => <Ad spec={spec} />;

function useEffectHoverPreview() {
  const [hover, setHover] = React.useState<{ name: string; anchor: DOMRect } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const enter = (name: string) => (e: React.MouseEvent) => {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover({ name, anchor }), 120);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHover(null);
  };
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { hover, enter, leave };
}

function EffectPreviewCard({ name, anchor, elementPath }: { name: string; anchor: DOMRect; elementPath: ElementPath }) {
  const doc = useEditor((st) => st.doc);
  const spec = React.useMemo<VideoSpec | null>(() => {
    if (!doc) return null;
    const layers = buildLayersForEffect(name);
    if (layers.length === 0) return null;
    // 선택 요소가 텍스트면 그 텍스트/타이포 그대로 미리보기 (실제 결과와 동일)
    const el = getElement(doc, elementPath);
    const src = (el && el.element === "text" ? (el.base as Record<string, unknown>) : null) ?? {};
    const color = typeof src.color === "string" && /^#[0-9a-fA-F]{6}$/.test(src.color) ? (src.color as string) : "#FFFFFF";
    // 글자색이 어두우면 밝은 배경 — 안 그러면 "아무것도 안 뜨는" 검정 카드가 된다
    // (요소 실제 색을 쓰는 대가 — 실측 리포트). 상대 휘도로 배경 자동 반전.
    const n = parseInt(color.slice(1), 16);
    const luma = (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
    const bg = luma < 0.45 ? "#E9ECF2" : "#0B0D12";
    const base: Record<string, unknown> = {
      text: (src.text as string) || "Make it move",
      fontSize: 8,
      fontWeight: src.fontWeight ?? 600,
      fontFamily: src.fontFamily,
      color,
      position: { x: 0.5, y: 0.5 },
    };
    return {
      fps: 24,
      brandDefaults: doc.brandDefaults,
      scenes: [
        {
          id: "fx-preview",
          duration: 2.4,
          background: { fill: bg },
          elements: [{ element: "text", id: "t", base, layers } as VideoSpec["scenes"][number]["elements"][number]],
        } as VideoSpec["scenes"][number],
      ],
    };
  }, [doc, name, elementPath]);
  // autoPlay 는 브라우저/탭 상태에 따라 조용히 안 돌 수 있다 (실측: 정지된
  // 카드) — 자체 rAF 로 프레임을 직접 시킹해 재생 정책과 무관하게 항상 돈다.
  const playerRef = React.useRef<PlayerRef>(null);
  React.useEffect(() => {
    if (!spec) return;
    let raf = 0;
    const start = performance.now();
    const DUR = Math.round(2.4 * 24);
    const tick = (now: number) => {
      const f = Math.floor(((now - start) / 1000) * 24) % DUR;
      playerRef.current?.seekTo(f);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spec]);
  if (!spec) return null;
  const left = Math.max(8, anchor.left - PREVIEW_W - 14);
  const top = Math.max(8, Math.min(anchor.top - PREVIEW_H / 2 + anchor.height / 2, window.innerHeight - PREVIEW_H - 40));
  return createPortal(
    <div
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 700,
        width: PREVIEW_W,
        background: "var(--bg-float)",
        border: "1px solid var(--hairline-strong)",
        borderRadius: 10,
        boxShadow: "var(--shadow-float)",
        padding: 6,
        pointerEvents: "none",
      }}
    >
      <Player
        ref={playerRef}
        component={PreviewVideo}
        inputProps={{ spec }}
        durationInFrames={Math.round(2.4 * 24)}
        compositionWidth={1920}
        compositionHeight={1080}
        fps={24}
        style={{ width: PREVIEW_W - 12, height: PREVIEW_H - 12, borderRadius: 6, overflow: "hidden" }}
        controls={false}
        clickToPlay={false}
        acknowledgeRemotionLicense
      />
    </div>,
    document.body,
  );
}

function AddLayerMenu({ onPick, onClose, elementPath }: { onPick: (name: string) => void; onClose: () => void; elementPath: ElementPath }) {
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-addmenu]")) onClose();
    };
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  const structIn = Object.values(STRUCTURAL_SCHEMA).filter((e) => e.role === "in" && !MENU_HIDDEN_EFFECTS.has(e.name));
  const structOut = Object.values(STRUCTURAL_SCHEMA).filter((e) => e.role === "out" && !MENU_HIDDEN_EFFECTS.has(e.name));
  const wrapIn = Object.values(WRAPPER_SCHEMA).filter((e) => e.role === "in");
  const wrapOut = Object.values(WRAPPER_SCHEMA).filter((e) => e.role === "out");

  const { hover, enter, leave } = useEffectHoverPreview();

  const group = (title: string, items: { name: string; title: string }[]) => (
    <div className={s.addGroup}>
      <div className={s.addGroupTitle}>{title}</div>
      {items.map((it) => (
        <button
          key={it.name}
          className={s.addItem}
          onClick={() => onPick(it.name)}
          onMouseEnter={enter(it.name)}
          onMouseLeave={leave}
        >
          {it.title}
        </button>
      ))}
    </div>
  );

  return (
    <div className={s.addMenu} data-addmenu>
      {group("In reveal", structIn)}
      {structOut.length > 0 && group("Out reveal", structOut)}
      {group("Wrapper · In", wrapIn)}
      {group("Wrapper · Out", wrapOut)}
      {hover && <EffectPreviewCard name={hover.name} anchor={hover.anchor} elementPath={elementPath} />}
    </div>
  );
}

// 효과 교체 메뉴 — 같은 role 의 reveal(structural) + wrapper 효과 나열. 현재 것 표시.
function SwapEffectMenu({
  role,
  currentType,
  currentProps,
  anchor,
  onPick,
  onClose,
  elementPath,
}: {
  role: string;
  currentType: string;
  /** 현재 레이어 props — 같은 atom 을 공유하는 named 효과들(typewriter 계열 등)
   *  중 어느 것인지 cemented 대조로 판별 (atom 만 보면 전부 하이라이트됨, 실측) */
  currentProps: Record<string, unknown>;
  anchor: DOMRect;
  onPick: (name: string) => void;
  onClose: () => void;
  elementPath: ElementPath;
}) {
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-swapmenu]")) onClose();
    };
    setTimeout(() => window.addEventListener("mousedown", h), 0);
    return () => window.removeEventListener("mousedown", h);
  }, [onClose]);

  const struct = Object.values(STRUCTURAL_SCHEMA).filter((e) => e.role === role && !MENU_HIDDEN_EFFECTS.has(e.name));
  const wrap = Object.values(WRAPPER_SCHEMA).filter((e) => e.role === role && !MENU_HIDDEN_EFFECTS.has(e.name));
  const { hover, enter, leave } = useEffectHoverPreview();
  // 현재 named 효과 판별: atom 이 같은 후보들 중 cemented 프롭 일치 개수가
  // 가장 높은 하나만 (동률이면 첫 번째). 전부 불일치면 atom 단독 후보일 때만.
  const candidates = [...struct, ...wrap].filter((e) => e.atom === currentType);
  let currentName: string | null = null;
  if (candidates.length === 1) currentName = candidates[0].name;
  else if (candidates.length > 1) {
    let best = -1;
    for (const c of candidates) {
      const cem = (c as { cemented?: Record<string, unknown> }).cemented ?? {};
      const keys = Object.keys(cem);
      const scoreMatch = keys.filter((k) => JSON.stringify((currentProps as Record<string, unknown>)[k]) === JSON.stringify(cem[k])).length;
      const score = keys.length === 0 ? 0 : scoreMatch / keys.length + scoreMatch * 0.01;
      if (score > best) {
        best = score;
        currentName = c.name;
      }
    }
  }
  const item = (e: { name: string; title: string; atom: string }) => (
    <button
      key={e.name}
      className={s.addItem}
      data-current={e.name === currentName}
      onClick={() => onPick(e.name)}
      onMouseEnter={enter(e.name)}
      onMouseLeave={leave}
    >
      {e.title}
    </button>
  );

  // 트리거 아래에 fixed 로. 화면 아래로 넘치면 위로 뒤집는다.
  const MENU_MAXH = 320;
  const below = window.innerHeight - anchor.bottom - 12;
  const openUp = below < 180 && anchor.top > below;
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(anchor.left, window.innerWidth - 220),
    width: Math.max(anchor.width, 190),
    maxHeight: Math.min(MENU_MAXH, openUp ? anchor.top - 12 : below),
    overflowY: "auto",
    ...(openUp
      ? { top: "auto", bottom: window.innerHeight - anchor.top + 4 }
      : { top: anchor.bottom + 4, bottom: "auto" }),
  };

  return (
    <div className={s.swapMenu} data-swapmenu style={style}>
      {struct.length > 0 && (
        <div className={s.addGroup}>
          <div className={s.addGroupTitle}>Reveal</div>
          {struct.map(item)}
        </div>
      )}
      {wrap.length > 0 && (
        <div className={s.addGroup}>
          <div className={s.addGroupTitle}>Wrapper</div>
          {wrap.map(item)}
        </div>
      )}
      {hover && <EffectPreviewCard name={hover.name} anchor={hover.anchor} elementPath={elementPath} />}
    </div>
  );
}

function ArrowIcon({ up }: { up?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ transform: up ? "rotate(180deg)" : undefined }}>
      <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
