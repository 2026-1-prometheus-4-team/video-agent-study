"use client";

// Select — 커스텀 팝오버 셀렉트. native <select> 안 씀(다크 팝오버 통일).
// 트리거 위치 기준 fixed 포털로 렌더(오버플로 탈출). 키보드 up/down/enter/esc.

import React from "react";
import { createPortal } from "react-dom";
import s from "./controls.module.css";

export type SelectOption = { value: string; label: string };

export type SelectProps = {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
};

export function Select({ value, options, onChange, placeholder }: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const [rect, setRect] = React.useState<DOMRect | null>(null);
  const [activeIdx, setActiveIdx] = React.useState(0);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const current = options.find((o) => o.value === value);

  const openMenu = () => {
    if (!triggerRef.current) return;
    setRect(triggerRef.current.getBoundingClientRect());
    setActiveIdx(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      const pop = document.getElementById("select-popover-active");
      if (pop?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", onScroll);
    window.addEventListener("wheel", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("wheel", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ")) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={s.selectTrigger}
        data-open={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        type="button"
      >
        <span className={s.selectValue}>
          {current?.label ?? placeholder ?? value}
        </span>
        <svg
          className={s.selectChevron}
          width="10"
          height="10"
          viewBox="0 0 10 10"
        >
          <path
            d="M2.5 4l2.5 2.5L7.5 4"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            id="select-popover-active"
            className={s.selectPopover}
            style={{
              left: rect.left,
              top: rect.bottom + 4,
              width: Math.max(rect.width, 140),
            }}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                className={s.selectItem}
                data-active={i === activeIdx}
                data-current={o.value === value}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.value === value && (
                  <svg
                    className={s.selectCheck}
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                  >
                    <path
                      d="M2.5 6.5l2.5 2.5 4.5-5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      fill="none"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
