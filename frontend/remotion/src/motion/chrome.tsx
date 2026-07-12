// chrome.tsx — frame 요소의 디바이스 크롬 (A3 mockup).
//
// 구조 원칙: mockup 은 새 element 가 아니라 "frame 의 표면 스타일"이다.
// frame 이 이미 가진 것(클리핑/fill=스크린샷/자식/키프레임/motionPath/조명)을
// 전부 상속하고, chrome 은 (a) 콘텐츠 영역 인셋 (b) 장식 오버레이만 더한다.
// AE 대응: 디바이스 목업 = 프리컴프를 디바이스 아트웍 안에 넣는 것 — 컨테이너
// 문제지 새 개체 문제가 아님.
//
// cemented (관찰 기반 — macOS Chrome / iPhone 15 시각 관례, 실측 표기):
//  - browser 바 높이: 프레임 폭의 4.5% (clamp 26..46px @1920), 신호등 지름
//    바 높이의 30%, 간격 지름의 60%, URL 필 높이 바의 62%.
//  - phone 베젤: 프레임 짧은 변의 2.2% (clamp 8..18px), 다이나믹 아일랜드
//    폭 = 프레임 폭 26%, 높이 = 베젤*1.9, 코너 반경 = 짧은 변 12%.

import React from "react";

export type FrameChromeSpec = {
  kind: "browser" | "phone";
  /** 크롬 톤. 기본 dark. */
  theme?: "dark" | "light";
  /** browser 주소창 텍스트. */
  url?: string;
  /** phone 상태바 (기본 true) — 시간 + 셀룰러/와이파이/배터리. */
  statusBar?: boolean;
  /** phone 상태바 시간 (기본 "9:41" — Apple 마케팅 관례 시각). */
  time?: string;
};

const BROWSER = {
  barFrac: 0.045,
  barMin: 26,
  barMax: 46,
} as const;

// iPhone 15 Pro 실측 규격(공개 논리 포인트) — 스크린 393x852pt, 디스플레이
// 코너 반경 55pt, 다이나믹 아일랜드 126x37pt(스크린 상단에서 11pt), 상태바
// 유효 높이 54pt, 베젤(티타늄 링) 약 6pt. 프레임 폭 = 바디 폭(393+12=405pt)
// 으로 보고 u = wPx/405 스케일로 전 치수를 비율 유지.
const PHONE = {
  bodyPt: 405,
  bezelPt: 6,
  screenRadiusPt: 55,
  islandWPt: 126,
  islandHPt: 37,
  islandTopPt: 11,
  statusHPt: 54,
  timePt: 17,
} as const;
const phoneU = (wPx: number) => wPx / PHONE.bodyPt;

/** 크롬별 콘텐츠(스크린) 인셋 px — FrameBox 가 fill/자식 영역을 이만큼 안으로. */
export function chromeInsets(
  chrome: FrameChromeSpec | undefined,
  wPx: number,
  hPx: number,
): { top: number; right: number; bottom: number; left: number; screenRadius: number } {
  if (!chrome) return { top: 0, right: 0, bottom: 0, left: 0, screenRadius: 0 };
  if (chrome.kind === "browser") {
    const bar = Math.min(BROWSER.barMax, Math.max(BROWSER.barMin, wPx * BROWSER.barFrac));
    return { top: bar, right: 0, bottom: 0, left: 0, screenRadius: 0 };
  }
  const u = phoneU(wPx);
  const bezel = PHONE.bezelPt * u;
  return { top: bezel, right: bezel, bottom: bezel, left: bezel, screenRadius: PHONE.screenRadiusPt * u };
}

/** frame 전체의 강제 코너 반경 (phone 은 디바이스 형상이 radius 를 정의). */
export function chromeRadius(chrome: FrameChromeSpec | undefined, wPx: number, hPx: number, baseRadius: number): number {
  if (chrome?.kind === "phone") return (PHONE.screenRadiusPt + PHONE.bezelPt) * phoneU(wPx);
  return baseRadius;
}

