"use client";

// usePanelResize — 패널(좌 사이드바/우 인스펙터/하단 타임라인) 크기 드래그 훅.
// 크기는 스토어 UI 값(leftWidth/rightWidth/bottomHeight)에 저장 → 세션 유지.
// 드래그 중에는 dragging=true 를 돌려줘 패널이 CSS transition 을 끄게 한다
// (매 프레임 폭이 바뀌는데 transition 이 켜져 있으면 끌린다). 접기/펴기 때만 애니메이션.

import React from "react";
import { useEditor } from "./store";

type SizeKey = "leftWidth" | "rightWidth" | "bottomHeight";

export function usePanelResize(opts: {
  key: SizeKey;
  axis: "x" | "y";
  /** 드래그 방향 부호. 오른쪽/아래로 끌 때 커지는 핸들 = +1, 반대 = -1. */
  dir: 1 | -1;
  min: number;
  max: number;
}) {
  const [dragging, setDragging] = React.useState(false);
  const ref = React.useRef<{ start: number; base: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const base = useEditor.getState().ui[opts.key];
    ref.current = { start: opts.axis === "x" ? e.clientX : e.clientY, base };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = ref.current;
    if (!d) return;
    const cur = opts.axis === "x" ? e.clientX : e.clientY;
    const next = Math.max(opts.min, Math.min(opts.max, d.base + (cur - d.start) * opts.dir));
    useEditor.getState().setUI({ [opts.key]: Math.round(next) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!ref.current) return;
    ref.current = null;
    setDragging(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return { dragging, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
}
