// compose/base44Ad.ts
// Base44 브랜딩 시네마틱 광고 — LLM 이 뱉었다고 가정한 조합(AdInput).
// 우리가 구현한 텍스트 효과들(apple_text / word_gap_settle / characters_settle /
// letters_whoosh / flip / stat_reveal / words_up / flicker + group + glow + palette)
// 을 실제로 조합해 만든다. composeAd(BASE44_AD) -> Root "Base44Ad" 컴포로 재생.
//
// Base44 브랜드: 80s synthwave 선셋. 밝은 크림 배경 + 다크 텍스트 + 주황 태양 액센트.
// (측정 근거: AdOps/base44_analysis.md, specs/preset/base44-v3.json)
//
// 대비 규칙(중요): 배경과 텍스트는 항상 대비되게.
//   - 크림 배경(CREAM) 씬  -> 다크 텍스트(INK), 액센트만 주황(SUN).
//   - 더스크 배경(DUSK) 씬  -> 라이트 텍스트(WARM), 태양 액센트(SUN).
//   검정 배경에 검정/어두운 텍스트, 밝은 배경에 흰색 텍스트 같은 저대비 조합 금지.
//   stat_reveal.baseColor 는 디폴트(#111111)면 어두운 배경서 사라지므로 씬마다 명시.

import type { AdInput } from "./compose";

// 브랜드 토큰 -------------------------------------------------------------
const CREAM = "#FAF9F7"; // 낮(라이트) 배경
const INK = "#0F0F0F"; // 크림 위 텍스트(고대비)
const SUN = "#FF7F47"; // 주황 태양 액센트(크림 위 큰 글자 OK, 더스크 위 pop)
const WARM = "#FFF3E8"; // 더스크 위 텍스트(라이트)
// 더스크: 심야 자주 -> 마젠타 -> 선셋 주황. 어두워서 라이트 텍스트가 읽힌다.
const DUSK = "linear-gradient(180deg, #241B3A 0%, #6B2D5C 55%, #C24E3A 100%)";

export const BASE44_AD: AdInput = {
  fps: 24,
  fontFamily: "Familjen Grotesk, Inter, system-ui, sans-serif",
  background: CREAM, // 전역 디폴트를 크림으로 -> 배경 미지정 씬도 대비 안전
  scenes: [
    // S1 콜드오픈: 한 단어가 강블러에서 초점 맞으며 등장(키노트). 크림/다크.
    {
      duration: 1.5,
      elements: [
        {
          structural: { effect: "apple_text" },
          surface: { text: "Idea?", fontSize: 11, fontWeight: 600, color: INK, position: { x: 0.5, y: 0.5 } },
          effects: { glow: { strength: "soft", color: "auto" } },
        },
      ],
    },

    // S2 후킹 질문: 단어 간격 조여지며 쫀득 등장. 크림/다크.
    {
      duration: 2.7,
      elements: [
        {
          structural: { effect: "word_gap_settle" },
          surface: { text: "What if shipping took minutes?", fontSize: 5, fontWeight: 500, color: INK, position: { x: 0.5, y: 0.5 } },
          effects: { glow: { strength: "soft", color: "auto" } },
        },
      ],
    },

    // S3~S5 리듬 비트(3연타): 서로 다른 등장으로 텍스트 효과 다양성 + 속도감.
    // S3 "Type." 글자 조립 안착. 크림/다크.
    {
      duration: 0.7,
      elements: [
        {
          structural: { effect: "characters_settle" },
          surface: { text: "Type.", fontSize: 6.5, fontWeight: 600, color: INK, position: { x: 0.5, y: 0.5 } },
        },
      ],
    },
    // S4 "Tweak." 아래서 수루룩 솟음. 크림/다크.
    {
      duration: 0.7,
      elements: [
        {
          structural: { effect: "letters_whoosh", direction: "up" },
          surface: { text: "Tweak.", fontSize: 6.5, fontWeight: 600, color: INK, position: { x: 0.5, y: 0.5 } },
        },
      ],
    },
    // S5 "Ship." 3D 플립으로 착지(액센트 비트). 크림 위 주황 + 강글로우.
    // structural 은 단어를 즉시 띄우는 typewriter(word), 플립 wrapper 가 주 모션.
    {
      duration: 1.0,
      elements: [
        {
          structural: { effect: "typewriter", unit: "word" },
          surface: { text: "Ship.", fontSize: 8, fontWeight: 700, color: SUN, position: { x: 0.5, y: 0.5 } },
          wrappers: [{ type: "flip", feel: "bounce" }],
          effects: { glow: { strength: "strong", color: SUN } },
        },
      ],
    },

    // S6 핵심 지표: 숫자 카운트 + 라벨을 부제와 그룹으로 묶어 함께 떠오름. 크림/다크.
    {
      duration: 3.4,
      elements: [
        {
          group: [
            {
              structural: {
                effect: "stat_reveal",
                prefix: "",
                prefixSide: "right",
                from: 0,
                to: 50000,
                suffix: "+ builders",
                suffixMode: "static",
                baseColor: INK,
                landColor: SUN,
              },
              surface: { fontSize: 12, fontWeight: 600, color: INK, position: { x: 0.5, y: 0.44 } },
            },
            {
              structural: { effect: "word_gap_settle" },
              surface: { text: "shipping every day", fontSize: 2.6, fontWeight: 500, color: INK, position: { x: 0.5, y: 0.6 } },
            },
          ],
          motion: [
            { type: "scale", feel: "settle" },
            { type: "move", dir: "up" },
          ],
        },
      ],
    },

    // S7 톤 전환(낮->해질녘): 배경이 더스크로 크로스페이드. 라이트 텍스트 + 주황 교차(palette).
    {
      duration: 2.8,
      backgroundGradient: DUSK,
      backgroundFadeIn: 16, // 이전 크림 배경 위로 더스크가 16프레임에 걸쳐 물듦(시네마틱 전환)
      elements: [
        {
          structural: { effect: "words_up" },
          surface: { text: "The sun never sets on your ideas", fontSize: 4.4, fontWeight: 500, color: WARM, position: { x: 0.5, y: 0.5 } },
          color: { mode: "palette", colors: [WARM, SUN] }, // 단어별 라이트/주황 교차(더스크 위 둘 다 읽힘)
          effects: { glow: { strength: "soft", color: "auto" } },
        },
      ],
    },

    // S8 브랜드 로고 리빌: 주황 태양 + "Base 44" 워드마크. 더스크 위라 워드마크는 라이트.
    {
      duration: 2.6,
      backgroundGradient: DUSK,
      elements: [
        {
          logo: {
            base: { kind: "base44-wordmark", size: 15, accentColor: WARM, bladeColor: SUN, position: { x: 0.5, y: 0.5 } },
            fadeIn: { delay: 2, duration: 12 },
            scaleIn: { from: 0.82, to: 1, delay: 2, duration: 16 },
          },
        },
      ],
    },

    // S9 아웃트로 태그라인: 깜빡이며 등장. 더스크/라이트("44" 브랜드 넘버 라임).
    {
      duration: 2.4,
      backgroundGradient: DUSK,
      elements: [
        {
          structural: { effect: "flicker" },
          surface: { text: "Build 44 things before lunch.", fontSize: 3.6, fontWeight: 500, color: WARM, position: { x: 0.5, y: 0.5 } },
          effects: { glow: { strength: "soft", color: "auto" } },
        },
      ],
    },
  ],
};
