"use client";

import styles from "./resize-handle.module.css";

interface Props {
  axis: "x" | "y";
  dragging: boolean;
  /** 패널 기준 어느 모서리에 붙일지. */
  side: "left" | "right" | "top";
  handleProps: Record<string, unknown>;
  label: string;
}

/**
 * 패널 경계의 드래그 핸들. 더블클릭하면 기본 크기로 돌아간다.
 */
export function ResizeHandle({
  axis,
  dragging,
  side,
  handleProps,
  label,
}: Props) {
  const position =
    side === "left"
      ? { left: -5 }
      : side === "right"
        ? { right: -5 }
        : { top: -5 };

  return (
    <div
      className={styles.handle}
      data-axis={axis}
      data-dragging={dragging || undefined}
      style={position}
      aria-label={`${label} 크기 조절`}
      title="드래그해서 크기 조절 · 더블클릭하면 기본값"
      {...handleProps}
    />
  );
}
