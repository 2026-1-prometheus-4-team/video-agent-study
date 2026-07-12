"use client";

// Segmented — 리세스드 트랙 + 슬라이딩 thumb. 활성은 한 단계 밝은 서피스(accent 아님).

import React from "react";
import s from "./controls.module.css";

export type SegmentedProps<T extends string> = {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
};

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const n = options.length;
  return (
    <div className={s.segmented}>
      {/* thumb 폭 = (콘텐츠 - 아이템 사이 gap 합) / n — gap 을 무시하면
          오른쪽 칩일수록 어긋난다 (실측 리포트). translateX 100% = thumb 자신 폭. */}
      <div
        className={s.segThumb}
        style={{
          width: `calc((100% - ${(n - 1) * 2 + 4}px) / ${n})`,
          transform: `translateX(calc(${idx * 100}% + ${idx * 2}px))`,
          left: 2,
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={s.segItem}
          data-active={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
