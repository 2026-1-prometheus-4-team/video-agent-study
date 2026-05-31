/**
 * ClipEffect — 영상 클립에 Remotion 모션 효과 한 개를 입혀서 렌더링하는 wrapper.
 *
 * 우리 영상 편집 에이전트의 핵심 *효과 적용 유닛*. effect_expert 가
 * apply_remotion_effect(clip_path, pattern_id, params, ...) tool 을 호출하면
 * Python 측이 이 composition 을 npx remotion render 로 호출, mp4 산출.
 *
 * 흐름:
 *   1. 원본 클립을 OffthreadVideo 로 표시
 *   2. effectName 으로 EFFECT_MAP 에서 컴포넌트 dispatch
 *   3. effectMode 에 따라 overlay (영상 위에) / wrap (영상을 children 으로 감쌈) / replace (효과만)
 *   4. (선택) textOverlay 가 있으면 텍스트 layer 추가
 */

import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";

// === Effects ===
import { FadeIn } from "./effects/fade-in";
import { FadeOut } from "./effects/fade-out";
import { Hold } from "./effects/hold";
import { HardCut } from "./effects/hard-cut";
import { TypewriterText } from "./effects/typewriter-text";
import { BlurSlideIn } from "./effects/blur-slide-in";
import { BlurSlideOut } from "./effects/blur-slide-out";
import { NumberTicker } from "./effects/number-ticker";
import { TextReveal } from "./effects/text-reveal";
import { KineticWordSwap } from "./effects/kinetic-word-swap";
import { ConfettiExplosion } from "./effects/confetti-explosion";
import { DeviceMockup } from "./effects/device-mockup";
import { ColorSweep } from "./effects/color-sweep";
import { LiquidMorph } from "./effects/liquid-morph";
import { HandCursor } from "./effects/hand-cursor";
import { CheckmarkDraw } from "./effects/checkmark-draw";
import { ProgressBar } from "./effects/progress-bar";
import { BreathingDots } from "./effects/breathing-dots";
import { ZoomIntoScreen } from "./effects/zoom-into-screen";

// === Atom-level effects (overlay) ===
import { FilmGrain, Vignette, OuterGlow, BreathingWrapper } from "./atoms/layer-effects";

import type { BrandEnergy } from "./atoms/spring-config";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EFFECT_MAP: Record<string, React.ComponentType<any>> = {
  FadeIn,
  FadeOut,
  Hold,
  HardCut,
  TypewriterText,
  BlurSlideIn,
  BlurSlideOut,
  NumberTicker,
  TextReveal,
  KineticWordSwap,
  ConfettiExplosion,
  DeviceMockup,
  ColorSweep,
  LiquidMorph,
  HandCursor,
  CheckmarkDraw,
  ProgressBar,
  BreathingDots,
  ZoomIntoScreen,
  // atoms
  FilmGrain,
  Vignette,
  OuterGlow,
  Breathing: BreathingWrapper,
};

export type EffectMode = "overlay" | "wrap" | "replace";

export interface ClipEffectProps {
  /**
   * 원본 클립 경로. 보통 Python 측에서 절대 경로 또는 staticFile() 호환 상대 경로.
   * 빈 문자열이면 영상 없이 effect 만 (replace 모드와 동일).
   */
  clipPath: string;

  /**
   * EFFECT_MAP 키 중 하나. e.g. "FadeIn" / "ZoomIntoScreen".
   */
  effectName: string;

  /**
   * - "overlay" : 영상 위에 effect 를 absolute fill 로 깔음 (FilmGrain, Confetti 등)
   * - "wrap"    : effect 컴포넌트가 영상을 children 으로 감쌈 (transform 효과)
   * - "replace" : 영상 없이 effect 만 (TypewriterText, NumberTicker 같은 텍스트 인서트)
   */
  effectMode: EffectMode;

  /**
   * effect 컴포넌트의 props. (예: { startFrame: 0, durationFrames: 30, withScale: true })
   * 스키마는 각 effect 의 SKILL.md / registry.json 참고.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effectParams: Record<string, any>;

  /**
   * 텍스트 오버레이 (선택). TypewriterText / TextReveal 등 텍스트 효과에 children 으로 전달.
   * null 이면 default text (TextReveal 같은 효과의 빈 children 처리는 effect 가 결정).
   */
  textOverlay: string | null;

  /**
   * 모든 effect 의 timing / spring 강도 톤. motion-directing.md 의 spring config 룰.
   */
  brandEnergy: BrandEnergy;
}

export const ClipEffect: React.FC<ClipEffectProps> = ({
  clipPath,
  effectName,
  effectMode,
  effectParams,
  textOverlay,
  brandEnergy,
}) => {
  const Effect = EFFECT_MAP[effectName];

  if (!Effect) {
    // Fallback: 알 수 없는 effect 면 그냥 영상만 표시. (silent fail 보단 visual indicator 가 나음)
    return (
      <AbsoluteFill style={{ background: "#000" }}>
        {clipPath && <OffthreadVideo src={resolveSrc(clipPath)} />}
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ color: "#f00", fontSize: 48, fontFamily: "monospace" }}>
            Unknown effect: {effectName}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  const mergedParams = { energy: brandEnergy, ...effectParams };

  // mode = "replace": 영상 없이 효과만
  if (effectMode === "replace") {
    return (
      <AbsoluteFill style={{ background: "#000" }}>
        <Effect {...mergedParams}>{textOverlay ?? effectParams.text ?? ""}</Effect>
      </AbsoluteFill>
    );
  }

  // mode = "wrap": effect 가 영상을 children 으로 감쌈 (transform 효과)
  if (effectMode === "wrap") {
    return (
      <AbsoluteFill>
        <Effect {...mergedParams}>
          {clipPath ? (
            <OffthreadVideo src={resolveSrc(clipPath)} />
          ) : (
            <AbsoluteFill style={{ background: "#000" }} />
          )}
        </Effect>
      </AbsoluteFill>
    );
  }

  // mode = "overlay" (default): 영상 위에 effect 를 absolute fill
  return (
    <AbsoluteFill>
      {clipPath && <OffthreadVideo src={resolveSrc(clipPath)} />}
      <Effect {...mergedParams}>{textOverlay ?? effectParams.text ?? null}</Effect>
    </AbsoluteFill>
  );
};

/**
 * clipPath 가 절대 경로면 file:// 스킴으로 직접, 상대 경로면 staticFile() 처리.
 * Remotion 4 의 OffthreadVideo 가 file:// 도 받아준다.
 */
function resolveSrc(clipPath: string): string {
  if (clipPath.startsWith("http://") || clipPath.startsWith("https://")) return clipPath;
  if (clipPath.startsWith("file://")) return clipPath;
  if (clipPath.startsWith("/")) return `file://${clipPath}`;
  // 상대 경로 -> staticFile (Python 측에서 public/ 폴더에 심볼릭 링크 만들거나 절대 경로 쓰기 권장)
  return staticFile(clipPath);
}