/** 장식 오버레이 (콘텐츠 위에 그려지는 크롬 아트웍). */
export function ChromeOverlay(props: { chrome: FrameChromeSpec; wPx: number; hPx: number }): React.ReactElement {
  const { chrome, wPx } = props;
  const dark = (chrome.theme ?? "dark") === "dark";

  if (chrome.kind === "browser") {
    const bar = Math.min(BROWSER.barMax, Math.max(BROWSER.barMin, wPx * BROWSER.barFrac));
    const dot = bar * 0.3;
    const gap = dot * 0.6;
    const pillH = bar * 0.62;
    const barBg = dark ? "#2B2F36" : "#E9ECF0";
    const pillBg = dark ? "#1C1F24" : "#FFFFFF";
    const urlColor = dark ? "#9AA3AF" : "#5F6B7A";
    return (
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: bar,
            background: barBg,
            display: "flex",
            alignItems: "center",
            paddingLeft: dot,
          }}
        >
          {/* 신호등 */}
          {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
            <span key={c} style={{ width: dot, height: dot, borderRadius: "50%", background: c, marginRight: gap, flex: "none" }} />
          ))}
          {/* URL 필 */}
          <div
            style={{
              flex: 1,
              height: pillH,
              margin: `0 ${bar * 0.5}px 0 ${bar * 0.35}px`,
              borderRadius: pillH / 2,
              background: pillBg,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: pillH * 0.52,
              fontFamily: "Inter, Helvetica, Arial, sans-serif",
              color: urlColor,
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
          >
            {chrome.url ?? "app.example.com"}
          </div>
        </div>
      </div>
    );
  }

  // phone — iPhone 15 Pro 실측 비율: 베젤 링(6pt) + 스크린 크롬(아일랜드/상태바).
  // 스크린 좌표 크롬은 PhoneScreenChrome 공용 컴포넌트 (3D 목업 스크린과 공유).
  const u = phoneU(wPx);
  const bezel = PHONE.bezelPt * u;
  const bodyRadius = (PHONE.screenRadiusPt + PHONE.bezelPt) * u;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
      {/* 티타늄 바디 링 */}
      <div style={{ position: "absolute", inset: 0, borderRadius: bodyRadius, boxShadow: `inset 0 0 0 ${bezel}px #000000` }} />
      {/* 스크린 영역(베젤 안쪽) 크롬 — 아일랜드 + 상태바 */}
      <div style={{ position: "absolute", inset: bezel }}>
        <PhoneScreenChrome screenW={wPx - bezel * 2} dark={dark} statusBar={chrome.statusBar !== false} time={chrome.time} />
      </div>
    </div>
  );
}

// 스크린 논리 규격 — iPhone 15 Pro 393x852pt, 아일랜드 126x37 @ 상단 11pt.
// u = screenW/393 스케일. 2D 크롬(베젤 안쪽)과 3D 목업 스크린 오버레이가 공유.
const SCREEN = { wPt: 393, islandWPt: 126, islandHPt: 37, islandTopPt: 11, timePt: 17 } as const;

/** 스크린 좌표계 phone 크롬 — 다이나믹 아일랜드 + 상태바(시간/셀룰러/와이파이/배터리).
 *  부모는 스크린 영역 크기의 컨테이너(position 기준). */
export function PhoneScreenChrome(props: { screenW: number; dark?: boolean; statusBar?: boolean; time?: string }): React.ReactElement {
  const { screenW, dark = true, statusBar = true, time } = props;
  const u = screenW / SCREEN.wPt;
  const islandW = SCREEN.islandWPt * u;
  const islandH = SCREEN.islandHPt * u;
  const islandTop = SCREEN.islandTopPt * u;
  const fg = dark ? "#FFFFFF" : "#000000";
  const earW = (screenW - islandW) / 2;
  const iconH = 12 * u;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* 다이나믹 아일랜드 */}
      <div
        style={{
          position: "absolute",
          top: islandTop,
          left: "50%",
          transform: "translateX(-50%)",
          width: islandW,
          height: islandH,
          borderRadius: islandH / 2,
          background: "#000000",
        }}
      />
      {statusBar && (
        <>
          {/* 시간 — 좌측 귀 중앙 (SF 계열 시스템 폰트, semibold) */}
          <div
            style={{
              position: "absolute",
              top: islandTop,
              left: 0,
              width: earW,
              height: islandH,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif",
              fontWeight: 600,
              fontSize: SCREEN.timePt * u,
              letterSpacing: "-0.01em",
              color: fg,
            }}
          >
            {time ?? "9:41"}
          </div>
          {/* 우측 귀 — 셀룰러 / 와이파이 / 배터리 */}
          <div
            style={{
              position: "absolute",
              top: islandTop,
              right: 0,
              width: earW,
              height: islandH,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7 * u,
              color: fg,
            }}
          >
            {/* 셀룰러 4바 */}
            <svg width={20 * u} height={iconH} viewBox="0 0 20 12" fill="none">
              {[0, 1, 2, 3].map((i) => (
                <rect key={i} x={i * 5.2} y={12 - (4.5 + i * 2.5)} width={3.6} height={4.5 + i * 2.5} rx={1} fill="currentColor" />
              ))}
            </svg>
            {/* 와이파이 */}
            <svg width={17 * u} height={iconH} viewBox="0 0 17 12" fill="none">
              <path d="M8.5 10.6a1.6 1.6 0 100 .01zM4.7 7.8a5.6 5.6 0 017.6 0l-1.5 1.6a3.4 3.4 0 00-4.6 0zM1.6 4.7a10 10 0 0113.8 0l-1.5 1.6a7.8 7.8 0 00-10.8 0z" fill="currentColor" />
            </svg>
            {/* 배터리 */}
            <svg width={27 * u} height={iconH} viewBox="0 0 27 12" fill="none">
              <rect x="0.8" y="0.8" width="21.5" height="10.4" rx="3" stroke="currentColor" strokeWidth="1.1" opacity="0.4" />
              <rect x="2.4" y="2.4" width="18.3" height="7.2" rx="1.8" fill="currentColor" />
              <path d="M24.2 4v4a2.2 2.2 0 000-4z" fill="currentColor" opacity="0.4" />
            </svg>
          </div>
        </>
      )}
    </div>
  );
}
