// presets/swap/scatter_assemble.ts
// SWAP preset. biasafe 인트로 안무를 함수화한 것. 긴 문장(fromText)이
// cardinal 방향으로 흩어져 소멸하고, 그 중 assembleText 글자 수만큼의
// survivor 만 살아남아 화면 가운데로 모이며 짧은 단어(예 "AI")로 변신 +
// 확대된다. s1c.json 의 수동 letter_choreography 안무를 알고리즘으로
// 일반화 — 아무 fromText/assembleText 조합이나 자동 생성한다.
//
// letterScatter(균일 모션 + survivor collapse) 대신 letter_choreography
// 를 쓰는 이유:
//   - char 변신(survivor -> "A"/"I")이 splitText 의 spacer + reflow 경로와
//     한 몸이라 letter_choreography 에서만 깔끔히 된다.
//   - scale 을 fontSize(em)로 키워서(transform: scale()의 픽셀 깨짐 회피)
//     글자가 5배 이상 커져도 선명하다(choreoStyle).
//   letterScatter 에는 이 둘이 없어 보강 비용이 더 크다 — 검증된 s1c 엔진
//   을 그대로 재활용한다.
//
// CEMENTED (LLM 비노출):
//   - 흩어짐 y 거리/방향, 소멸 stagger/순서, survivor 모임 x 추정,
//     scale 오버슈트 곡선, 전체 타이밍(scatter/morph/gather/scale 프레임)
//   - 모든 이동 easeOut
// EXPOSED:
//   - fromText, assembleText, baseColor, assembleColor, spread, duration(hint), style

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import type {
  ChoreoKeyframe,
  LetterChoreoProps,
} from "../../motion/structural/letterChoreography";
import type { ColorSpec } from "../../motion/color/engine";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";

export type ScatterAssembleKnobs = CommonKnobs & {
  fromText: string; // 흩어질 긴 문장
  assembleText: string; // survivor 가 조립할 짧은 글자(1-4), 예 "AI"
  baseColor?: string; // 흩어지는 글자 색
  assembleColor?: string; // 최종 조립 글자 색(예 보라). 생략 시 baseColor.
  spread?: number; // 흩어짐 거리(px). cement default 56.
  /** hint. 흩어짐~조립 안무는 고정 타이밍이라, 이 값이 더 길면 마지막
   *  조립 상태를 그만큼 더 hold 한다(짧으면 intrinsic 으로 clamp up). */
  duration?: number;
};

const FPS = 24;

// s1c.json 에서 검증된 타이밍(layer local frame). 흩어짐 -> hold -> survivor
// 변신 -> 가운데 모임 -> scale. 한 묶음으로만 의미가 있어 cement.
const T = {
  scatterEnd: 15, // 흩어짐 완료
  morph: 48, // survivor char 변신 + 모임 시작
  gatherMid: 60,
  gatherEnd: 74, // 가운데 모임 완료(y 중앙선 복귀 포함)
  scaleStart: 83,
  scalePeak: 84, // 살짝 오버슈트
  scaleEnd: 89, // scale 안착
  intrinsicEnd: 96, // 최소 길이(조립 hold 포함)
};
const FINAL_SCALE = 5.6;
const SCREEN_W = 1920; // x(px) 추정 기준 폭(1080p). 다른 해상도면 비례 유지.

function nonSpaceCount(text: string): number {
  return Math.max(1, text.replace(/\s/g, "").length);
}

