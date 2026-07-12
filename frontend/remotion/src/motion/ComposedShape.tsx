// ComposedShape.tsx
// UI 프리미티브 요소(라운드 사각형). 텍스트처럼 구조형(per-letter) 모션은 없고
// wrapper 레이어(fade/scale/move/blur/flip)만 전체에 걸린다 — ComposedText 의
// wrapper 채널 합성/타이밍을 그대로 재사용해 "요소 하나에 등장/퇴장 효과" 동일 동작.
//
// UI 모션(카드/버튼/패널)의 베이스. fill 은 solid 색 또는 CSS 그라디언트 문자열.

import { ExtrudeStack, backfaceFor } from "./extrude";
import { ExtrudedBox } from "./extrudeBox";
import { Space3DCtx } from "./SceneRenderer";
import React from "react";
import { FlowItemCtx } from "./SceneRenderer";
import { rot3d } from "./transform3d";
import { CurveCloneCtx } from "./curve3d";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { clamp } from "./core/easing";
import {
  resolveTimings,
  type MotionLayer,
  type SceneFit,
} from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { channelsToCss, composeChannels } from "./wrappers";
import { FillLayer, type FillSpec } from "./fill";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";

export type ShapeElementSpec = {
  element: "shape";
  id?: string;
  base: {
    /** 도형 종류. rectangle(기본, 라운드 사각형) / ellipse(타원·원) / line(선) */
    kind?: "rectangle" | "ellipse" | "line";
    /** 크기 (vw / vh 기준 percent). w=화면폭 %, h=화면높이 %. */
    width?: number;
    height?: number;
    /** 중심 위치 (0..1). 기본 0.5/0.5. */
    position?: { x: number; y: number };
    /** 정적 회전(deg) — 에디터 회전 핸들. */
    rotate?: number;
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    /** 채움 — 색·그라디언트·이미지·영상 (Figma 식 fill). 문자열이면 색/CSS 그라디언트. */
    fill?: FillSpec;
    /** 테두리 */
    stroke?: string;
    strokeWidth?: number; // px
    /** 모서리 라운드 (px). 아주 크게 주면 알약/원. */
    radius?: number;
    /** 요소 자체 불투명도(0..1). wrapper opacity 와 곱해짐. */
    opacity?: number;
    /** backdrop blur (px) — glass 느낌. */
    backdropBlur?: number;
  };
  layers?: MotionLayer[];
  /** 속성 키프레임 애니메이션(위치·스케일·회전·투명도). */
  keyframes?: ElementKeyframe[];
  /** 클립 트림(씬-로컬 in/out 프레임). */
  timing?: ElementTiming;
};

// 도형의 순수 비주얼 (line / rect / ellipse) — 압출 스택이 같은 걸 N장 적층.
function ShapeVisual({ base }: { base: NonNullable<ShapeElementSpec["base"]> }) {
  if (base.kind === "line") {
    return (
      <div
        style={{
          width: "100%",
          height: `${base.strokeWidth ?? 3}px`,
          marginTop: `calc(50% - ${(base.strokeWidth ?? 3) / 2}px)`,
          background:
            typeof base.stroke === "string" ? base.stroke : typeof base.fill === "string" ? base.fill : "#FFFFFF",
        }}
      />
    );
  }
  const radius = base.kind === "ellipse" ? "50%" : base.radius ?? 16;
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden" }}>
      <FillLayer fill={base.fill ?? "#7C4DFF"} radius={radius} />
      {base.stroke && (
        <div style={{ position: "absolute", inset: 0, borderRadius: radius, boxShadow: `inset 0 0 0 ${base.strokeWidth ?? 2}px ${base.stroke}` }} />
      )}
    </div>
  );
}

