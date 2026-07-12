"use client";

// devCssWatchdog — dev 전용. Next(webpack) dev 가 컴파일 에러에서 복구될 때
// CSS modules chunk 를 유실하는 버그(스타일 통째로 빠진 화면) 자동 복구.
// 증상: _app-pages-browser_..._EditorShell_tsx.css 가 "preloaded but not used"
// 로만 반복되고 화면이 무스타일로 렌더 → 수동 새로고침 전까지 지속.
// 감지: EditorShell.module.css 의 .root(display:flex)가 실제로 적용되는지
// 프로브 요소로 주기 확인 → 빠졌으면 1회 자동 reload (루프 방지 가드 포함).

import React from "react";
import styles from "./EditorShell.module.css";

const GUARD_KEY = "scene24:css-watchdog-reload";

function cssApplied(): boolean {
  const cls = styles.root;
  if (!cls) return true; // 모듈 자체가 못 불러졌으면 판단 불가 — 건드리지 않음
  const probe = document.createElement("div");
  probe.className = cls;
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const display = getComputedStyle(probe).display;
  probe.remove();
  return display === "flex"; // .root { display:flex } 가 살아있는가
}

export function useDevCssWatchdog() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (cssApplied()) return;
      // 연속 리로드 루프 방지: 10초 안에 이미 리로드했으면 포기(진짜 빌드 깨짐).
      const last = Number(sessionStorage.getItem(GUARD_KEY) ?? 0);
      if (Date.now() - last < 10_000) return;
      sessionStorage.setItem(GUARD_KEY, String(Date.now()));
      window.location.reload();
    }, 2000);
    return () => clearInterval(t);
  }, []);
}
