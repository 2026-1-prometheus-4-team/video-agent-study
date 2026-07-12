// ColorPicker — Figma 구조의 커스텀 컬러 피커.
// ColorPanel: 인라인 패널 (SV 사각형 / 스포이드 + hue/alpha 세로 스택 / Hex+% 행 /
//   "On this page" 스와치). Fill 팝오버가 solid/gradient stop 편집에 임베드한다.
// ColorPicker: ColorPanel 을 포털 팝오버로 감싼 것 — ColorInput(스트로크/텍스트 색
//   등 단일 스와치) 이 쓴다.

"use client";

import React from "react";
import { createPortal } from "react-dom";
import { useEditor } from "@/editor/store";

// ---- 색 수학 (hex <-> hsv) ----
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b) / 255;
  const mn = Math.min(r, g, b) / 255;
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r / 255) h = ((g / 255 - b / 255) / d) % 6;
    else if (mx === g / 255) h = (b / 255 - r / 255) / d + 2;
    else h = (r / 255 - g / 255) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// 문서에서 사용 중인 hex 색 수집 ("On this page") — Libraries 탭도 공유.
export function collectDocColors(doc: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const m = v.match(/^#[0-9a-fA-F]{6}$/);
      if (m) {
        const up = v.toUpperCase();
        if (!seen.has(up)) {
          seen.add(up);
          out.push(up);
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return out.slice(0, 30);
}

// ---- 인라인 컬러 패널 (Figma Custom 탭 solid 본문과 동일 배치) ----
// opacity/onOpacity 를 주면 알파 슬라이더 + % 입력이 활성화된다 (페인트 opacity 에 바인딩).
export function ColorPanel({
  value,
  onChange,
  opacity,
  onOpacity,
  docColors = true,
}: {
  value: string;
  onChange: (hex: string) => void;
  opacity?: number;
  onOpacity?: (o: number) => void;
  docColors?: boolean;
}) {
  const doc = useEditor((s) => s.doc);
  const safe = /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : "#FFFFFF";
  const [hsv, setHsv] = React.useState<[number, number, number]>(() => rgbToHsv(...hexToRgb(safe)));
  const [hexText, setHexText] = React.useState<string | null>(null);
  const lastEmit = React.useRef(safe.toUpperCase());
  const svRef = React.useRef<HTMLDivElement>(null);
  const hueRef = React.useRef<HTMLDivElement>(null);
  const alphaRef = React.useRef<HTMLDivElement>(null);

  // 외부에서 값이 바뀌면(그라디언트 stop 전환 등) HSV 재동기화.
  // 자기 emit 은 lastEmit 으로 걸러 드리프트(달아나는 SV 노브)를 막는다.
  React.useEffect(() => {
    const up = safe.toUpperCase();
    if (up !== lastEmit.current) {
      setHsv(rgbToHsv(...hexToRgb(up)));
      lastEmit.current = up;
    }
  }, [safe]);

  const [h, s, v] = hsv;
  const hex = rgbToHex(...hsvToRgb(h, s, v));
  const hueHex = rgbToHex(...hsvToRgb(h, 1, 1));

  const emit = (nh: number, ns: number, nv: number) => {
    setHsv([nh, ns, nv]);
    const out = rgbToHex(...hsvToRgb(nh, ns, nv));
    lastEmit.current = out;
    onChange(out);
  };

  const dragTrack = (ref: React.RefObject<HTMLDivElement | null>, apply: (frac: number, fy: number) => void) => (e: React.PointerEvent) => {
    const el = ref.current!;
    const move = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      apply(
        Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)),
      );
    };
    // 문지르기 한 번 = undo 1건 — 드래그 동안의 모든 doc 쓰기를 제스처로 병합
    useEditor.getState().beginGesture();
    move(e);
    const mv = (ev: PointerEvent) => move(ev);
    const up = () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
      useEditor.getState().endGesture();
    };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  const eyedrop = async () => {
    const ED = (window as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
    if (!ED) return;
    try {
      const res = await new ED().open();
      const [r, g, b] = hexToRgb(res.sRGBHex);
      const [nh, ns, nv] = rgbToHsv(r, g, b);
      emit(nh, ns, nv);
    } catch {
      /* 취소 */
    }
  };

  const knob = (x: number, y: number, size = 12): React.CSSProperties => ({
    position: "absolute",
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: size,
    height: size,
    borderRadius: "50%",
    border: "2px solid #FFFFFF",
    boxShadow: "0 0 0 1px rgba(0,0,0,0.45)",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
  });

  const swatches = docColors ? collectDocColors(doc) : [];
  const alphaOn = onOpacity != null;
  const op = Math.round((opacity ?? 1) * 100);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, userSelect: "none" }}>
      {/* SV 사각형 */}
      <div
        ref={svRef}
        onPointerDown={dragTrack(svRef, (fx, fy) => emit(h, fx, 1 - fy))}
        style={{
          position: "relative",
          width: "100%",
          height: 150,
          borderRadius: 8,
          cursor: "crosshair",
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #FFF, ${hueHex})`,
        }}
      >
        <div style={knob(s, 1 - v)} />
      </div>

      {/* 스포이드(좌) + hue/alpha 세로 스택(우) — Figma 배치 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={eyedrop}
          title="Pick color from screen (I)"
          style={{ width: 28, height: 28, borderRadius: 6, border: "none", background: "var(--bg-hover)", color: "var(--text-2)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9.5 1.8l2.7 2.7-1.5 1.5-.6-.6-5.6 5.6-2.6.9.9-2.6 5.6-5.6-.6-.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div
            ref={hueRef}
            onPointerDown={dragTrack(hueRef, (fx) => emit(fx * 360, s, v))}
            style={{
              position: "relative",
              height: 12,
              borderRadius: 6,
              cursor: "pointer",
              background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
            }}
          >
            <div style={knob(h / 360, 0.5)} />
          </div>
          {alphaOn && (
            <div
              ref={alphaRef}
              onPointerDown={dragTrack(alphaRef, (fx) => onOpacity!(Math.round(fx * 100) / 100))}
              style={{
                position: "relative",
                height: 12,
                borderRadius: 6,
                cursor: "pointer",
                background: `linear-gradient(to right, transparent, ${hex}), repeating-conic-gradient(#666 0% 25%, #999 0% 50%) 0 0 / 8px 8px`,
              }}
            >
              <div style={knob((opacity ?? 1), 0.5)} />
            </div>
          )}
        </div>
      </div>

      {/* Hex + opacity% 행 */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ color: "var(--text-4)", fontSize: 11, width: 26, flex: "none" }}>Hex</span>
        <input
          value={hexText ?? hex.replace("#", "")}
          spellCheck={false}
          onChange={(e) => setHexText(e.target.value)}
          onFocus={() => setHexText(hex.replace("#", ""))}
          onBlur={(e) => {
            const t = e.target.value.trim().replace("#", "");
            if (/^[0-9a-fA-F]{6}$/.test(t) || /^[0-9a-fA-F]{3}$/.test(t)) {
              const [r, g, b] = hexToRgb(`#${t}`);
              const [nh, ns, nv] = rgbToHsv(r, g, b);
              emit(nh, ns, nv);
            }
            setHexText(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          style={{ flex: 1, minWidth: 0, background: "var(--bg-inset)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "6px 8px", color: "var(--text-1)", fontSize: 12, outline: "none", fontFamily: "inherit" }}
        />
        {alphaOn ? (
          <input
            value={op}
            inputMode="numeric"
            onChange={(e) => {
              const n = Math.max(0, Math.min(100, parseInt(e.target.value.replace(/\D/g, "") || "0", 10)));
              onOpacity!(n / 100);
            }}
            aria-label="Opacity %"
            style={{ width: 44, background: "var(--bg-inset)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, padding: "6px 6px", color: "var(--text-2)", fontSize: 12, outline: "none", textAlign: "right", fontFamily: "inherit" }}
          />
        ) : (
          <div style={{ width: 26, height: 26, borderRadius: 6, background: hex, border: "1px solid rgba(255,255,255,0.12)", flex: "none" }} />
        )}
      </div>

      {/* On this page — 문서 사용 색 스와치 */}
      {swatches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 10 }}>
          <span style={{ color: "var(--text-4)", fontSize: 11 }}>On this page</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 4 }}>
            {swatches.map((c) => (
              <button
                key={c}
                title={c}
                onClick={() => {
                  const [r, g, b] = hexToRgb(c);
                  const [nh, ns, nv] = rgbToHsv(r, g, b);
                  emit(nh, ns, nv);
                }}
                style={{ width: "100%", aspectRatio: "1", borderRadius: 4, border: "1px solid rgba(255,255,255,0.1)", background: c, cursor: "pointer", padding: 0 }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 포털 팝오버 래퍼 (ColorInput 등 단일 스와치용) ----
export function ColorPicker({
  value,
  anchor,
  onChange,
  onClose,
}: {
  value: string;
  anchor: { x: number; y: number };
  onChange: (hex: string) => void;
  onClose: () => void;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  const W = 248;
  const left = Math.min(Math.max(8, anchor.x), window.innerWidth - W - 16);
  const top = Math.min(Math.max(8, anchor.y), window.innerHeight - 380);

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 600,
        width: W,
        background: "var(--bg-float)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 13,
        boxShadow: "0 16px 50px rgba(0,0,0,0.55)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "var(--text-1)", fontSize: 12, fontWeight: 600 }}>Custom</span>
        <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--text-4)", cursor: "pointer", padding: 2 }}>
          <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>
      <ColorPanel value={value} onChange={onChange} />
    </div>,
    document.body,
  );
}
