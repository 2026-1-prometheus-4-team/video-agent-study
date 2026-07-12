// presetTransform — preset element(neon_pill/glow_card/glow_menu)의 에디터
// 표준 transform 계약. 다른 Composed* 요소들과 동일: base.* 는 스톱워치 OFF
// 정적 편집, keyframes 는 씬-로컬 채널 키, timing 은 클립 트림 게이트.

import React from "react";
import { useCurrentFrame } from "remotion";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "../keyframes";

// base.* 는 스톱워치 OFF 정적 편집, keyframes 는 씬-로컬 채널 키.
// top-level position/width/height 는 초기 스펙(레거시) 폴백.
export type PresetBase = {
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  scale?: number;
  rotate?: number; // deg
  opacity?: number; // 0..1
  blur?: number; // px
  rotateX?: number; // deg — 3D 기울기
  rotateY?: number; // deg — 3D 팬
};

type PresetTransformSpec = {
  base?: PresetBase;
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
  position?: { x: number; y: number };
};

/** base + 키프레임 합성 — 위치/스케일/회전/불투명도/블러 + 클립 트림 게이트.
 *  키프레임은 씬-로컬(rawFrame) 계약, 이펙트 자체 클록은 winStart 시프트. */
export function usePresetTransform(spec: PresetTransformSpec, sceneFallback?: { x: number; y: number }) {
  const rawFrame = useCurrentFrame();
  const b = spec.base ?? {};
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? Infinity;
  const fallback = sceneFallback ?? { x: 0.5, y: 0.5 };
  return {
    frame: rawFrame - winStart, // 이펙트 로컬 클록 (drawIn/타이핑/궤도)
    visible: rawFrame >= winStart && rawFrame < winEnd,
    pos: {
      x: kf.x ?? b.position?.x ?? spec.position?.x ?? fallback.x,
      y: kf.y ?? b.position?.y ?? spec.position?.y ?? fallback.y,
    },
    scale: (b.scale ?? 1) * kf.scale,
    rotate: (b.rotate ?? 0) + kf.rotate,
    opacity: (b.opacity ?? 1) * kf.opacity,
    blur: (b.blur ?? 0) + kf.blur,
    progress: kf.progress, // null = 키 없음 (edge_light 가 base.progress 폴백)
    rotateX: kf.rotateX ?? b.rotateX ?? 0,
    rotateY: kf.rotateY ?? b.rotateY ?? 0,
  };
}

/** 회전/스케일/블러를 래퍼 스타일로 (중심 피벗). */
export function presetWrapStyle(t: { scale: number; rotate: number; blur: number; rotateX?: number; rotateY?: number }): React.CSSProperties {
  const parts: string[] = [];
  if (Math.abs(t.rotateX ?? 0) > 0.01 || Math.abs(t.rotateY ?? 0) > 0.01) {
    parts.push(`perspective(1100px) rotateX(${(t.rotateX ?? 0).toFixed(2)}deg) rotateY(${(t.rotateY ?? 0).toFixed(2)}deg)`);
  }
  if (Math.abs(t.rotate) > 0.01) parts.push(`rotate(${t.rotate.toFixed(2)}deg)`);
  if (Math.abs(t.scale - 1) > 0.0001) parts.push(`scale(${t.scale.toFixed(4)})`);
  return {
    transform: parts.length ? parts.join(" ") : undefined,
    transformOrigin: "50% 50%",
    filter: t.blur > 0.05 ? `blur(${t.blur.toFixed(1)}px)` : undefined,
  };
}

