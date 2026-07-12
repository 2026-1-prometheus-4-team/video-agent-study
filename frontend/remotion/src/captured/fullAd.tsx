// FullAd — 캡쳐 씬 + 브랜드 아웃트로를 한 영상으로. 사이트마다 완성된 포스팅용 광고.
//   [captured: 입력 UI 타이핑/클릭]  ->  [outro: tagline statement -> 브랜드명 hero_zoom]
// outro 는 기존 프리셋 엔진(expandPresetScene)을 그대로 재사용해 brand 색/이름/태그라인으로 테마.
// brand 는 디렉터(Gemini)가 화면에서 읽어 plan.json 에 담는다.
import React, { useMemo } from "react";
import { Series } from "remotion";
import { Ad, totalFrames, type SceneSpec, type VideoSpec } from "../motion/SceneRenderer";
import { expandPresetScene, type Brand } from "../presets";
import { CapturedScene } from "../CapturedScene";
import { capturedFrames, type CapturedAdSpec } from "./spec";

const FPS = 24;
const FALLBACK_COLORS = ["#5B8CFF", "#FF5CA8", "#FF9A5C"];

export type BrandInfo = {
  name: string;
  tagline: string;
  colors: string[];
  background: string;
};

function normBrand(b: BrandInfo): Brand & { colors: string[] } {
  const colors = (b.colors && b.colors.length >= 2 ? b.colors : FALLBACK_COLORS).slice(0, 3);
  return { background: b.background || "#0B0A0E", colors, fontFamily: "Familjen Grotesk" };
}

// 아웃트로 = 태그라인(statement) -> 브랜드명(hero_zoom). 프리셋으로 확장.
export function buildOutroSpec(brand: BrandInfo): VideoSpec {
  const b = normBrand(brand);
  const words = (brand.tagline || "").trim().split(/\s+/).filter(Boolean);
  const highlightWord = words.length > 0 ? words.length - 1 : -1; // 마지막 단어 강조(0-based)
  const raw: Array<{ preset: string } & Record<string, unknown>> = [];
  if (brand.tagline) {
    raw.push({
      preset: "statement", text: brand.tagline,
      highlightWord, highlightCycle: b.colors, exitSpeed: "fast",
      baseColor: "#FFFFFF", duration: 3.2, fontSize: 3.0, fontWeight: 600,
    });
  }
  raw.push({
    preset: "hero_zoom", text: brand.name || "",
    gradientStops: b.colors, flowSpeed: 2,
    baseColor: "#FFFFFF", duration: 2.6, fontSize: 9, fontWeight: 800,
  });
  const scenes: SceneSpec[] = raw.map(({ preset, ...knobs }) =>
    expandPresetScene(preset as Parameters<typeof expandPresetScene>[0], knobs, { brand: b }),
  );
  return { fps: FPS, brandDefaults: b, scenes };
}

export function fullAdFrames(captured: CapturedAdSpec, brand: BrandInfo): number {
  return capturedFrames(captured) + totalFrames(buildOutroSpec(brand), FPS);
}

export const FullAd: React.FC<{ captured: CapturedAdSpec; brand: BrandInfo }> = ({ captured, brand }) => {
  const outro = useMemo(() => buildOutroSpec(brand), [brand]);
  const capF = capturedFrames(captured);
  const outroF = totalFrames(outro, FPS);
  return (
    <Series>
      <Series.Sequence durationInFrames={capF}>
        <CapturedScene mode="code" spec={captured} />
      </Series.Sequence>
      <Series.Sequence durationInFrames={outroF}>
        <Ad spec={outro} />
      </Series.Sequence>
    </Series>
  );
};
