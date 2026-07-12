"use client";

// NumberInput — Figma 식 드래그 스크럽 숫자 입력.
// 라벨 칩을 ew-resize 로 드래그하면 값이 증감(shift=x10, alt=x0.1). 클릭하면
// 직접 타이핑. onChange(v, {live}) 로 라이브/커밋 구분 — 드래그 중엔 live:true
// (호출부가 coalesceKey 로 히스토리 합침), 릴리즈/blur/Enter 에 live:false.

import React from "react";
import s from "./controls.module.css";

export type NumberInputProps = {
  value: number;
  onChange: (v: number, opts: { live: boolean }) => void;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  label?: string;
  unit?: string;
  disabled?: boolean;
  /** 표시 배율 (예: fraction 0..1 을 %로 보이려면 display=100). 값 자체는 원단위. */
  displayScale?: number;
  /** 다중 선택에서 값이 서로 다를 때 — "Mixed" 표시, 편집하면 전체에 적용(Figma). */
  mixed?: boolean;
};

// 포인터 캡처 — 비활성 pointerId(합성/펜 등)면 throw 하므로 방어.
function capture(el: Element, id: number) {
  try { el.setPointerCapture(id); } catch { /* 무시 */ }
}
function release(el: Element, id: number) {
  try { el.releasePointerCapture(id); } catch { /* 무시 */ }
}

function clampVal(v: number, min?: number, max?: number): number {
  if (min != null) v = Math.max(min, v);
  if (max != null) v = Math.min(max, v);
  return v;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  precision,
  label,
  unit,
  disabled,
  displayScale = 1,
  mixed,
}: NumberInputProps) {
  const [text, setText] = React.useState<string | null>(null);
  const dragRef = React.useRef<{ startX: number; startVal: number; lastVal?: number } | null>(null);

  const prec =
    precision ?? (step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0);
  const shown =
    text ??
    (mixed
      ? "Mixed"
      : Number.isFinite(value)
        ? (value * displayScale).toFixed(displayScale !== 1 ? Math.max(0, prec - Math.log10(displayScale)) : prec)
        : "0");

  const commit = (raw: string, live: boolean) => {
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const v = clampVal(parsed / displayScale, min, max);
    onChange(v, { live });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startVal: value };
    capture(e.target as HTMLElement, e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const deltaPx = e.clientX - d.startX;
    const next = Number(clampVal(d.startVal + deltaPx * step * mult, min, max).toFixed(6));
    d.lastVal = next;
    onChange(next, { live: true });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    release(e.target as HTMLElement, e.pointerId);
    // 마지막 스크럽 값으로 확정 — 렌더 시점의 stale prop(value) 커밋 금지.
    onChange(clampVal(d.lastVal ?? value, min, max), { live: false });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const dir = e.key === "ArrowUp" ? 1 : -1;
      onChange(clampVal(value + dir * step * mult, min, max), { live: false });
    }
  };

  // 값 영역 자체 드래그 스크럽 (Figma) — 포커스 전 상태에서 잡고 좌우로 끌면 증감,
  // 안 움직이고 놓으면 그때 포커스(타이핑 모드). 편집 중(포커스)엔 캐럿 드래그 유지.
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fieldDrag = React.useRef<{ startX: number; startVal: number; moved: boolean; lastVal?: number } | null>(null);
  const onInputPointerDown = (e: React.PointerEvent) => {
    if (disabled || document.activeElement === inputRef.current) return;
    e.preventDefault(); // 즉시 포커스/선택 막기 — 릴리즈 시 이동 없으면 그때 포커스
    fieldDrag.current = { startX: e.clientX, startVal: value, moved: false };
    capture(e.currentTarget as HTMLElement, e.pointerId);
  };
  const onInputPointerMove = (e: React.PointerEvent) => {
    const d = fieldDrag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const next = Number(clampVal(d.startVal + dx * step * mult, min, max).toFixed(6));
    d.lastVal = next;
    onChange(next, { live: true });
  };
  const onInputPointerUp = (e: React.PointerEvent) => {
    const d = fieldDrag.current;
    if (!d) return;
    fieldDrag.current = null;
    release(e.currentTarget as HTMLElement, e.pointerId);
    // 마지막 스크럽 값으로 확정 (stale prop 커밋 금지). 클릭(이동 없음)이면 편집 포커스.
    if (d.moved) onChange(clampVal(d.lastVal ?? value, min, max), { live: false });
    else inputRef.current?.focus();
  };

  return (
    <div className={s.field} style={disabled ? { opacity: 0.5 } : undefined}>
      {label != null && (
        <span
          className={s.numLabel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {label}
        </span>
      )}
      <input
        ref={inputRef}
        className={s.numInput}
        value={shown}
        inputMode="decimal"
        disabled={disabled}
        onPointerDown={onInputPointerDown}
        onPointerMove={onInputPointerMove}
        onPointerUp={onInputPointerUp}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value, true);
        }}
        onFocus={(e) => {
          setText(mixed ? "" : String((value * displayScale).toFixed(prec)));
          e.target.select();
        }}
        onBlur={(e) => {
          commit(e.target.value, false);
          setText(null);
        }}
        onKeyDown={onKeyDown}
      />
      {unit && <span className={s.numUnit}>{unit}</span>}
    </div>
  );
}
