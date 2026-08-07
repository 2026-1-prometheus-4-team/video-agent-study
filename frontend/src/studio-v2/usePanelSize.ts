"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** localStorage 키 — 새로고침해도 사용자가 맞춰둔 크기가 남는다. */
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  axis: "x" | "y";
  /** 끌었을 때 커지는 방향. 오른쪽/아래로 끌어 커지면 +1, 반대면 -1. */
  dir: 1 | -1;
}

/**
 * 패널 크기 드래그 훅.
 *
 * 드래그 중에는 dragging=true 를 돌려줘 호출부가 CSS transition 을 끌 수 있게
 * 한다. 매 프레임 크기가 바뀌는데 transition 이 켜져 있으면 손가락을 쫓아오지
 * 못하고 끌리는 느낌이 난다. 접기/펴기 애니메이션은 그대로 두고 여기서만 끈다.
 */
export function usePanelSize({
  storageKey,
  initial,
  min,
  max,
  axis,
  dir,
}: Options) {
  const [size, setSize] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ start: number; base: number } | null>(null);

  // SSR 과 첫 페인트를 맞추려고 initial 로 시작하고, 마운트 후 저장값을 반영.
  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    const n = Number(saved);
    if (Number.isFinite(n)) setSize(Math.max(min, Math.min(max, n)));
  }, [storageKey, min, max]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      drag.current = {
        start: axis === "x" ? e.clientX : e.clientY,
        base: size,
      };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [axis, size]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const cur = axis === "x" ? e.clientX : e.clientY;
      const next = d.base + (cur - d.start) * dir;
      setSize(Math.round(Math.max(min, Math.min(max, next))));
    },
    [axis, dir, min, max]
  );

  const end = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    setSize((s) => {
      window.localStorage.setItem(storageKey, String(s));
      return s;
    });
  }, [storageKey]);

  // 더블클릭이면 기본값으로 되돌린다 — 잘못 끌었을 때 복구 수단이 없으면
  // 사용자가 크기를 만지는 걸 꺼리게 된다.
  const onDoubleClick = useCallback(() => {
    setSize(initial);
    window.localStorage.setItem(storageKey, String(initial));
  }, [initial, storageKey]);

  return {
    size,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onDoubleClick,
      role: "separator" as const,
      "aria-orientation": (axis === "x" ? "vertical" : "horizontal") as
        | "vertical"
        | "horizontal",
      tabIndex: -1,
    },
  };
}