export function scatterAssemble(
  knobs: ScatterAssembleKnobs,
  ctx: PresetCtx,
): SceneSpec {
  const fontSize = knobs.fontSize ?? 2.3;
  const fontWeight = clampFontWeight(knobs.fontWeight, 500);
  const baseColor = knobs.baseColor ?? "#FFFFFF";
  const assembleColor = knobs.assembleColor ?? baseColor;
  const brandFont = knobs.fontFamily ?? ctx.brand.fontFamily;
  const spread = knobs.spread ?? 56;

  const totalChars = nonSpaceCount(knobs.fromText);
  const assemble = knobs.assembleText.replace(/\s/g, "") || "AI";
  const k = assemble.length;

  // survivor charIdx: 문장을 k 등분한 안쪽 위치(양 끝 제외)에서 고른다.
  // char override 라 원래 글자가 무엇이든 assembleText 글자로 변신한다.
  // 짧은 문장에서 반올림이 겹치면 빈 칸으로 밀어 중복을 막는다.
  const survivors: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < k; i++) {
    const frac = (i + 1) / (k + 1);
    let idx = Math.round(frac * (totalChars - 1));
    while (used.has(idx) && idx < totalChars - 1) idx++;
    while (used.has(idx) && idx > 0) idx--;
    used.add(idx);
    survivors.push(idx);
  }

  // x(px) 추정: fontSize(vw) -> px. 한 글자 평균 폭 ~= fontSizePx * 0.55.
  // 런타임 레이아웃을 모르는 프리셋이 "가운데 모임"을 근사하기 위한 추정값.
  const fontSizePx = (fontSize / 100) * SCREEN_W;
  const glyphW = fontSizePx * 0.55;
  const centerIdx = (totalChars - 1) / 2;
  // 모인 큰 글자 사이 간격. 큰 글자는 거의 붙으므로 글자폭의 일부만.
  const bigSpacing = fontSizePx * FINAL_SCALE * 0.42;

  const tracks: Record<string, ChoreoKeyframe[]> = {};
  survivors.forEach((charIdx, i) => {
    // 흩어짐 방향: survivor 끼리 위/아래 번갈아(겹침 방지).
    const dir = i % 2 === 0 ? -1 : 1;
    const yScatter = dir * spread;
    // 모임 target x = (home 상쇄) + (assembleText 가운데 정렬 오프셋).
    const homeX = (charIdx - centerIdx) * glyphW;
    const targetOffset = (i - (k - 1) / 2) * bigSpacing;
    const gatherX = targetOffset - homeX;

    tracks[String(charIdx)] = [
      { frame: 0, x: 0, y: 0 },
      { frame: T.scatterEnd, y: yScatter, easing: "easeOut" },
      // 흩어진 채 hold 하다 morph 프레임에 변신.
      { frame: T.morph, y: yScatter },
      { frame: T.morph, char: assemble[i] },
      // 가운데로 가로 모임(2단계 easeOut) + y 중앙선 복귀.
      { frame: T.gatherMid, x: gatherX * 0.62, easing: "easeOut" },
      { frame: T.gatherEnd, x: gatherX, easing: "easeOut" },
      { frame: T.gatherEnd, y: 0, easing: "easeOut" },
      // scale: 작게 시작 -> 살짝 오버슈트 -> 안착. fontSize(em)라 선명.
      { frame: T.scaleStart, scale: FINAL_SCALE * 0.43, easing: "easeOut" },
      { frame: T.scalePeak, scale: FINAL_SCALE * 1.07, easing: "easeOut" },
      { frame: T.scaleEnd, scale: FINAL_SCALE, easing: "easeOut" },
    ];
  });

  // 나머지 글자(survivor 아닌 것): defaultExit 로 일괄 소멸. 가운데에서 먼
  // 글자(양 끝)부터 cardinal 방향으로 빠지며 fade(biasafe 소멸 순서).
  const defaultExit: NonNullable<LetterChoreoProps["defaultExit"]> = {
    frame: T.scatterEnd,
    duration: 22,
    spread,
    stagger: 1,
    center: Math.round(centerIdx),
    maxDist: Math.ceil(totalChars / 2) + 1,
  };

  // 색: baseColor 유지하다 survivor 변신 무렵 assembleColor 로(보라 등).
  // assembleColor 가 baseColor 와 같으면 timeline 생략(단색).
  const color: ColorSpec | undefined =
    assembleColor !== baseColor
      ? {
          timeline: [
            { fill: { type: "solid", value: baseColor }, hold: T.morph, transition: 6 },
            { fill: { type: "solid", value: assembleColor }, hold: 30 },
          ],
        }
      : undefined;

  // duration hint: intrinsic 보다 길면 그만큼 더 hold(짧으면 intrinsic 유지).
  const userFrames = knobs.duration ? Math.round(knobs.duration * FPS) : 0;
  const sceneFrames = Math.max(T.intrinsicEnd, userFrames);

  const choreoProps: LetterChoreoProps = {
    tracks,
    defaultExit,
    defaultEasing: "easeOut",
  };

  const element: TextElementSpec = {
    element: "text",
    base: {
      text: knobs.fromText,
      fontSize,
      fontWeight,
      color: baseColor,
      ...(brandFont ? { fontFamily: brandFont } : {}),
    },
    ...(color ? { color } : {}),
    layers: [
      {
        type: "letter_choreography",
        role: "in",
        props: choreoProps as unknown as Record<string, unknown>,
      },
    ],
  };

  return {
    duration: sceneFrames / FPS,
    transition_out: "hard_cut",
    elements: [element],
  };
}
