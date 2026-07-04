/**
 * Remotion Root — Composition 등록 파일.
 *
 * 현재는 ClipEffect 한 composition 만 등록. 이게 *영상 편집 에이전트의 핵심
 * 진입점* — Python 측 apply_remotion_effect tool 이 이 composition 을
 * 인자(clipPath / effectName / effectParams) 와 함께 render 한다.
 *
 * scene24 처럼 demo composition 들을 여기에 등록할 수 있지만, 일단 ClipEffect 만.
 */

import { Composition } from "remotion";
import { ClipEffect } from "./ClipEffect";

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const DEFAULT_DURATION_FRAMES = 90; // 3 초 default

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ClipEffect"
        component={ClipEffect}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={DEFAULT_WIDTH}
        height={DEFAULT_HEIGHT}
        defaultProps={{
          clipPath: "",
          effectName: "FadeIn",
          effectMode: "overlay" as const,
          effectParams: {},
          textOverlay: null,
          brandEnergy: "moderate" as const,
        }}
      />

      {/*
        쇼츠 비율 9:16. Python 측에서 inputProps 로 override 하는 편이 흔하지만
        편의를 위해 별도 composition 도 등록해둠.
      */}
      <Composition
        id="ClipEffectShorts"
        component={ClipEffect}
        durationInFrames={DEFAULT_DURATION_FRAMES}
        fps={DEFAULT_FPS}
        width={1080}
        height={1920}
        defaultProps={{
          clipPath: "",
          effectName: "FadeIn",
          effectMode: "overlay" as const,
          effectParams: {},
          textOverlay: null,
          brandEnergy: "moderate" as const,
        }}
      />
    </>
  );
};