export const ComposedShape: React.FC<{
  spec: ShapeElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
}> = ({ spec, sceneFrames, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const inCurveClone = React.useContext(CurveCloneCtx);
  const flowItem = React.useContext(FlowItemCtx);
  const space3d = React.useContext(Space3DCtx);

  const base = spec.base ?? {};
  const pos = base.position ?? { x: 0.5, y: 0.5 };

  // 클립 트림 게이트 + clock 시프트 (ComposedText 와 동일).
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  const layers: MotionLayer[] = Array.isArray(spec.layers) ? spec.layers : [];
  const timed = resolveTimings(
    layers,
    winLen,
    { fps, unitCount: 1 },
    intrinsicForLayer,
    fit,
  );
  // shape 은 전부 wrapper 레이어 (구조형 없음)
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 요소 키프레임 접기 (scale 곱 / rotate 더함 / opacity 곱 / w·h 는 크기 덮어씀)
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  const css = channelsToCss(channels, inCurveClone);
  const wPx = (clamp(kf.w ?? base.width ?? 20, 0.5, 400) / 100) * width;
  const hPx = (clamp(kf.h ?? base.height ?? 12, 0.5, 400) / 100) * height;

  // 등장 전(모든 wrapper 가 미래)엔 안 그린다 — ComposedText 와 동일 가드.
  if (layers.length > 0 && timed.every((l) => frame < l.startFrame)) return null;

  const rx = kf.rotateX ?? base.rotateX ?? 0;
  const ry = kf.rotateY ?? base.rotateY ?? 0;
  // 곡면 클론 안에선 압출 무효 — 벽이 슬라이스마다 복제되어 깨짐/예산 폭발
  const extrude = inCurveClone ? 0 : ((base as { extrude?: number }).extrude ?? 0);
  return (
    <div
      style={{
        ...(flowItem
          ? { position: "relative" as const, flexShrink: 0 }
          : { position: "absolute" as const, left: `${(kf.x ?? pos.x) * 100}%`, top: `${(kf.y ?? pos.y) * 100}%` }),
        width: wPx,
        height: hPx,
        // 압출 시 회전은 내부 래퍼로 — perspective() "함수" 는 preserve-3d 자식의
        // z 를 투영하지 못해(실측: 72도에서 스택 붕괴) 컨테이너엔 perspective
        // "속성" 을 주고 회전을 그 자식에 건다 (CSS 3D 큐브 정석 구조).
        transform: `${flowItem ? "" : "translate(-50%, -50%)"}${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${extrude > 0 ? "" : rot3d({ rotateX: rx, rotateY: ry, perspective: base.perspective })}${inCurveClone ? "" : " translate3d(0,0,0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        maskImage: css.maskImage,
        WebkitMaskImage: css.maskImage,
        willChange: inCurveClone ? undefined : "transform, opacity",
        // 뒷면: 90도 넘게 돌 때만 보이게 (평상시 hidden = 글리프 떨림 방지 콤보)
        backfaceVisibility: backfaceFor(rx, ry),
        // 3D 씬: 로컬 원근 대신 씬 공유 원근에 합류 — 카메라를 돌리면 두께가
        // 실제 깊이로 드러난다. 2D 씬: 요소 자체 perspective 속성 (기존).
        perspective: extrude > 0 && !space3d ? (base.perspective ?? 1100) : undefined,
        transformStyle: extrude > 0 && space3d ? ("preserve-3d" as const) : undefined,
      }}
    >
      {extrude > 0 ? (
        <div style={{ position: "absolute", inset: 0, transform: rot3d({ rotateX: rx, rotateY: ry }, true) || undefined, transformStyle: "preserve-3d" }}>
          {base.kind === "rectangle" || base.kind === "ellipse" || !base.kind ? (
            // 진짜 옆벽 지오메트리 (AE C4D 압출 방식) — 에지온에서도 빈틈 없음
            <ExtrudedBox
              widthPx={wPx}
              heightPx={hPx}
              depth={extrude}
              radiusPx={base.kind === "ellipse" ? 0 : (base.radius ?? 16)}
              kind={base.kind === "ellipse" ? "ellipse" : "rectangle"}
              fill={typeof base.fill === "string" ? base.fill : "#7C4DFF"}
              rx={rx}
              ry={ry}
              elemPos={{ x: kf.x ?? pos.x, y: kf.y ?? pos.y, z: kf.z ?? (base as { z?: number }).z ?? 0 }}
            >
              <ShapeVisual base={base} />
            </ExtrudedBox>
          ) : (
            // line 등 임의 형태는 판 적층 유지
            <ExtrudeStack depth={extrude} fill>
              <ShapeVisual base={base} />
            </ExtrudeStack>
          )}
        </div>
      ) : base.kind === "line" ? (
        // line 은 얇은 막대(높이=strokeWidth), 세로 중앙.
        <div
          style={{
            width: "100%",
            height: `${base.strokeWidth ?? 3}px`,
            marginTop: `calc(50% - ${(base.strokeWidth ?? 3) / 2}px)`,
            background:
              typeof base.stroke === "string"
                ? base.stroke
                : typeof base.fill === "string"
                  ? base.fill
                  : "#FFFFFF",
          }}
        />
      ) : (
        // rectangle / ellipse: FillLayer(색·그라디언트·이미지·영상) + stroke 링.
        (() => {
          const radius = base.kind === "ellipse" ? "50%" : base.radius ?? 16;
          return (
            <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden", backdropFilter: base.backdropBlur ? `blur(${base.backdropBlur}px)` : undefined }}>
              <FillLayer fill={base.fill ?? "#7C4DFF"} radius={radius} />
              {base.stroke && (
                <div style={{ position: "absolute", inset: 0, borderRadius: radius, boxShadow: `inset 0 0 0 ${base.strokeWidth ?? 2}px ${base.stroke}` }} />
              )}
            </div>
          );
        })()
      )}
    </div>
  );
};
