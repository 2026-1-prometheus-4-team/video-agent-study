"use client";

// EasingChip — 이징 이름 + 16x16 커브 미리보기. 클릭하면 이징 에디터 열기.

import React from "react";
import { useEditor } from "@/editor/store";
import type { EasingEditorTarget } from "@/editor/store";
import { sampleEasing, yRange, pointsToPath } from "@/editor/curveSample";
import s from "./controls.module.css";

export function EasingChip({
  value,
  target,
}: {
  value: string | undefined;
  target: EasingEditorTarget;
}) {
  const setUI = useEditor((st) => st.setUI);
  const pts = React.useMemo(() => sampleEasing(value, 24), [value]);
  const { min, max } = yRange(pts);
  const path = pointsToPath(pts, 20, 20, 3, min, max);
  const display = value ?? "easeOut";

  return (
    <button
      type="button"
      className={s.easingChip}
      onClick={() => setUI({ easingEditor: { ...target, value } })}
      title="Edit easing"
    >
      <svg className={s.easingChipCurve} width="20" height="20" viewBox="0 0 20 20">
        <path
          d={path}
          stroke="var(--accent-strong)"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {display}
      </span>
    </button>
  );
}
