"use client";

// AlphaColorInput — 스와치+hex(ColorInput) + 알파 % 입력 한 줄.
// rgba()/hex 문자열 필드용 (preset 의 fill/hairline/dim 등 반투명 색).
// 알파 100% 면 hex 로, 아니면 rgba() 로 저장한다.

import React from "react";
import { ColorInput } from "./ColorInput";
import { NumberInput } from "./NumberInput";
import s from "./controls.module.css";

function parseColor(v: string | undefined): { hex: string; alpha: number } {
  const dflt = { hex: "#FFFFFF", alpha: 1 };
  if (!v) return dflt;
  const t = v.trim();
  const m = t.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i);
  if (m) {
    const hex =
      "#" +
      [m[1], m[2], m[3]]
        .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
    return { hex, alpha: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1 };
  }
  if (/^#[0-9a-fA-F]{8}$/.test(t)) return { hex: t.slice(0, 7).toUpperCase(), alpha: parseInt(t.slice(7, 9), 16) / 255 };
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return { hex: t.toUpperCase(), alpha: 1 };
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    return { hex: ("#" + [...t.slice(1)].map((c) => c + c).join("")).toUpperCase(), alpha: 1 };
  }
  return dflt;
}

function composeColor(hex: string, alpha: number): string {
  if (alpha >= 0.995) return hex;
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${Number(alpha.toFixed(3))})`;
}

export function AlphaColorInput({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string, live: boolean) => void;
}) {
  const { hex, alpha } = parseColor(value);
  return (
    <div className={s.alphaColorRow}>
      <ColorInput value={hex} onChange={(v) => v && onChange(composeColor(v, alpha), false)} />
      <NumberInput
        value={alpha}
        min={0}
        max={1}
        step={0.01}
        displayScale={100}
        unit="%"
        onChange={(v, o) => onChange(composeColor(hex, v), o.live)}
      />
    </div>
  );
}
