// ComposedLogo.tsx
// Brand-mark element. Renders a registered logo (Scene24, future brands)
// at a vw-relative size with simple opacity / scale / slide animations.
// No structural / per-letter animation — logos are atomic visual units;
// only the wrapper transform + opacity move.
//
// Enter and exit are independent compose-multiplicative layers, mirroring
// hero_zoom's pattern of (scale-in to 1, hold, scale-out to small + slide
// off). scaleIn and scaleOut multiply, so a scaleIn that settles at 1.0
// followed by a scaleOut starting at 1.0 reads as one continuous arc.

import React from "react";
import { rot3d } from "./transform3d";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { clamp01, lerp, resolveEasing } from "./core/easing";
import { LOGO_REGISTRY, isLogoKind } from "./logos/scene24";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";

type EnterRamp = {
  duration: number;
  delay?: number;
  // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
  easing?: string;
};

type ExitRamp = {
  duration: number; // runs during last `duration` frames of the scene
  // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
  easing?: string;
};

export type LogoElementSpec = {
  element: "logo";
  id?: string;
  base: {
    /** Registered logo identifier (e.g. "scene24", "scene24-wordmark"). */
    kind: string;
    /** Rendered size in vw. For wordmark lockups this is the HEIGHT;
     *  width auto-scales to the source SVG's aspect. */
    size: number;
    /** Centre position in viewport fractions 0..1. Default 0.5/0.5. */
    position?: { x: number; y: number };
    /** 정적 회전(deg) — 에디터 회전 핸들. */
    rotate?: number;
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    bladeColor?: string;
    accentColor?: string;
  };
  // -------------------- entry ramps ------------------------------------
  /** Opacity 0 → 1 over `duration` starting at `delay` (default 0). */
  fadeIn?: EnterRamp;
  /** Scale `from → to` over `duration` starting at `delay`. Multiplies
   *  with scaleOut. */
  scaleIn?: EnterRamp & { from: number; to: number };
  // -------------------- exit ramps (anchored to scene end) -------------
  /** Opacity 1 → 0 during the LAST `duration` frames of the scene. */
  fadeOut?: ExitRamp;
  /** Scale `from → to` during the LAST `duration` frames. Multiplies
   *  with scaleIn (so scaleIn settled at 1, scaleOut starts at 1 → 0.2
   *  composes as a clean shrink). */
  scaleOut?: ExitRamp & { from: number; to: number };
  /** Translate fromX → toX in viewport-width units during the LAST
   *  `duration` frames. e.g. toX:-0.4 slides 40% of the viewport to the
   *  left before the cut. */
  slideOut?: ExitRamp & { fromX: number; toX: number };
  /** 속성 키프레임 애니메이션(위치·스케일·회전·투명도). */
  keyframes?: ElementKeyframe[];
  /** 클립 트림(씬-로컬 in/out 프레임). */
  timing?: ElementTiming;
};

function enterValue(
  frame: number,
  ramp: EnterRamp & { from: number; to: number },
): number {
  const start = ramp.delay ?? 0;
  if (frame <= start) return ramp.from;
  const t = clamp01((frame - start) / ramp.duration);
  // 에디터 커스텀 cubic() 지원 — 기본값(easeOut)은 기존과 동일
  const eased = resolveEasing(ramp.easing, "easeOut")(t);
  return lerp(ramp.from, ramp.to, eased);
}

function exitValue(
  frame: number,
  sceneFrames: number,
  ramp: ExitRamp & { from: number; to: number },
): number {
  const start = sceneFrames - ramp.duration;
  if (frame <= start) return ramp.from;
  const t = clamp01((frame - start) / ramp.duration);
  // 에디터 커스텀 cubic() 지원 — 기본값(easeIn)은 기존과 동일
  const eased = resolveEasing(ramp.easing, "easeIn")(t);
  return lerp(ramp.from, ramp.to, eased);
}

export const ComposedLogo: React.FC<{
  spec: LogoElementSpec;
  sceneFrames: number;
}> = ({ spec, sceneFrames }) => {
  const rawFrame = useCurrentFrame();
  const { width } = useVideoConfig();

  const base = spec.base;
  if (!isLogoKind(base.kind)) return null;
  const LogoComponent = LOGO_REGISTRY[base.kind];

  const sizePx = (base.size / 100) * width;
  const pos = base.position ?? { x: 0.5, y: 0.5 };

  // 클립 트림 게이트 + clock 시프트. sceneFrames 대신 winLen 을 램프 기준으로 쓴다.
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  // opacity = fadeIn × (1 - fadeOut)
  let opacity = 1;
  if (spec.fadeIn) {
    const start = spec.fadeIn.delay ?? 0;
    opacity = interpolate(
      frame,
      [start, start + spec.fadeIn.duration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  }
  if (spec.fadeOut) {
    const start = winLen - spec.fadeOut.duration;
    const fadeOutT = interpolate(frame, [start, winLen], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    // 에디터 커스텀 cubic() 지원 — 기본값(easeIn)은 기존과 동일
    opacity *= 1 - resolveEasing(spec.fadeOut.easing, "easeIn")(fadeOutT);
  }

  // scale = scaleIn × scaleOut
  let scale = 1;
  if (spec.scaleIn) scale *= enterValue(frame, spec.scaleIn);
  if (spec.scaleOut) scale *= exitValue(frame, winLen, spec.scaleOut);

  // 요소 키프레임 접기 (scale 곱 / opacity 곱 / rotate 는 아래 transform 에 추가)
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale
  opacity *= kf.opacity;
  // base.rotate(정적 핸들) + 키프레임 rotate. Logo 는 기존에 rotate 항이 없어 새로 추가.
  const rotateDeg = (base.rotate ?? 0) + kf.rotate;

  // translateX in pixels (viewport-width fraction × width)
  let txPx = 0;
  if (spec.slideOut) {
    txPx =
      exitValue(frame, winLen, {
        duration: spec.slideOut.duration,
        easing: spec.slideOut.easing,
        from: spec.slideOut.fromX,
        to: spec.slideOut.toX,
      }) * width;
  }

  // GPU promotion: translate3d + scale3d + will-change forces the browser
  // to rasterise the SVG ONCE at native resolution and then composite the
  // texture via the GPU. Without this, every frame's new scale value
  // re-rasterises the SVG and the 3px strokes shimmer / crackle along
  // their edges as sub-pixel anti-aliasing drifts. Same lesson as
  // letterScatter — moving textures should be GPU layers.
  return (
    <div
      style={{
        position: "absolute",
        left: `${(kf.x ?? pos.x) * 100}%`,
        top: `${(kf.y ?? pos.y) * 100}%`,
        // translate3d + scale3d (z=1, not 0/1 to keep depth identity but
        // still hint GPU). The -50% centring stays in the 2D translate;
        // the dynamic offset and scale go into translate3d/scale3d.
        transform: `translate(-50%, -50%)${rotateDeg ? ` rotate(${rotateDeg.toFixed(2)}deg)` : ""}${rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY, perspective: base.perspective })} translate3d(${txPx.toFixed(2)}px, 0, 0) scale3d(${scale.toFixed(4)}, ${scale.toFixed(4)}, 1)`,
        willChange: "transform, opacity",
        backfaceVisibility: "hidden",
        opacity,
      }}
    >
      <LogoComponent
        sizePx={sizePx}
        bladeColor={base.bladeColor}
        accentColor={base.accentColor}
      />
    </div>
  );
};
