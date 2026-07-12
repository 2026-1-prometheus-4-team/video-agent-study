// motion/logos/base44.tsx
// base44 재현용 sun-set 로고 (80s synthwave: 동그라미 + 아래 4개의 점점
// 짧아지는 horizontal line = 수면 반사). 측정: 주황 #FF8B5A 동그라미 +
// 4 lines, 워드마크는 "Base 44" 검정 Bold, sun 좌 + 텍스트 우 한 줄.
//
// prop 이름은 기존 LOGO_REGISTRY 컴포넌트(Scene24Mark)와 동일한 계약을
// 유지한다: sizePx / bladeColor / accentColor. 여기서 bladeColor = sun 색,
// accentColor = 워드마크 텍스트 색.

import React from "react";

export const Base44SunMark: React.FC<{
  sizePx: number;
  bladeColor?: string;
  accentColor?: string;
}> = ({ sizePx, bladeColor = "#FF8B5A" }) => (
  <svg
    width={sizePx}
    height={sizePx}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Base 44 sun"
  >
    <circle cx="24" cy="14" r="9.5" fill={bladeColor} />
    <line x1="7" y1="29" x2="41" y2="29" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="11" y1="34" x2="37" y2="34" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="16" y1="39" x2="32" y2="39" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
    <line x1="20" y1="44" x2="28" y2="44" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// sun + "Base 44" 한 줄 lockup. sizePx 는 HEIGHT — 폭은 220:48 비율로
// 자동 스케일 (Scene24Wordmark 와 같은 규약). SVG text 는 로드된 웹폰트
// (Familjen Grotesk)를 쓴다.
export const Base44SunWordmark: React.FC<{
  sizePx: number;
  bladeColor?: string;
  accentColor?: string;
}> = ({ sizePx, bladeColor = "#FF8B5A", accentColor = "#1A1A1A" }) => {
  const widthPx = sizePx * (220 / 48);
  return (
    <svg
      width={widthPx}
      height={sizePx}
      viewBox="0 0 220 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Base 44"
    >
      <circle cx="24" cy="14" r="9.5" fill={bladeColor} />
      <line x1="7" y1="29" x2="41" y2="29" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
      <line x1="11" y1="34" x2="37" y2="34" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
      <line x1="16" y1="39" x2="32" y2="39" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
      <line x1="20" y1="44" x2="28" y2="44" stroke={bladeColor} strokeWidth="3" strokeLinecap="round" />
      <text
        x="56"
        y="34"
        fontFamily="Familjen Grotesk, Inter, system-ui, sans-serif"
        fontSize="30"
        fontWeight="700"
        letterSpacing="-0.5"
        fill={accentColor}
      >
        Base 44
      </text>
    </svg>
  );
};
