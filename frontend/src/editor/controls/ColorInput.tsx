"use client";

// ColorInput — 스와치 + hex 텍스트. 스와치 위에 숨겨진 native color picker.
// clearable 이면 값 비우기(undefined) 가능(체커보드 스와치).

import React from "react";
import s from "./controls.module.css";
import { ColorPicker } from "./ColorPicker";

export type ColorInputProps = {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  clearable?: boolean;
};

function normalizeHex(v: string): string | null {
  let h = v.trim();
  if (!h) return null;
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9a-fA-F]{3}$/.test(h) || /^#[0-9a-fA-F]{6}$/.test(h)) {
    return h.toUpperCase();
  }
  return null;
}

export function ColorInput({ value, onChange, clearable }: ColorInputProps) {
  const [text, setText] = React.useState<string | null>(null);
  const [picker, setPicker] = React.useState<{ x: number; y: number } | null>(null);
  const shown = text ?? (value ?? "");

  return (
    <div className={s.colorField}>
      {/* 커스텀 피커 (피그마 구조) — 네이티브 input[color] 대체 */}
      <button
        className={`${s.swatch} ${value ? "" : s.swatchEmpty}`}
        style={{ ...(value ? { background: value } : {}), border: "none", cursor: "pointer", padding: 0 }}
        aria-label="Select color"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPicker({ x: r.left - 260, y: r.top - 40 });
        }}
      />
      {picker && (
        <ColorPicker
          value={value ?? "#FFFFFF"}
          anchor={picker}
          onChange={(hex) => onChange(hex)}
          onClose={() => setPicker(null)}
        />
      )}
      <input
        className={s.colorHex}
        value={shown}
        placeholder="None"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const n = normalizeHex(e.target.value);
          if (n) onChange(n);
        }}
        onFocus={() => setText(value ?? "")}
        onBlur={(e) => {
          const n = normalizeHex(e.target.value);
          if (n) onChange(n);
          else if (!e.target.value.trim() && clearable) onChange(undefined);
          setText(null);
        }}
      />
      {clearable && value != null && (
        <button
          className={s.colorClear}
          onClick={() => onChange(undefined)}
          title="Clear color"
          aria-label="Clear color"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M2 2l6 6M8 2l-6 6"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
