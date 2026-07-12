// 합본 데모: 캡쳐된 Lovable 입력창(타이핑 + caret-follow 카메라 + 가속 줌인)
// -> 하드컷 -> 우리 텍스트 프리셋 아웃트로(word_swap / statement / zoom_cut / hero_zoom).
// 캡쳐 재구성 파이프라인 + 프리셋 엔진을 한 영상으로 잇는 vertical slice.
import React, { useMemo } from "react";
import { Series } from "remotion";
import { Ad, totalFrames, type VideoSpec } from "./motion/SceneRenderer";
import { expandPresetScene, isPresetName, type Brand } from "./presets";
import { CapturedScene, CAPTURED_FRAMES } from "./CapturedScene";
import outroRaw from "./specs/preset/lovable-outro.json";

const CAP_FRAMES = CAPTURED_FRAMES; // 캡쳐 씬 길이(안무 끝 = 검정 채움 완료)
const FPS = 24;

function buildOutro(): VideoSpec {
  const brand = outroRaw.brand as Brand;
  const scenes = outroRaw.scenes.map((raw) => {
    const { preset, ...knobs } = raw as { preset: string } & Record<string, unknown>;
    if (!isPresetName(preset)) throw new Error(`Unknown preset "${preset}"`);
    return expandPresetScene(preset, knobs, { brand });
  });
  return { fps: outroRaw.fps, brandDefaults: brand, scenes };
}

export const LOVABLE_AD_FRAMES = CAP_FRAMES + totalFrames(buildOutro(), FPS);

export const LovableAd: React.FC = () => {
  const outro = useMemo(buildOutro, []);
  const outroFrames = totalFrames(outro, FPS);
  return (
    <Series>
      <Series.Sequence durationInFrames={CAP_FRAMES}>
        <CapturedScene mode="code" />
      </Series.Sequence>
      <Series.Sequence durationInFrames={outroFrames}>
        <Ad spec={outro} />
      </Series.Sequence>
    </Series>
  );
};
