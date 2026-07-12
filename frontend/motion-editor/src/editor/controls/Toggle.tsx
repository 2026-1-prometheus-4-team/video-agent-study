"use client";

import s from "./controls.module.css";

export function Toggle({
  on,
  onChange,
  "aria-label": ariaLabel,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      className={s.toggle}
      data-on={on}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
    >
      <span className={s.toggleKnob} />
    </button>
  );
}
