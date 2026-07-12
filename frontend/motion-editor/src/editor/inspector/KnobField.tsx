"use client";

// KnobField — Knob 하나를 적절한 컨트롤로 렌더. 값/onChange 는 부모가 주입(dumb).

import React from "react";
import type { Knob } from "@/editor/schema";
import { NumberInput, ColorInput, Select, Toggle, TextInput, EasingChip, Row } from "@/editor/controls";
import type { EasingEditorTarget } from "@/editor/store";
import s from "./inspector.module.css";

export function KnobField({
  knob,
  value,
  onChange,
  easingTarget,
}: {
  knob: Knob;
  value: unknown;
  onChange: (v: unknown, opts: { live: boolean }) => void;
  easingTarget?: EasingEditorTarget;
}) {
  const label = (
    <span className={s.knobLabel} data-cemented={knob.cemented}>
      {knob.cemented && <LockGlyph />}
      {knob.label}
    </span>
  );

  let control: React.ReactNode;
  switch (knob.kind) {
    case "number":
      control = (
        <NumberInput
          value={typeof value === "number" ? value : (knob.default as number) ?? 0}
          min={knob.min}
          max={knob.max}
          step={knob.step ?? 1}
          unit={knob.unit === "frames" ? "f" : knob.unit === "x" ? "×" : knob.unit === "deg" ? "°" : knob.unit === "px" ? "px" : undefined}
          onChange={(v, o) => onChange(v, o)}
        />
      );
      break;
    case "color":
      control = (
        <ColorInput
          value={typeof value === "string" ? value : (knob.default as string | undefined)}
          onChange={(v) => onChange(v, { live: false })}
          clearable
        />
      );
      break;
    case "enum":
      control = (
        <Select
          value={typeof value === "string" ? value : (knob.default as string) ?? knob.values?.[0]?.value ?? ""}
          options={knob.values ?? []}
          onChange={(v) => onChange(v, { live: false })}
        />
      );
      break;
    case "bool":
      control = (
        <Toggle
          on={value === true}
          onChange={(v) => onChange(v, { live: false })}
          aria-label={knob.label}
        />
      );
      break;
    case "string":
      control = (
        <TextInput
          value={typeof value === "string" ? value : (knob.default as string) ?? ""}
          onChange={(v) => onChange(v, { live: true })}
          onCommit={(v) => onChange(v, { live: false })}
        />
      );
      break;
    case "easing":
      control = (
        <EasingChip
          value={typeof value === "string" ? value : undefined}
          target={easingTarget ?? {}}
        />
      );
      break;
    case "colorList":
      control = (
        <ColorListField
          value={Array.isArray(value) ? (value as string[]) : (knob.default as string[]) ?? ["#FFFFFF"]}
          onChange={(v) => onChange(v, { live: false })}
        />
      );
      break;
  }

  if (knob.kind === "colorList" || knob.kind === "easing") {
    return (
      <Row label={knob.label} wide>
        {control}
      </Row>
    );
  }

  return (
    <div className={s.knobRow}>
      {label}
      <div className={s.knobControl}>{control}</div>
    </div>
  );
}

function ColorListField({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <div className={s.colorList}>
      {value.map((c, i) => (
        <div key={i} className={s.colorListItem}>
          <ColorInput
            value={c}
            onChange={(v) => {
              const next = [...value];
              next[i] = v ?? "#FFFFFF";
              onChange(next);
            }}
          />
          {value.length > 1 && (
            <button
              className={s.colorListRemove}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              title="Remove"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2 5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      ))}
      <button className={s.colorListAdd} onClick={() => onChange([...value, "#FFFFFF"])}>
        + Add color
      </button>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" className={s.lockGlyph}>
      <rect x="2" y="4.5" width="6" height="4" rx="0.8" stroke="currentColor" strokeWidth="0.9" fill="none" />
      <path d="M3.3 4.5V3.4a1.7 1.7 0 013.4 0v1.1" stroke="currentColor" strokeWidth="0.9" fill="none" />
    </svg>
  );
}
