"use client";

// Section — 접을 수 있는 인스펙터 섹션. 헤더 11px/550, 선택적 '+' 액션.

import React from "react";
import s from "./controls.module.css";

export function Section({
  title,
  children,
  defaultOpen = true,
  onAdd,
  addLabel,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onAdd?: () => void;
  addLabel?: string;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className={s.section}>
      <div className={s.sectionHeader} onClick={() => setOpen((o) => !o)}>
        <svg
          className={s.sectionChevron}
          data-collapsed={!open}
          width="9"
          height="9"
          viewBox="0 0 10 10"
        >
          <path
            d="M3 2.5l3 2.5-3 2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            transform="rotate(90 5 5)"
          />
        </svg>
        <span className={s.sectionTitle}>{title}</span>
        {onAdd && (
          <button
            className={s.sectionAction}
            title={addLabel ?? "Add"}
            onClick={(e) => {
              e.stopPropagation();
              if (!open) setOpen(true);
              onAdd();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path
                d="M6 2.5v7M2.5 6h7"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      {open && <div className={s.sectionBody}>{children}</div>}
    </div>
  );
}

// Row — 라벨 + 컨트롤 (76px 라벨 그리드)
export function Row({
  label,
  children,
  wide,
}: {
  label?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (wide) {
    return (
      <div className={s.rowWide}>
        {label && <span className={s.rowLabel}>{label}</span>}
        {children}
      </div>
    );
  }
  return (
    <div className={s.row}>
      {label != null ? <span className={s.rowLabel}>{label}</span> : <span />}
      {children}
    </div>
  );
}
