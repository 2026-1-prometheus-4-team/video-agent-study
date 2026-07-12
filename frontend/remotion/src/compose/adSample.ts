// compose/adSample.ts
// LLM 이 뱉었다고 가정한 광고 조합(핀테크 3씬). effect 이름 + 텍스트/색/위치 +
// 그룹/wrapper/glow 만 적는다. 세부 타이밍/곡선 수치는 프리셋 고정이라 없음.
// composeAd(AD_SAMPLE) -> 실제 렌더 스펙. Root 의 "ComposeAd" 컴포로 스튜디오
// 에서 재생.

import type { AdInput } from "./compose";

export const AD_SAMPLE: AdInput = {
  fps: 24,
  fontFamily: "Geist",
  background: "#0B0C10",
  scenes: [
    // 씬1: 헤드라인이 글자 조립되며 등장.
    {
      duration: 2.8,
      elements: [
        {
          structural: { effect: "characters_settle" },
          surface: {
            text: "Instant payouts",
            fontSize: 7,
            fontWeight: 500,
            color: "#F5F6FA",
            position: { x: 0.5, y: 0.5 },
          },
        },
      ],
    },
    // 씬2: 핵심 지표(+55 ATMs)와 부제를 그룹으로 묶어 함께 떠오름.
    {
      duration: 3.6,
      elements: [
        {
          group: [
            {
              structural: {
                effect: "stat_reveal",
                prefix: "+",
                from: 0,
                to: 55,
                suffix: "ATMs",
                suffixMode: "reveal",
                baseColor: "#F5F6FA",
                landColor: "#E23B3B",
              },
              surface: { fontSize: 12, fontWeight: 500, color: "#F5F6FA", position: { x: 0.5, y: 0.46 } },
            },
            {
              structural: { effect: "word_gap_settle" },
              surface: {
                text: "across the country",
                fontSize: 2.3,
                fontWeight: 400,
                color: "#A7C0EC",
                position: { x: 0.5, y: 0.62 },
              },
            },
          ],
          motion: [
            { type: "scale", feel: "settle" },
            { type: "move", dir: "up" },
          ],
        },
      ],
    },
    // 씬3: 브랜드명이 깜빡이며 등장 + 은은한 글로우.
    {
      duration: 2.6,
      elements: [
        {
          structural: { effect: "flicker" },
          surface: {
            text: "NEOBANK",
            fontSize: 8,
            fontWeight: 600,
            color: "#F5F6FA",
            position: { x: 0.5, y: 0.5 },
          },
          effects: { glow: { strength: "soft", color: "auto" } },
        },
      ],
    },
  ],
};
