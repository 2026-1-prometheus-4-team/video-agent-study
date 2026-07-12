// presets/statement/blur_reveal.ts
// STATEMENT preset. 단어가 강한 blur(추정 8~30px)로 등장해 풀리며 안착하는
// 텍스트 reveal. langease/numtera/nexus 등 app-launch 광고에서 텍스트 등장의
// 지배 패턴(8개 레퍼런스 중 5개). typewriter atom 의 revealBlur 를 단어 단위로
// 써서 각 단어가 blurry -> sharp + fade-in 으로 순차 등장한다.
//
// CEMENTED (LLM 비노출):
//   - blur 풀림 곡선(easeInOut, ComposedText 내부), 단어 등장 간격 대비 blur
//     duration 비율, exit(좌 slide + 단어별 erase) shape
// EXPOSED:
//   - text, blurAmount, pace, baseColor, duration, style(fontSize/Weight/Family)

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";

export type BlurRevealKnobs = CommonKnobs & {
  text: string;
  blurAmount?: number; // px, 등장 시작 blur. default 14.
  pace?: "slow" | "med" | "fast";
  baseColor?: string;
  duration: number;
};

// 단어 등장 간격(프레임). 느릴수록 단어 하나하나가 또박또박 떠오른다.
const PACE_GAP: Record<"slow" | "med" | "fast", number> = {
  slow: 14,
  med: 10,
  fast: 6,
};

export function blurReveal(knobs: BlurRevealKnobs, ctx: PresetCtx): SceneSpec {
  const blurAmount = knobs.blurAmount ?? 14;
  const gap = PACE_GAP[knobs.pace ?? "med"];
  // blur 풀림은 등장 간격보다 약간 길게 잡아 단어가 "살아있는" 느낌을 준다
  // (다음 단어가 떠오를 때 앞 단어가 아직 미세하게 또렷해지는 중).
  const blurDur = Math.max(6, Math.round(gap * 1.4));
  const baseColor = knobs.baseColor ?? "#FFFFFF";
  const fontFamily = knobs.fontFamily ?? ctx.brand.fontFamily;

  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.text,
      fontSize: knobs.fontSize ?? 5,
      fontWeight: clampFontWeight(knobs.fontWeight, 600),
      color: baseColor,
      ...(fontFamily ? { fontFamily } : {}),
    },
    layers: [
      // 등장: 단어별 strict beat(gap)로 순차. 각 단어가 blurAmount px 에서
      // 0 으로 풀리며 fade-in. reflow off 라 제자리에서 또렷해진다(레이아웃 고정).
      {
        type: "typewriter",
        role: "in",
        props: {
          unit: "word",
          cursor: "none",
          firstGap: gap,
          wordGap: gap,
          revealBlur: { from: blurAmount, duration: blurDur },
          reflow: "off",
        },
      },
      // 퇴장: 좌측으로 살짝 밀리며(easeIn) 단어별 erase(blur tail 동반).
      {
        type: "move",
        role: "out",
        props: { fromX: 0, toX: -0.05, duration: 16, easing: "easeIn" },
      },
      {
        type: "typewriter",
        role: "out",
        props: {
          unit: "word",
          mode: "erase",
          eraseFrom: "left",
          wordGap: 3,
          cursor: "none",
          revealBlur: { from: blurAmount, duration: blurDur },
        },
      },
    ],
  };

  return {
    duration: knobs.duration,
    transition_out: "hard_cut",
    elements: [element],
  };
}
