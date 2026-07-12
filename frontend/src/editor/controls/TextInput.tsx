"use client";

import React from "react";
import s from "./controls.module.css";

export function TextInput({
  value,
  onChange,
  placeholder,
  onCommit,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onCommit?: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <div className={s.field}>
      <input
        className={s.textInput}
        style={mono ? { fontFamily: "var(--font-mono-stack)" } : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}
