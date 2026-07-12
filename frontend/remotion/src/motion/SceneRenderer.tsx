// SceneRenderer.tsx
// Type D orchestration: scene sequencing, scene transitions, background,
// and camera (push_in / follow_caret).

import React from "react";
import { rot3d } from "./transform3d";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Audio,
  staticFile,
  prefetch,
  getRemotionEnvironment,
} from "remotion";
import { ComposedText, type TextElementSpec } from "./ComposedText";
import { ComposedLogo, type LogoElementSpec } from "./ComposedLogo";
import { ComposedShape, type ShapeElementSpec } from "./ComposedShape";
import { ComposedGooey, type GooeyElementSpec } from "./ComposedGooey";
import { ComposedImage, type ImageElementSpec } from "./ComposedImage";
import { ComposedVideo, type VideoElementSpec } from "./ComposedVideo";
import { ComposedShader, type ShaderElementSpec } from "./ComposedShader";
import { CurveSurface, CurveDrum, elementCurvePos, type Curve3DSpec, CurveCloneCtx } from "./curve3d";
import { FillLayer, type FillSpec } from "./fill";
import { samplePathLayout, sampleOrbitLayout, sampleMotionPath, type GroupLayoutSpec, type MotionPathSpec } from "./pathLayout";
import { LightCtx, shadeBrightness, sampleLightKeyframes, lightOnAt, type SceneLightSpec, type MaterialSpec } from "./lighting";
import { ChromeOverlay, chromeInsets, chromeRadius, type FrameChromeSpec } from "./chrome";
import { ParticleField, type ParticleWarpSpec } from "./effects/particleWarp";
import {
  NeonPill,
  Streak,
  BadgeLogo,
  GuideFrame,
  type NeonPillSpec,
  type StreakSpec,
  type BadgeLogoSpec,
  type GuideFrameSpec,
} from "./effects/designverse";
import { GlowCard, GlowMenu, type GlowCardSpec, type GlowMenuSpec } from "./effects/uiPresets";
import { EdgeLight, type EdgeLightSpec } from "./effects/edgeLight";
import { ExtrudedBox } from "./extrudeBox";
import { ComposedDevice, deviceScreenPx, type DeviceElementSpec } from "./ComposedDevice";
export type { DeviceElementSpec };
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";
import { composeChannels, channelsToCss } from "./wrappers";
import { clamp, ease, lerp, resolveEasing, type EasingName } from "./core/easing";
import {
  requiredFrames,
  resolveTimings,
  type MotionLayer,
  type SceneFit,
} from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { splitText } from "./structural/splitText";
import {
  typewriterVisible,
  type TypewriterProps,
} from "./structural/typewriter";
import {
  collapseFillStyles,
  slidePushStyles,
  zoomPunchStyles,
  wipeCollapseStyles,
  lightSweepStyles,
  type TextCollapseFillSpec,
  type SlidePushSpec,
  type ZoomPunchSpec,
  type WipeCollapseSpec,
  type LightSweepSpec,
  type SceneExitStyles,
} from "./effects/transitions";

// 키프레임 카메라의 한 시점. frame 은 씬 로컬 프레임. 지정 안 한 채널은 이전
// 키프레임 값(또는 기본: scale 1, x/y/rotate 0)을 유지한다. easing 은 "직전
// 키프레임 -> 이 키프레임" 세그먼트에 쓰는 곡선(named 또는 cubic()).
export type CameraKeyframe = {
  frame: number;
  scale?: number; // 배율 (1 = 원본)
  x?: number; // viewport-width fraction pan (0.1 = 화면폭 10% 우측)
  y?: number; // viewport-height fraction pan
  rotate?: number; // 2D roll (rotateZ) deg
  rotateX?: number; // 3D tilt (위/아래로 눕힘) deg — AE 카메라 X 회전
  rotateY?: number; // 3D pan (좌/우로 돌림) deg — AE 카메라 Y 회전
  /** 달리(dolly) — viewport-width fraction. +z = 카메라가 씬으로 다가감(시차 발생).
   *  scale(줌, 시차 없음)과 구분되는 "진짜 3D" 채널. space:"3d" 씬에서만 의미. */
  z?: number;
  easing?: string;
};

export type CameraSpec =
  | {
      type: "push_in" | "follow_caret";
      fromScale?: number;
      toScale?: number;
      easing?: EasingName;
      /** fromScale/toScale 대신 쓰는 키프레임 스케일 곡선 (trevor, designverse).
       *  t = 씬 진행도(0..1). 모노톤 큐빅 보간 — 다단 모션이 덜컹임 없이 이어짐. */
      scaleKeyframes?: { t: number; s: number }[];
      /** 속도 연동 모션블러(push_in 전용) — 프레임간 |dScale| 비례 blur(px). */
      motionBlur?: { amount?: number; maxBlur?: number };
      /** scale 과 함께 카메라 평행이동. v = 화면 폭/높이 대비 비율. */
      panX?: { t: number; v: number }[];
      panY?: { t: number; v: number }[];
    }
  // 키프레임 카메라 — AE/Figma 모션식. 에디터가 타임라인에서 키프레임을 찍는다.
  | {
      type: "keyframes";
      keyframes: CameraKeyframe[];
    };

// Full-screen colour overlay that ramps in within the scene. Useful when
// you want a hard cut to read as a coloured wash rather than a jump —
// drop a flash on the outgoing scene and the next scene's first frame
// emerges from the colour.
export type FlashSpec = {
  type: "flash";
  color: string;
  // Scene-fraction (0..1). Default 0.55: flash starts a little past
  // mid-scene and finishes at scene end. Linear ramp.
  startAt?: number;
  fullAt?: number;
};

export type SceneSpec = {
  id?: string;
  duration: number; // seconds; ignored when fit === "auto"
  fit?: SceneFit; // default "fixed"
  /** 씬 조명 (AE Light 레이어 등가, 평행광) — material.lit 요소만 반응. */
  light?: SceneLightSpec;
  /** 씬 공간 모드. "3d" 면 씬 전체가 하나의 원근(P) 아래 preserve-3d 체인 —
   *  요소 z 채널이 실제 깊이가 되고 깊이 가림이 브라우저 정렬로 성립.
   *  기본(미지정) = 기존 2D 파이프라인 완전 불변. (설계: true-3d step 1) */
  space?: "2d" | "3d";
  /** 3D 씬 원근 강도 P(px) — AE 카메라 zoom 등가 (작을수록 광각/왜곡 큼).
   *  기본 width x 1.3889 (50mm). 구 궤도 룩을 원하면 ~1100. */
  perspective?: number;
  transition_out?:
    | "hard_cut"
    | "fade"
    | TextCollapseFillSpec
    | SlidePushSpec
    | ZoomPunchSpec
    | WipeCollapseSpec
    | LightSweepSpec;
  background?: {
    color?: string;
    blobs?: string[];
    gradient?: string; // CSS background(예: radial-gradient). color 위/대신.
    fill?: FillSpec; // 이미지/영상 배경 (Figma 식 fill). color/gradient 대신/위.
    fadeInFrame?: number; // 이 프레임부터 배경 fade in(없으면 처음부터 보임)
    fadeDuration?: number; // fade in 길이(프레임), 기본 8
  };
  camera?: CameraSpec;
  elements: SceneElementSpec[];
  flash?: FlashSpec;
  /** 3D 커브드 캔버스 — 씬의 모든 최상위 요소가 곡면 위에 놓인다. */
  curve3d?: Curve3DSpec;
};

// Discriminated by `element`: "text" → ComposedText, "logo" → ComposedLogo.
// Adding a new element kind is two edits: list it here, dispatch in
// SceneBody.
// 프레임 그룹([2] 레이어): 여러 요소를 하나로 묶는 컨테이너. 그룹 layers
// (scale/move/fade/blur 등)가 자식 전부에 함께 걸린다(피그마 프레임 / AE
// 프리컴프처럼 묶어서 이동·축소). 자식은 그룹 로컬 좌표(base.position).
export type GroupElementSpec = {
  element: "group";
  id?: string;
  layers?: MotionLayer[];
  children: SceneElementSpec[];
  /** 3D 커브드 캔버스 — 자식 전부가 곡면 위에 놓인다. */
  curve3d?: Curve3DSpec;
  /** 그룹 배치 — B2 path(경로 위 분포/이동) | B1 orbit(3D 수평 궤도). */
  layout?: GroupLayoutSpec;
  /** 그룹 키프레임 — progress(경로 진행) + 공통 transform 채널 전부. */
  keyframes?: ElementKeyframe[];
  /** 그룹 정적 transform — 다른 요소의 base 와 동일 의미. position 기본 0.5
   *  (그룹은 inset:0 컨테이너라 position = 중심 이동량). */
  base?: {
    position?: { x: number; y: number };
    rotate?: number;
    rotateX?: number;
    rotateY?: number;
    z?: number;
    opacity?: number;
    /** 정적 스케일(배율, 기본 1) — 키프레임 scale 과 곱으로 합성. */
    scale?: number;
    /** 정적 블러(px, 기본 0) — 키프레임 blur 와 가산 합성. */
    blur?: number;
    /** 스케일/회전 피벗(comp fraction). 없으면 50%/50% (comp 중앙 — 하위호환).
     *  에디터가 그룹 scale/rotate 편집 시 자식 콘텐츠 중심으로 자동 유지 —
     *  콘텐츠가 comp 중앙 밖에 있어도 제자리에서 수축/회전한다. */
    anchor?: { x: number; y: number };
  };
};

// Figma 식 FRAME — 그룹과 달리 자체 박스(위치/크기/fill/라운드/클립)를 가진 진짜
// 컨테이너. 자식 position(0..1)은 frame-로컬(박스 기준)이라 frame 을 옮기면 자식이
// 함께 움직인다. clipsContent(기본 true)면 박스 밖 자식은 잘린다.
export type FrameElementSpec = {
  /** 디바이스 크롬 (A3 mockup) — browser 바 / phone 베젤. frame 표면 스타일. */
  chrome?: FrameChromeSpec;
  /** Auto layout (Figma 등가) — 자식을 흐름 배치. */
  flow?: FlowSpec;
  /** 부모-상대 크기: width/height 를 comp 가 아니라 부모 frame 콘텐츠 박스의
   *  % 로 해석 — 목업의 "스크린 프레임"이 디바이스와 함께 스케일된다. */
  sizeRel?: boolean;
  element: "frame";
  id?: string;
  base: {
    /** 중심 위치(캔버스 0..1). */
    position?: { x: number; y: number };
    /** 크기 (vw/vh %). shape 와 동일 규칙. */
    width?: number;
    height?: number;
    /** 배경 fill 스택(색/그라디언트/이미지/영상/노이즈). 없으면 투명. */
    fill?: FillSpec;
    /** 모서리 라운드(px). */
    radius?: number;
    /** 자식 클립 여부. 기본 true. */
    clipsContent?: boolean;
    /** 테두리 (Figma Stroke — inside ring). */
    stroke?: string;
    strokeWidth?: number; // px
    rotate?: number;
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    opacity?: number;
    /** 정적 스케일(배율, 기본 1) — 키프레임 scale 과 곱으로 합성. */
    scale?: number;
    /** 정적 블러(px, 기본 0) — 키프레임 blur 와 가산 합성. */
    blur?: number;
    /** 배경 유리 효과(px) — frame 뒤 콘텐츠를 흐림 (glass). */
    backdropBlur?: number;
  };
  layers?: MotionLayer[];
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
  children: SceneElementSpec[];
  /** 3D 커브드 캔버스 — frame 콘텐츠가 곡면 위에. */
  curve3d?: Curve3DSpec;
};

export type SceneElementSpec =
  | TextElementSpec
  | LogoElementSpec
  | ShapeElementSpec
  | GooeyElementSpec
  | ImageElementSpec
  | VideoElementSpec
  | ShaderElementSpec
  | DeviceElementSpec
  | GroupElementSpec
  | FrameElementSpec
  | ParticleWarpSpec
  | NeonPillSpec
  | StreakSpec
  | BadgeLogoSpec
  | GuideFrameSpec
  | GlowCardSpec
  | GlowMenuSpec
  | EdgeLightSpec;

// 한 요소 렌더 디스패치(text/logo/shape/group). function 선언이라 FrameGroup 과
// 상호 참조(재귀)해도 hoisting 으로 안전하다.
function SceneElement(props: {
  spec: SceneElementSpec;
  sceneFrames: number;
  brand?: { fontFamily?: string };
  fit?: SceneFit;
}): React.ReactElement {
  const { spec, sceneFrames, brand, fit } = props;
  const flowItem = React.useContext(FlowItemCtx);
  let node: React.ReactElement;
  if (spec.element === "particles") {
    node = <ParticleField spec={spec} />;
  } else if (spec.element === "neon_pill") {
    node = <NeonPill spec={spec} />;
  } else if (spec.element === "streak") {
    node = <Streak spec={spec} />;
  } else if (spec.element === "badge_logo") {
    node = <BadgeLogo spec={spec} />;
  } else if (spec.element === "guide_frame") {
    node = <GuideFrame spec={spec} />;
  } else if (spec.element === "glow_card") {
    node = <GlowCard spec={spec} />;
  } else if (spec.element === "glow_menu") {
    node = <GlowMenu spec={spec} />;
  } else if (spec.element === "edge_light") {
    node = <EdgeLight spec={spec} />;
  } else if (spec.element === "logo") {
    node = <ComposedLogo spec={spec} sceneFrames={sceneFrames} />;
  } else if (spec.element === "shape") {
    node = <ComposedShape spec={spec} sceneFrames={sceneFrames} fit={fit} />;
  } else if (spec.element === "gooey") {
    node = <ComposedGooey spec={spec} sceneFrames={sceneFrames} fit={fit} />;
  } else if (spec.element === "image") {
    node = <ComposedImage spec={spec} sceneFrames={sceneFrames} fit={fit} />;
  } else if (spec.element === "video") {
    node = <ComposedVideo spec={spec} sceneFrames={sceneFrames} fit={fit} />;
  } else if (spec.element === "shader") {
    node = <ComposedShader spec={spec} sceneFrames={sceneFrames} fit={fit} />;
  } else if (spec.element === "device") {
    // 스크린 앵커 자식 — 오버레이 좌표계 = 스크린 논리 px. FrameBoxCtx pxW/pxH
    // 로 sizeRel frame 이 화면에 정확히 맞고, x/y/w/h(comp fraction)는 디바이스
    // 박스 근사(모션패스 좌표 환산용).
    const devKids = spec.children;
    const screenChildren =
      devKids && devKids.length > 0
        ? (() => {
            const sp = deviceScreenPx(spec.device);
            const dPos = spec.base?.position ?? { x: 0.5, y: 0.5 };
            const dW = (spec.base?.width ?? 56) / 100;
            const dH = (spec.base?.height ?? 64) / 100;
            return (
              <FrameBoxCtx.Provider value={{ x: dPos.x - dW / 2, y: dPos.y - dH / 2, w: dW, h: dH, pxW: sp.w, pxH: sp.h }}>
                {devKids.map((child, i) => (
                  // data-el + display:contents — 에디터 계측 태그 (FrameBox 관례)
                  <div key={child.id ?? i} style={{ display: "contents" }} data-el={i}>
                    <SceneElement spec={child} sceneFrames={sceneFrames} brand={brand} fit={fit} />
                  </div>
                ))}
              </FrameBoxCtx.Provider>
            );
          })()
        : undefined;
    node = <ComposedDevice spec={spec} sceneFrames={sceneFrames} fit={fit} screenChildren={screenChildren} />;
  } else if (spec.element === "group") {
    // group 자체는 안 기울인다 — group.curve3d 는 FrameGroup 이 자식들에 적용(곡면).
    return (
      <MotionPathWrap spec={spec}>
        <FrameGroup spec={spec} sceneFrames={sceneFrames} brand={brand} fit={fit} />
      </MotionPathWrap>
    );
  } else if (spec.element === "frame") {
    return (
      <MotionPathWrap spec={spec}>
        <FrameBox spec={spec} sceneFrames={sceneFrames} brand={brand} fit={fit} />
      </MotionPathWrap>
    );
  } else {
    node = <ComposedText spec={spec} sceneFrames={sceneFrames} brand={brand} fit={fit} />;
  }
  // 요소 자신에 걸린 3D 커브 — 기본 "bend": 요소 콘텐츠를 스트립으로 잘라 실제로
  // 굽힌다(텍스트 글리프 포함). mode:"drum" 은 요소를 곧은 판으로 위치 기반 틸트.
  const curve = (spec as { curve3d?: Curve3DSpec }).curve3d;
  if (curve) {
    const pos = elementCurvePos(spec);
    node = (curve.mode ?? "bend") === "drum" ? (
      <CurveDrum curve={curve} items={[{ key: 0, pos, node }]} />
    ) : (
      <CurveSurface center={pos} curve={curve}>
        {node}
      </CurveSurface>
    );
  }
  // flow(Auto layout) 아이템: Z/motionPath/Light 래퍼가 전부 absolute-inset 이라
  // 흐름 배치를 깨뜨린다 — frame 이 위치의 주인 (Figma 와 동일).
  if (flowItem) return <>{node}</>;
  return (
    <ZWrap spec={spec}>
      <MotionPathWrap spec={spec}>
        <LightWrap spec={spec}>{node}</LightWrap>
      </MotionPathWrap>
    </ZWrap>
  );
}

// 요소 z 깊이 (3D 씬 전용) — 스펙 z(+안쪽, comp-width %) 를 css translateZ(-z px)
// 로. preserve-3d 로 체인을 유지해 브라우저 깊이 정렬에 참여시킨다.
function ZWrap(props: { spec: SceneElementSpec; children: React.ReactNode }): React.ReactElement {
  const { spec, children } = props;
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const P = React.useContext(Space3DCtx);
  const kf = sampleElementKeyframes((spec as { keyframes?: ElementKeyframe[] }).keyframes, frame);
  const z = kf.z ?? (spec as { base?: { z?: number } }).base?.z ?? 0;
  if (!P || z === 0) return <>{children}</>;
  const zPx = (z / 100) * width;
  // 눈 앞 클리핑 가드: css z 가 P 에 접근하면 CSS 가 그리지 않음 — 여유 92% 클램프
  const cssZ = Math.max(-P * 4, Math.min(P * 0.92, -zPx));
  return (
    <div data-nobounds="true" style={{ position: "absolute", inset: 0, transform: `translateZ(${cssZ.toFixed(2)}px)`, transformStyle: "preserve-3d" }}>
      {children}
    </div>
  );
}

// frame 콘텐츠 박스 (comp fraction) — frame 자식의 motionPath/layout 이 comp
// 공간 좌표(0..100)를 쓰므로, 래퍼가 frame-로컬 basePos 를 comp 로 환산할 때 사용.
// 중첩 frame 은 합성된 박스를 제공한다. (백로그 #16: 엔진/오버레이 좌표계 통일)
export const FrameBoxCtx = React.createContext<{ x: number; y: number; w: number; h: number; pxW?: number; pxH?: number } | null>(null);

/** 3D 씬 컨텍스트 — 값 = 원근 P(px). null = 2D 씬. AE 관례 P = width x 1.3889
 *  (50mm 등가, verify3d.mjs 로 관례 고정). */
export const Space3DCtx = React.createContext<number | null>(null);

/** Figma Auto layout 등가 — frame 의 배치 모드. 없으면 Free(절대좌표, 기존).
 *  켜면 위치의 주인이 frame 으로: 자식 x/y 대신 방향/간격/여백/정렬로 배치
 *  (CSS flexbox 1:1 — Figma 가 flexbox 를 모델로 설계함). 단위: comp px. */
export type FlowSpec = {
  direction: "vertical" | "horizontal";
  gap?: number;
  padding?: { x?: number; y?: number };
  /** 교차축 정렬 (Figma Alignment) */
  align?: "start" | "center" | "end";
  /** 주축 정렬 */
  justify?: "start" | "center" | "end" | "between";
  /** Figma Hug — 콘텐츠 크기에 맞춤 (chrome/curve3d 와 병용 불가) */
  hugW?: boolean;
  hugH?: boolean;
};

/** flow frame 의 자식 렌더 모드 — Composed* 가 절대좌표 대신 in-flow 로 그린다. */
export const FlowItemCtx = React.createContext<boolean>(false);

/** 곡면(3D canvas) 평면 예외 — AE 처럼 굽힘은 컨테이너 단위지만, 슬라이스
 *  복제가 무의미/유해한 요소는 곡면 밖 평면 레이어로 올린다:
 *  디바이스(WebGL 캔버스 x 슬라이스 = 컨텍스트 폭증 -> Context Lost 실측),
 *  비디오(디코더 중복), 압출 텍스트(three 캔버스). el.curveFlat 로 오버라이드. */
export function isCurveFlat(el: SceneElementSpec): boolean {
  const explicit = (el as { curveFlat?: boolean }).curveFlat;
  if (explicit != null) return explicit;
  if (el.element === "device" || el.element === "video") return true;
  if (el.element === "text" && (((el as { base?: { extrude?: number } }).base?.extrude) ?? 0) > 0) return true;
  return false;
}

// LiveLight — 씬 라이트를 프레임별로 샘플해 제공(키프레임 애니메이션) +
// 2D 씬의 point 라이트는 화면에 실제 "빛 풀"(radial)을 그린다. 2D 에선 관찰자
// = 정면 광원이라, 빛이 요소 평면 위에 떨어지는 모습을 오버레이로 표현
// (mix-blend screen — 어두운 배경 위에서만 밝아지고 색을 태우지 않는다).
function LiveLight({ scene, children }: { scene: SceneSpec; children: React.ReactNode }): React.ReactElement {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  // on/off 스텝 게이트 — 꺼진 구간은 라이트 자체가 없음 (셰이딩/풀 모두 off,
  // 요소는 unlit 원색 — intensity 0 의 "ambient 어둡게" 와 다르다)
  const lightActive = !!scene.light && lightOnAt(scene.light, frame);
  const light = lightActive && scene.light ? sampleLightKeyframes(scene.light, frame) : null;
  // 풀 오버레이 — point + 2D 씬만. 3D 는 per-element 셰이딩이 공간감을 담당.
  const pool = light && light.type === "point" && scene.space !== "3d" ? light : null;
  const pos = pool?.position ?? { x: 0.35, y: 0.3 };
  const radius = Math.max(0.05, pool?.falloff ?? 0.6) * width;
  const strength = Math.max(0, Math.min(1, (pool?.intensity ?? 0.8) * 0.55));
  return (
    <LightCtx.Provider value={light}>
      {children}
      {pool && strength > 0.01 && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            mixBlendMode: "screen",
            background: `radial-gradient(circle ${radius.toFixed(0)}px at ${(pos.x * 100).toFixed(2)}% ${(pos.y * 100).toFixed(2)}%, ${pool.color ?? "#FFFFFF"} 0%, transparent 70%)`,
            opacity: strength,
          }}
        />
      )}
    </LightCtx.Provider>
  );
}

// Camera3D — AE Two-Node 상당. 카메라 pose 의 역변환을 씬 래퍼에 건다.
// 공식은 scripts/verify3d.mjs 로 행렬 대조 검증된 리스트 (POI = 씬 중앙 z=0):
//   rotateZ(-roll) T(-panX,-panY, dolly) T(cx,cy,0) rotateX(-tilt) rotateY(-pan) T(-cx,-cy,0)
// scale(줌) 은 시차 없는 렌즈 줌 — 최외곽 2D 로 유지. z(달리)는 시차 발생.
function Camera3DWrapper(props: { scene: SceneSpec; children: React.ReactNode }): React.ReactElement {
  const { scene, children } = props;
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cam = scene.camera;
  let transform = "";
  if (cam && cam.type === "keyframes" && (cam.keyframes?.length ?? 0) > 0) {
    const c = sampleCameraKeyframes(cam.keyframes ?? [], frame);
    const cx = width / 2;
    const cy = height / 2;
    const panX = c.x * width;
    const panY = c.y * height;
    // +z = 다가감. 눈 앞 클리핑 가드: P 의 88% 이상 전진 금지.
    const P = Math.round(scene.perspective ?? width * 1.3889);
    const dolly = Math.min(P * 0.88, c.z * width);
    const parts: string[] = [];
    if (c.rotate !== 0) parts.push(`rotateZ(${(-c.rotate).toFixed(3)}deg)`);
    if (panX !== 0 || panY !== 0 || dolly !== 0)
      parts.push(`translate3d(${(-panX).toFixed(2)}px, ${(-panY).toFixed(2)}px, ${dolly.toFixed(2)}px)`);
    if (c.rotateX !== 0 || c.rotateY !== 0) {
      parts.push(`translate3d(${cx}px, ${cy}px, 0)`);
      if (c.rotateX !== 0) parts.push(`rotateX(${(-c.rotateX).toFixed(3)}deg)`);
      if (c.rotateY !== 0) parts.push(`rotateY(${(-c.rotateY).toFixed(3)}deg)`);
      parts.push(`translate3d(${-cx}px, ${-cy}px, 0)`);
    }
    if (c.scale !== 1) parts.push(`scale(${c.scale.toFixed(4)})`);
    transform = parts.join(" ");
  }
  return (
    <div style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: transform || undefined }}>
      {children}
    </div>
  );
}

function composeFrameBox(
  outer: { x: number; y: number; w: number; h: number } | null,
  inner: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  if (!outer) return inner;
  return {
    x: outer.x + inner.x * outer.w,
    y: outer.y + inner.y * outer.h,
    w: inner.w * outer.w,
    h: inner.h * outer.h,
  };
}

// 조명 — AE Material Options 등가. 씬 light + 요소 material.lit 일 때만,
// 요소의 3D 자세(rotateX/rotateY: base + 키프레임)와 빛 방향으로 밝기를 계산해
// filter: brightness 로 적용. 회전이 채널이므로 동전 스핀과 자동 연동된다.
function LightWrap(props: { spec: SceneElementSpec; children: React.ReactNode }): React.ReactElement {
  const { spec, children } = props;
  const frame = useCurrentFrame();
  const light = React.useContext(LightCtx);
  const mat = (spec as { material?: MaterialSpec }).material;
  // AE Accepts Lights 기본 ON: 라이트가 켜지면 모든 요소가 반응, lit:false 로 제외
  if (!light || mat?.lit === false) return <>{children}</>;
  // 압출 도형/텍스트는 면별 자체 셰이딩 (extrudeBox 램버트 / three 라이트) —
  // 전체 brightness 를 또 곱하면 이중 조명이라 제외.
  const selfLit =
    ((spec.element === "shape" || spec.element === "text") &&
      (((spec as { base?: { extrude?: number } }).base?.extrude ?? 0) > 0));
  if (selfLit) return <>{children}</>;
  const kf = sampleElementKeyframes((spec as { keyframes?: ElementKeyframe[] }).keyframes, frame);
  const base = (spec as { base?: { rotateX?: number; rotateY?: number; z?: number } }).base;
  const rx = kf.rotateX ?? base?.rotateX ?? 0;
  const ry = kf.rotateY ?? base?.rotateY ?? 0;
  const rawPos = elementCurvePos(spec);
  const pos = { x: kf.x ?? rawPos.x, y: kf.y ?? rawPos.y, z: kf.z ?? base?.z ?? 0 };
  const b = shadeBrightness(rx, ry, light, mat ?? {}, pos);
  return (
    <div data-nobounds="true" style={{ position: "absolute", inset: 0, filter: `brightness(${b.toFixed(3)})` }}>
      {children}
    </div>
  );
}

// motionPath — AE "paste path to position" 등가의 요소 공통 프리미티브.
// 어떤 요소든(text/shape/image/video/group/frame...) 경로를 붙이면, 요소
// keyframes 의 progress 채널이 경로 위 위치를 구동한다(키 간격=속도, 세그먼트
// 이징=가감속, orient=AE Auto-Orient Along Path). 래퍼는 "무대 좌표"만 옮기므로
// 요소 자신의 등장 효과/키프레임/curve3d 와 직교로 합성된다.
function MotionPathWrap(props: { spec: SceneElementSpec; children: React.ReactNode }): React.ReactElement {
  const { spec, children } = props;
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const mp = (spec as { motionPath?: MotionPathSpec }).motionPath;
  const kf = sampleElementKeyframes((spec as { keyframes?: ElementKeyframe[] }).keyframes, frame);
  const frameBox = React.useContext(FrameBoxCtx);
  if (!mp) return <>{children}</>;
  const pose = sampleMotionPath(mp, frame, fps, width, height, kf.progress);
  if (!pose) return <>{children}</>;
  // frame 자식의 basePos 는 frame-로컬 — 경로 좌표(comp 공간)와 맞추려 환산
  const rawPos = elementCurvePos(spec);
  const basePos = frameBox
    ? { x: frameBox.x + rawPos.x * frameBox.w, y: frameBox.y + rawPos.y * frameBox.h }
    : rawPos;
  const dx = (pose.x - basePos.x) * width;
  const dy = (pose.y - basePos.y) * height;
  return (
    <div
      data-nobounds="true"
      style={{
        position: "absolute",
        inset: 0,
        transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)${pose.rotate ? ` rotate(${pose.rotate.toFixed(3)}deg)` : ""}`,
        transformOrigin: `${(basePos.x * 100).toFixed(3)}% ${(basePos.y * 100).toFixed(3)}%`,
      }}
    >
      {children}
    </div>
  );
}

// 그룹 컨테이너는 씬 전체(inset:0) 정위치 컨텍스트라 자식은 base.position 으로
// 그룹 로컬 배치되고, 그룹 layers 로 계산한 transform 이 자식 전부에 함께 걸린다.
function FrameGroup(props: {
  spec: GroupElementSpec;
  sceneFrames: number;
  brand?: { fontFamily?: string };
  fit?: SceneFit;
}): React.ReactElement {
  const { spec, sceneFrames, brand, fit } = props;
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const timed = resolveTimings(
    spec.layers ?? [],
    sceneFrames,
    { fps, unitCount: 1 },
    intrinsicForLayer,
    fit,
  );
  // 3D 씬 — orbit 진짜 z / 그룹 transform 채널의 원근 처리 분기
  const space3dGroup = React.useContext(Space3DCtx);
  // 그룹 키프레임 — progress + 공통 transform 채널 전부 (사용자 요구: 그룹도 모든
  // 요소와 같은 계층 — Transform 패널의 회전/3D/스케일/깊이가 그룹에도 적용).
  const groupKf = sampleElementKeyframes(spec.keyframes, frame);
  const gch = composeChannels(timed, frame, { width, height, fps });
  const gb = spec.base ?? {};
  gch.scale *= groupKf.scale * (gb.scale ?? 1); // 정적 base.scale
  gch.rotate += groupKf.rotate + (gb.rotate ?? 0);
  gch.opacity *= groupKf.opacity * (gb.opacity ?? 1);
  gch.blur += groupKf.blur + (gb.blur ?? 0); // blur 채널(키프레임+정적)
  const gtx = ((groupKf.x ?? gb.position?.x ?? 0.5) - 0.5) * width;
  const gty = ((groupKf.y ?? gb.position?.y ?? 0.5) - 0.5) * height;
  const grx = groupKf.rotateX ?? gb.rotateX ?? 0;
  const gry = groupKf.rotateY ?? gb.rotateY ?? 0;
  const gz = groupKf.z ?? gb.z ?? 0;
  const css = channelsToCss(gch);
  const groupOwn = `${gtx || gty ? `translate(${gtx.toFixed(2)}px, ${gty.toFixed(2)}px) ` : ""}${gz ? `translateZ(${(-(gz / 100) * width).toFixed(2)}px) ` : ""}${grx || gry ? `${space3dGroup ? "" : "perspective(900px) "}${grx ? `rotateX(${grx.toFixed(3)}deg) ` : ""}${gry ? `rotateY(${gry.toFixed(3)}deg) ` : ""}` : ""}`;
  // group.curve3d — 드럼 기하: 자식(줄/요소)들이 곧은 채로 공통 축 원통 위에 배치
  // (Google 커브드 월의 정석 — 글자는 벡터 선명 유지, 입체는 공유 카메라에서).
  const groupCurve = (spec as { curve3d?: Curve3DSpec }).curve3d;
  const groupLayout = spec.layout?.type === "path" || spec.layout?.type === "orbit" ? spec.layout : undefined;
  // frame 안 group: 자식 basePos(frame-로컬)를 경로 좌표(comp)로 환산 (백로그 #16)
  const groupFrameBox = React.useContext(FrameBoxCtx);
  const childCount = spec.children?.length ?? 0;
  const childNodes = (spec.children ?? []).map((child, i) => {
    let node: React.ReactNode = (
      // data-el + display:contents — 렌더에 영향 없는 에디터 계측 태그.
      // motion-editor 오버레이가 DOM 에서 요소 경로를 복원할 때 쓴다
      // (조상 [data-el] 체인 + [data-scene] 으로 "scene:el.child" 경로 구성).
      <div key={child.id ?? i} style={{ display: "contents" }} data-el={i}>
        <SceneElement
          spec={child}
          sceneFrames={sceneFrames}
          brand={brand}
          fit={fit}
        />
      </div>
    );
    // B2 경로 배치 — 자식을 자기 base 위치에서 경로 포즈 지점으로 이동시키는
    // 래퍼. 회전(orient/swing)은 경로 지점을 축으로 건다. 자식의 자체 애니는
    // 래퍼 안에서 그대로 동작(경로가 "무대 위 좌표"만 넘겨주는 구조).
    if (groupLayout) {
      // layoutPin — 배치(궤도/경로)에서 제외하고 제자리 고정. zIndex 0 으로
      // 그룹의 깊이 정렬에 "참여" — 궤도 중앙 텍스트를 앞 카드(+z)는 가리고
      // 뒤 카드(-z)는 뒤로 지나간다 (원근 가림 정합).
      if ((child as { layoutPin?: boolean }).layoutPin) {
        return {
          key: child.id ?? i,
          pos: elementCurvePos(child),
          node: (
            <div key={child.id ?? i} style={space3dGroup ? { position: "absolute", inset: 0, transform: "translateZ(0.6px)", transformStyle: "preserve-3d" } : { position: "absolute", inset: 0, zIndex: 0 }}>
              {node}
            </div>
          ),
        };
      }
      const pose =
        groupLayout.type === "orbit"
          ? sampleOrbitLayout(groupLayout, frame, i, childCount, width, height, groupKf.progress, space3dGroup)
          : samplePathLayout(groupLayout, frame, fps, i, childCount, width, height, groupKf.progress);
      if (pose) {
        const rawPos = elementCurvePos(child);
        const basePos = groupFrameBox
          ? { x: groupFrameBox.x + rawPos.x * groupFrameBox.w, y: groupFrameBox.y + rawPos.y * groupFrameBox.h }
          : rawPos;
        const dx = (pose.x - basePos.x) * width;
        const dy = (pose.y - basePos.y) * height;
        const sc = pose.scale ?? 1;
        node = (
          <div
            key={child.id ?? i}
            data-nobounds="true"
            style={{
              position: "absolute",
              inset: 0,
              // 원점은 자식의 "원래" 위치(basePos) — 도착점(pose)을 원점으로 잡으면
              // 스케일/회전이 이동 벡터까지 변형해 위치가 수축한다(p' = C + dx(2-s),
              // 실측: orbit 카드 중앙 뭉침). basePos 원점 = 도착 후 자기 중심 변형.
              // 3D 씬 orbit: zPx 를 translateZ 로 — 원근 확대/깊이 가림은 브라우저.
              transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)${pose.zPx != null ? ` translateZ(${pose.zPx.toFixed(2)}px)` : ""}${pose.rotate ? ` rotate(${pose.rotate.toFixed(3)}deg)` : ""}${sc !== 1 ? ` scale(${sc.toFixed(4)})` : ""}`,
              transformOrigin: `${(basePos.x * 100).toFixed(3)}% ${(basePos.y * 100).toFixed(3)}%`,
              ...(pose.zPx != null ? { transformStyle: "preserve-3d" as const } : {}),
              ...(pose.zIndex != null ? { zIndex: pose.zIndex } : {}),
            }}
          >
            {node}
          </div>
        );
      }
    }
    return {
      key: child.id ?? i,
      pos: elementCurvePos(child),
      node,
    };
  });
  return (
    // isolation: 그룹 배치(orbit)의 깊이 정렬(zIndex ±)이 그룹 안에서만 유효하게 —
    // 격리 없으면 음수 zIndex 카드가 씬 배경 밑으로 페인트되어 사라진다(실측).
    <div style={{ position: "absolute", inset: 0, ...(groupLayout && !space3dGroup ? { isolation: "isolate" as const } : {}), ...(space3dGroup ? { transformStyle: "preserve-3d" as const } : {}), ...css, transformOrigin: css.transformOrigin ?? (gb.anchor ? `${(gb.anchor.x * 100).toFixed(3)}% ${(gb.anchor.y * 100).toFixed(3)}%` : "50% 50%"), transform: `${groupOwn}${css.transform ?? ""}` || undefined }}>
      {!groupCurve ? (
        childNodes.map((c) => c.node)
      ) : (
        (() => {
          // 평면 예외(디바이스/영상/압출텍스트/curveFlat) 는 곡면 밖 위층 —
          // AE 에서 굽힘 프리컴프 "밖" 레이어가 평평한 것과 동일한 계층.
          const kidsArr = spec.children ?? [];
          const curved = childNodes.filter((_, i) => !isCurveFlat(kidsArr[i]));
          const flat = childNodes.filter((_, i) => isCurveFlat(kidsArr[i]));
          const surface =
            (groupCurve.mode ?? "drum") === "bend" ? (
              <CurveSurface curve={groupCurve}>{curved.map((c) => c.node)}</CurveSurface>
            ) : (
              <CurveDrum curve={groupCurve} items={curved} />
            );
          return (
            <>
              {surface}
              {flat.map((c) => c.node)}
            </>
          );
        })()
      )}
    </div>
  );
}

// FRAME 렌더 — 자체 박스 + fill + 클립 + frame-로컬 자식. shape 의 타이밍/키프레임
// 규칙을 그대로 따르고, 자식은 박스 안(inset:0) 컨텍스트라 position(0..1)이 frame-로컬.
function FrameBox(props: {
  spec: FrameElementSpec;
  sceneFrames: number;
  brand?: { fontFamily?: string };
  fit?: SceneFit;
}): React.ReactElement | null {
  const { spec, sceneFrames, brand, fit } = props;
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  // 훅 전부 최상단 — "등장 전" 가드(return null)가 프레임에 따라 뒤집혀도
  // 훅 순서가 불변이어야 한다 (Rules of Hooks 위반 실측 수정).
  const outerBox = React.useContext(FrameBoxCtx);
  const asFlowItem = React.useContext(FlowItemCtx);
  const inCurveClone = React.useContext(CurveCloneCtx);
  // Space3D 도 여기(조기 return 앞)에서 — 게이트가 프레임에 따라 뒤집히면
  // 훅 개수가 달라져 Rules of Hooks 위반 (실측: pre/postmount 로 노출).
  const frameSpace3dCtx = React.useContext(Space3DCtx);
  const base = spec.base ?? {};
  const pos = base.position ?? { x: 0.5, y: 0.5 };

  // 클립 트림 게이트 + clock 시프트 (shape 와 동일).
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  const timed = resolveTimings(spec.layers ?? [], winLen, { fps, unitCount: 1 }, intrinsicForLayer, fit);
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 키프레임은 씬-로컬 계약 — 클립 시프트가 아니라 rawFrame 으로 샘플
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * (base.scale ?? 1); // 정적 base.scale
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + (base.blur ?? 0); // blur 채널(키프레임+정적)
  const css = channelsToCss(channels, inCurveClone);
  if ((spec.layers ?? []).length > 0 && timed.every((l) => frame < l.startFrame)) return null;

  // sizeRel: 부모 frame 콘텐츠 박스 "픽셀" 기준 % — 크롬 인셋/종횡비 고정이
  // 반영된 실제 화면 영역에 맞는다 (선언값 기반이면 aspect-lock 시 어긋남, 실측)
  const relBase =
    spec.sizeRel && outerBox
      ? { w: outerBox.pxW ?? outerBox.w * width, h: outerBox.pxH ?? outerBox.h * height }
      : { w: width, h: height };
  // 캔버스 초과 허용(오버스캔/줌 연출) — 에디터 쓰기 한도와 동일 400%
  const wPx = (clamp(kf.w ?? base.width ?? 40, 0.5, 400) / 100) * relBase.w;
  let hPx = (clamp(kf.h ?? base.height ?? 30, 0.5, 400) / 100) * relBase.h;
  // 디바이스 크롬(A3) — phone 은 형상이 radius 를 정의, 콘텐츠는 스크린 영역으로 인셋.
  const chrome = spec.chrome;
  // phone 은 실기기 규격 고정: 바디 405 x 864pt (iPhone 15 Pro, 스크린 852 +
  // 베젤 12) — 폭이 크기를 정하고 높이는 종횡비로 강제 (임의 비율 = 규격 붕괴).
  if (chrome?.kind === "phone") hPx = wPx * (864 / 405);
  const radius = chromeRadius(chrome, wPx, hPx, base.radius ?? 0);
  const ins = chromeInsets(chrome, wPx, hPx);
  // curve3d 가 켜진 frame 은 박스 클립을 끈다 — 굽힘이 픽셀을 정당하게 박스 밖으로
  // 옮기는데(가장자리 말림) 평면 박스로 자르면 곡면 끝이 뚝 끊겨 보인다(#119).
  const clips = base.clipsContent !== false && !spec.curve3d;

  // frame 콘텐츠 박스 (comp fraction, 중첩 시 합성) — 자식 motionPath 좌표 환산용
  // (훅은 위에서 이미 읽음 — 조기 return 앞)
  const myBox = {
    ...composeFrameBox(outerBox, {
      x: (kf.x ?? pos.x) - (kf.w ?? base.width ?? 40) / 200,
      y: (kf.y ?? pos.y) - (kf.h ?? base.height ?? 30) / 200,
      w: (kf.w ?? base.width ?? 40) / 100,
      h: (kf.h ?? base.height ?? 30) / 100,
    }),
    // 자식 sizeRel 용 실제 콘텐츠 박스 px (크롬 인셋/종횡비 고정 반영)
    pxW: wPx - ins.left - ins.right,
    pxH: hPx - ins.top - ins.bottom,
  };
  const flow = spec.flow;
  const renderKid = (child: SceneElementSpec, i: number) => (
    // data-el — 에디터 계측 태그(FrameGroup 과 동일 관례).
    // display:contents 라 flex 컨테이너에서도 자식이 아이템으로 참여한다.
    <div key={child.id ?? i} style={{ display: "contents" }} data-el={i}>
      <SceneElement spec={child} sceneFrames={sceneFrames} brand={brand} fit={fit} />
    </div>
  );
  // frame 곡면: 평면 예외 자식은 곡면 밖 위층 (그룹과 동일 규칙)
  const kidsAll = spec.children ?? [];
  const kids = (
    <FrameBoxCtx.Provider value={myBox}>
      <FlowItemCtx.Provider value={!!flow}>
        {(spec.curve3d ? kidsAll.filter((c) => !isCurveFlat(c)) : kidsAll).map((child) => renderKid(child, kidsAll.indexOf(child)))}
      </FlowItemCtx.Provider>
    </FrameBoxCtx.Provider>
  );
  const flatKids = spec.curve3d ? (
    <FrameBoxCtx.Provider value={myBox}>
      <FlowItemCtx.Provider value={!!flow}>
        {kidsAll.filter((c) => isCurveFlat(c)).map((child) => renderKid(child, kidsAll.indexOf(child)))}
      </FlowItemCtx.Provider>
    </FrameBoxCtx.Provider>
  ) : null;
  // 압출 (모든 요소 공통) — frame 도 실제 옆벽 지오메트리. 3D 씬이면 씬 공유
  // 원근에 합류, 2D 씬이면 로컬 perspective 속성 (shape 와 동일 규칙).
  const frameExtrude = inCurveClone ? 0 : ((base as { extrude?: number }).extrude ?? 0);
  const frameSpace3d = frameSpace3dCtx;
  // Auto layout: hug 는 콘텐츠가 frame 크기를 정한다 — 콘텐츠 div 가 in-flow 여야
  // 측정이 성립 (chrome/curve3d 조합은 v1 미지원, 절대 인셋 유지).
  const hugW = !!flow?.hugW && !chrome && !spec.curve3d;
  const hugH = !!flow?.hugH && !chrome && !spec.curve3d;
  const alignMap = { start: "flex-start", center: "center", end: "flex-end" } as const;
  const justifyMap = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" } as const;
  const flowStyle: React.CSSProperties | null = flow
    ? {
        display: "flex",
        flexDirection: flow.direction === "horizontal" ? "row" : "column",
        gap: flow.gap ?? 0,
        // Fixed 축: padding 이 가용 크기를 초과하면 CSS 가 왼쪽/위만 지켜 쏠림 —
        // min(,50%) 로 정렬 유지. Hug 축: % padding 은 순환(컨테이너가 콘텐츠
        // 크기)이라 0 으로 붕괴하므로(실측: hug+padding 무반응 회귀) 원 px 그대로 —
        // hug 는 어차피 frame 이 자라서 초과 쏠림이 없다.
        padding: `${hugH ? `${flow.padding?.y ?? 0}px` : `min(${flow.padding?.y ?? 0}px, 50%)`} ${hugW ? `${flow.padding?.x ?? 0}px` : `min(${flow.padding?.x ?? 0}px, 50%)`}`,
        alignItems: alignMap[flow.align ?? "center"],
        justifyContent: justifyMap[flow.justify ?? "center"],
        boxSizing: "border-box",
      }
    : null;

  return (
    <div
      // data-framebox — 에디터 측정 태그: frame 의 박스는 자식 union 이 아니라
      // 이 div 자체다 (자식이 밖으로 나가도 frame 박스는 안 늘어남).
      data-framebox
      style={{
        ...(asFlowItem
          ? { position: "relative" as const, flexShrink: 0 }
          : { position: "absolute" as const, left: `${(kf.x ?? pos.x) * 100}%`, top: `${(kf.y ?? pos.y) * 100}%` }),
        width: hugW ? "max-content" : wPx,
        height: hugH ? "max-content" : hPx,
        transform: `${asFlowItem ? "" : "translate(-50%, -50%)"}${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${frameExtrude > 0 ? "" : rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY, perspective: base.perspective })}${inCurveClone ? "" : " translate3d(0,0,0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        willChange: inCurveClone ? undefined : "transform, opacity",
        backfaceVisibility: "hidden",
        borderRadius: radius,
        // 압출 시 컨테이너 클립 불가 (벽이 z 로 나감) — 클립은 앞면 div 가 담당
        overflow: frameExtrude > 0 ? "visible" : clips ? "hidden" : "visible",
        perspective: frameExtrude > 0 && !frameSpace3d ? (base.perspective ?? 1100) : undefined,
        transformStyle: frameExtrude > 0 && frameSpace3d ? ("preserve-3d" as const) : undefined,
      }}
    >
      {frameExtrude > 0 && (
        // 압출 벽/뒷면 — 앞면 콘텐츠(아래 기존 마크업)와 같은 회전을 받도록
        // 회전은 이 래퍼와 아래 콘텐츠가 아니라 "컨테이너 이후 공통 래퍼" 가
        // 이상적이지만, frame 은 콘텐츠 구조가 많아 벽만 래퍼에 싣고 회전각을
        // ExtrudedBox 면 셰이딩에 그대로 전달한다.
        <div aria-hidden style={{ position: "absolute", inset: 0, transform: rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY }, true) || undefined, transformStyle: "preserve-3d" }}>
          <ExtrudedBox
            widthPx={wPx}
            heightPx={hPx}
            depth={frameExtrude}
            radiusPx={typeof radius === "number" ? radius : 0}
            kind="rectangle"
            fill={base.fill && (base.fill as { type?: string; color?: string }).type === "solid" ? ((base.fill as { color?: string }).color ?? "#161B26") : "#161B26"}
            rx={kf.rotateX ?? base.rotateX ?? 0}
            ry={kf.rotateY ?? base.rotateY ?? 0}
            elemPos={{ x: kf.x ?? pos.x, y: kf.y ?? pos.y, z: kf.z ?? (base as { z?: number }).z ?? 0 }}
          >
            <span />
          </ExtrudedBox>
        </div>
      )}
      {(base.fill != null || (base.backdropBlur ?? 0) > 0) && !spec.curve3d && (
        // radius: chrome 있으면 스크린 radius, 없으면 frame 의 corner radius —
        // clipsContent 가 꺼져 있으면 컨테이너가 안 자르므로 fill 이 직접 둥글어야 함.
        // backdropBlur = frame 뒤를 흐리는 유리(glass) — fill 없이도 동작.
        <div
          style={{
            position: "absolute",
            top: ins.top,
            right: ins.right,
            bottom: ins.bottom,
            left: ins.left,
            borderRadius: chrome ? ins.screenRadius : radius,
            overflow: "hidden",
            backdropFilter: (base.backdropBlur ?? 0) > 0 ? `blur(${base.backdropBlur}px)` : undefined,
            ...(frameExtrude > 0 ? { transform: `${rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY }, true)} translateZ(0.01px)`.trim() || undefined } : {}),
          }}
        >
          {base.fill != null && <FillLayer fill={base.fill} radius={chrome ? ins.screenRadius : radius} />}
        </div>
      )}
      <div
        data-framecontent
        style={
          flow && !spec.curve3d
            ? {
                // in-flow 콘텐츠 박스 — hug 시 이 박스가 frame 크기를 만든다
                position: "relative",
                width: hugW ? undefined : "100%",
                height: hugH ? undefined : "100%",
                ...flowStyle,
              }
            : { position: "absolute", top: ins.top, right: ins.right, bottom: ins.bottom, left: ins.left, borderRadius: chrome ? ins.screenRadius : undefined, overflow: chrome ? "hidden" : undefined, ...(frameExtrude > 0 ? { transform: `${rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY }, true)} translateZ(0.02px)`.trim() || undefined } : {}) }
        }
      >
        {spec.curve3d ? (
          <>
            {/* frame 곡면 = frame "자신"(fill 표면)부터 휜다 — 텍스트/도형에
                적용할 때와 동일 의미. flow 면 flex 컨텍스트를 곡면 안에 재구성
                (밖에 두면 슬라이스 자식이 좌상단으로 흘러 정렬 붕괴 — 실측). */}
            <CurveSurface curve={spec.curve3d} sizePx={{ w: wPx, h: hPx }}>
              {base.fill != null && (
                <div style={{ position: "absolute", inset: 0, borderRadius: chrome ? ins.screenRadius : radius, overflow: "hidden" }}>
                  <FillLayer fill={base.fill} radius={chrome ? ins.screenRadius : radius} />
                </div>
              )}
              {flow ? (
                // 곡면 안에서는 % 기반 padding clamp 가 슬라이스 측정 문맥에서
                // 무효가 된다 (실측: 무반응) — 원시 px 로 강제. hug 는 곡면과
                // 병용 불가라 초과 쏠림 케이스도 없다.
                <div style={{ position: "absolute", inset: 0, ...flowStyle, padding: `${flow.padding?.y ?? 0}px ${flow.padding?.x ?? 0}px` }}>{kids}</div>
              ) : kids}
            </CurveSurface>
            {flatKids}
          </>
        ) : (
          kids
        )}
      </div>
      {chrome && <ChromeOverlay chrome={chrome} wPx={wPx} hPx={hPx} />}
      {base.stroke && (
        <div style={{ position: "absolute", inset: 0, borderRadius: radius, boxShadow: `inset 0 0 0 ${base.strokeWidth ?? 2}px ${base.stroke}`, pointerEvents: "none", zIndex: 3 }} />
      )}
    </div>
  );
}

/** 오디오 클립 — NLE 식 오디오 레인의 한 조각. 음악(전체 관통)과 효과음
 *  (특정 프레임에 짧게) 모두 이 하나의 모양으로 표현한다. 시간의 진실은
 *  컴프 프레임: start 에서 시작해 duration 프레임 재생, 소스 파일은
 *  trimStart 초 지점부터 읽는다 (컷 편집 = start/duration/trimStart 조작). */
export type AudioClipSpec = {
  id?: string;
  /** 업로드 결과 "/assets/..." 또는 외부 URL */
  src: string;
  name?: string;
  /** 클립이 놓이는 컴프 프레임 (기본 0) */
  start?: number;
  /** 클립 길이(프레임). 없으면 소스/영상 끝까지 */
  duration?: number;
  /** 소스 앞부분 스킵(초) */
  trimStart?: number;
  volume?: number;
  /** 페이드 인/아웃(프레임) — 컷 경계 클릭 노이즈 방지 */
  fadeIn?: number;
  fadeOut?: number;
  /** 음악 클립의 BPM — 에디터 비트 그리드 간격(60/bpm 초)·비트 스냅 기준 */
  bpm?: number;
  /** 소스 전체 길이(초) — 에디터가 추가 시 기록(트림 한계 계산용). 렌더 무관 */
  sourceSec?: number;
};

/** 구형 단일 오디오 필드 — 클립 배열 도입 전 스펙과의 호환용 */
export type LegacyAudioSpec = { src: string; volume?: number; startFrame?: number; trimStartSec?: number; bpm?: number };

/** audio 필드를 항상 클립 배열로 정규화 (구형 단일 객체 → 1클립) */
export function audioClipList(audio: VideoSpec["audio"]): AudioClipSpec[] {
  if (!audio) return [];
  if (Array.isArray(audio)) return audio.filter((c) => c && c.src);
  const a = audio as LegacyAudioSpec;
  if (!a.src) return [];
  return [{ id: "audio-1", src: a.src, start: a.startFrame, trimStart: a.trimStartSec, volume: a.volume, bpm: a.bpm }];
}

export type VideoSpec = {
  /** 오디오 레인 — 문서(전체 영상) 레벨. 씬 경계와 무관하게 음악 하나가
   *  전 씬을 관통할 수 있고, 효과음 클립을 원하는 프레임에 얹는다.
   *  구형 단일 객체 형태도 audioClipList 가 받아준다. */
  audio?: AudioClipSpec[] | LegacyAudioSpec;
  fps?: number;
  brandDefaults?: {
    /** 전체 영상 뒤 문서 배경 — 색/그라디언트/이미지/영상 (Figma 식 fill). */
    background?: FillSpec;
    fontFamily?: string;
    /** 브랜드 팔레트 — 텍스트 색 시드/에디터 Libraries 탭 공용.
     *  (과거엔 이게 배경 오로라를 자동 트리거했으나 제거 — 오로라는 이제
     *  fill 페인트 타입(type:"aurora")으로 원하는 배경에 명시적으로 넣는다) */
    colors?: string[];
  };
  scenes: SceneSpec[];
  /** 에디터 전용 — 레퍼런스 비교 영상 오버레이 설정. 엔진 렌더는 사용하지 않음.
   *  (파일에 저장돼 에디터 새로고침/재오픈 시 오버레이가 복원된다) */
  reference?: {
    video: string;
    mode?: "overlay" | "side";
    opacity?: number;
    startFrame?: number;
    endFrame?: number | null;
    side?: "left" | "right";
    visible?: boolean;
  };
};

function unitCountForElement(el: TextElementSpec): number {
  const text = el.base?.text ?? "";
  if (!text) return 1;
  const layers = el.layers ?? [];
  const firstStructural = layers.find(
    (l) =>
      l.type === "typewriter" ||
      l.type === "letter_stagger" ||
      l.type === "path_in" ||
      l.type === "marquee_rows",
  );
  const unit =
    (firstStructural?.props?.unit as "char" | "word" | undefined) ?? "char";
  if (unit === "word") return text.split(/\s+/).filter(Boolean).length;
  return splitText(text).filter((l) => !l.isSpace).length;
}

export function sceneFrames(scene: SceneSpec, fps: number): number {
  if (scene.fit === "auto") {
    let max = fps; // at least 1 second so empty scenes are visible
    // 컨테이너(group/frame)는 자식을 재귀 — 안의 텍스트 리빌 타이밍이 씬 필요
    // 길이에 반영돼야 한다 (감사 #25: 통째 skip 으로 잘리던 것).
    const visit = (el: SceneElementSpec) => {
      if (el.element === "group" || el.element === "frame") {
        for (const child of (el as { children?: SceneElementSpec[] }).children ?? []) visit(child);
        return;
      }
      if (el.element === "logo" || el.element === "shader" || el.element === "particles" || el.element === "neon_pill" || el.element === "streak" || el.element === "badge_logo" || el.element === "guide_frame" || el.element === "glow_card" || el.element === "glow_menu" || el.element === "edge_light") return; // 고정 길이/자체 타이밍
      const layers: MotionLayer[] = el.layers ?? [];
      if (layers.length === 0) return;
      // shape/gooey/image/video/device 는 텍스트 유닛이 없으므로 unitCount 1
      const uCount =
        el.element === "shape" || el.element === "gooey" || el.element === "image" || el.element === "video" || el.element === "device"
          ? 1
          : unitCountForElement(el);
      const required = requiredFrames(
        layers,
        { fps, unitCount: uCount },
        intrinsicForLayer,
      );
      if (required > max) max = required;
    };
    for (const el of scene.elements ?? []) visit(el);
    return max;
  }
  // No 1s floor — transition-style scenes (e.g. zoom_cut) may legitimately
  // last only a handful of frames. The scene's own duration is the truth.
  return Math.max(1, Math.round(clamp(scene.duration ?? 2, 0.05, 30) * fps));
}

export function totalFrames(spec: VideoSpec, fps: number): number {
  return (spec.scenes ?? []).reduce((sum, s) => sum + sceneFrames(s, fps), 0);
}

// 씬 배경 드리프트 글로우 (trevor/designverse) — scene.background.blobs 색을
// radial 블롭 + sin 드리프트로. 카메라 밖이라 줌해도 배경 글로우는 제자리.
// frameOffset = 컴포지션 내 씬 시작 프레임 (씬 경계에서 위상 연속).
const BgBlobs: React.FC<{ colors: string[]; frameOffset?: number }> = ({ colors, frameOffset = 0 }) => {
  const frame = useCurrentFrame() + frameOffset;
  const { width, height } = useVideoConfig();
  const P = [
    { x: 0.72, y: 0.22, r: 0.62, o: 0.3, sp: 80 },
    { x: 0.22, y: 0.75, r: 0.55, o: 0.16, sp: 105 },
    { x: 0.55, y: 0.5, r: 0.5, o: 0.12, sp: 130 },
  ];
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {colors.slice(0, 3).map((c, i) => {
        const bp = P[i];
        const x = (bp.x + Math.sin(frame / bp.sp + i * 2.1) * 0.05) * width;
        const y = (bp.y + Math.cos(frame / (bp.sp * 1.2) + i * 1.7) * 0.04) * height;
        const pulse = 1 + 0.08 * Math.sin(frame / (bp.sp * 0.7) + i);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: width * bp.r * pulse,
              height: width * bp.r * pulse,
              transform: "translate(-50%, -50%)",
              background: `radial-gradient(circle, ${c} 0%, transparent 65%)`,
              opacity: bp.o,
              filter: "blur(30px)",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};


// Caret-x estimate for follow_caret. Uses the first text element with a
// typewriter layer; per-glyph width is approximated as fontSize * 0.55
// (Inter average). 12-frame moving average smooths the per-letter jumps.
function rawCaretPan(
  scene: SceneSpec,
  frame: number,
  frames: number,
  fps: number,
  width: number,
): number {
  for (const el of scene.elements ?? []) {
    if (
      el.element === "logo" ||
      el.element === "group" ||
      el.element === "shape" ||
      el.element === "gooey" ||
      el.element === "image" ||
      el.element === "video" ||
      el.element === "frame" ||
      el.element === "shader" ||
      el.element === "device" ||
      el.element === "particles" ||
      el.element === "neon_pill" ||
      el.element === "streak" ||
      el.element === "badge_logo" ||
      el.element === "guide_frame" ||
      el.element === "glow_card" ||
      el.element === "glow_menu" ||
      el.element === "edge_light"
    )
      continue; // 텍스트 캐럿이 없는 요소들
    const layers = el.layers ?? [];
    const tw = layers.find((l) => l.type === "typewriter");
    if (!tw) continue;
    const text = el.base?.text ?? "";
    if (!text) continue;
    const letters = splitText(text);
    const uCount = letters.filter((l) => !l.isSpace).length;
    const timed = resolveTimings(
      layers,
      frames,
      { fps, unitCount: uCount },
      intrinsicForLayer,
      scene.fit,
    );
    const twTimed = timed.find((l) => l.type === "typewriter");
    if (!twTimed) continue;
    const local = Math.max(0, frame - twTimed.startFrame);
    const state = typewriterVisible(letters, local, fps, tw.props as TypewriterProps);
    if (state.unitCount === 0) continue;
    const fontSize = ((el.base?.fontSize ?? 4) / 100) * width;
    const avgCharWidth = fontSize * 0.55;
    const totalWidth = state.unitCount * avgCharWidth;
    const currentX = state.shown * avgCharWidth;
    return -(currentX - totalWidth / 2);
  }
  return 0;
}

function followCaretPan(
  scene: SceneSpec,
  frame: number,
  frames: number,
  fps: number,
  width: number,
): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < 12; i++) {
    const f = frame - i;
    if (f < 0) break;
    sum += rawCaretPan(scene, f, frames, fps, width);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// 키프레임 카메라를 현재 프레임에서 보간해 {scale,x,y,rotate} 반환. 채널별로
// "값이 지정된 키프레임"만 골라 그 사이를 세그먼트 easing 으로 보간한다(채널마다
// 독립 — scale 만 찍은 키프레임과 x 만 찍은 키프레임이 섞여도 각자 옳게 이어짐).
export function sampleCameraKeyframes(
  keyframes: CameraKeyframe[],
  frame: number,
): { scale: number; x: number; y: number; rotate: number; rotateX: number; rotateY: number; z: number } {
  const defaults = { scale: 1, x: 0, y: 0, rotate: 0, rotateX: 0, rotateY: 0, z: 0 };
  if (!keyframes || keyframes.length === 0) return defaults;
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  // 카메라 키프레임 = "완전한 포즈". 어떤 키가 채널을 명시 안 하면 그 채널을 제외하는
  // 게 아니라 기본값(회전 0, 스케일 1 …)으로 취급해 모든 키가 모든 채널의 보간에
  // 참여한다. 안 그러면 "마지막 키에만 3D 회전을 넣었을 때, 회전 채널의 점이 하나뿐이라
  // 프레임 0부터 그 회전이 유지"되는 버그가 난다(요소 키프레임의 채널-독립 모델과는 다름).
  const channel = (key: "scale" | "x" | "y" | "rotate" | "rotateX" | "rotateY" | "z"): number => {
    const def = defaults[key];
    const v = (k: (typeof sorted)[number]): number => (typeof k[key] === "number" ? (k[key] as number) : def);
    if (frame <= sorted[0].frame) return v(sorted[0]);
    if (frame >= sorted[sorted.length - 1].frame) return v(sorted[sorted.length - 1]);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const span = Math.max(1, b.frame - a.frame);
        const t = resolveEasing(b.easing, "easeInOut")((frame - a.frame) / span);
        return lerp(v(a), v(b), t);
      }
    }
    return def;
  };
  return {
    scale: channel("scale"),
    x: channel("x"),
    y: channel("y"),
    rotate: channel("rotate"),
    rotateX: channel("rotateX"),
    rotateY: channel("rotateY"),
    z: channel("z"),
  };
}

// 키프레임 모노톤 큐빅 보간(Fritsch-Carlson, trevor/designverse). C1 연속이면서
// 키프레임 값을 오버슈트하지 않는다 — 눌림/유지/발사 다단 모션이 물 흐르듯.
function scaleAtKeyframes(pts: { t: number; s: number }[], t: number): number {
  const n = pts.length;
  if (t <= pts[0].t) return pts[0].s;
  if (t >= pts[n - 1].t) return pts[n - 1].s;
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((pts[k + 1].s - pts[k].s) / (pts[k + 1].t - pts[k].t || 1e-6));
  const m: number[] = [d[0]];
  for (let k = 1; k < n - 1; k++) m.push(d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2);
  m.push(d[n - 2]);
  // Fritsch-Carlson 제한
  for (let k = 0; k < n - 1; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      m[k] = 0;
      m[k + 1] = 0;
    } else {
      const a = m[k] / d[k];
      const b = m[k + 1] / d[k];
      const s2 = a * a + b * b;
      if (s2 > 9) {
        const tau = 3 / Math.sqrt(s2);
        m[k] = tau * a * d[k];
        m[k + 1] = tau * b * d[k];
      }
    }
  }
  let i = 0;
  while (i < n - 2 && t > pts[i + 1].t) i++;
  const h = pts[i + 1].t - pts[i].t || 1e-6;
  const x = (t - pts[i].t) / h;
  const h00 = 2 * x * x * x - 3 * x * x + 1;
  const h10 = x * x * x - 2 * x * x + x;
  const h01 = -2 * x * x * x + 3 * x * x;
  const h11 = x * x * x - x * x;
  return h00 * pts[i].s + h10 * h * m[i] + h01 * pts[i + 1].s + h11 * h * m[i + 1];
}

// push_in 의 해당 프레임 scale — cameraTransform 과 motionBlur 가 공유 (trevor).
function pushInScale(camera: Extract<CameraSpec, { type: "push_in" | "follow_caret" }>, frame: number, frames: number): number {
  const kf = camera.scaleKeyframes;
  if (kf && kf.length >= 2) {
    const t = frames <= 1 ? 1 : clamp(frame / (frames - 1), 0, 1);
    return clamp(scaleAtKeyframes(kf, t), 0.5, 5);
  }
  const from = clamp(camera.fromScale ?? 1, 0.5, 5);
  const to = clamp(camera.toScale ?? 1.5, 0.5, 5);
  const t = ease(frame, frames, camera.easing ?? "linear");
  return from + (to - from) * t;
}

function pushInPan(pts: { t: number; v: number }[] | undefined, frame: number, frames: number): number {
  if (!pts || pts.length < 2) return 0;
  const t = frames <= 1 ? 1 : clamp(frame / (frames - 1), 0, 1);
  return scaleAtKeyframes(pts.map((pp) => ({ t: pp.t, s: pp.v })), t);
}

// 카메라 속도 연동 blur(px) — push_in + motionBlur 지정 시에만 (trevor).
export function cameraMotionBlurPx(camera: CameraSpec | undefined, frame: number, frames: number, width: number): number {
  if (!camera || camera.type !== "push_in" || !camera.motionBlur) return 0;
  if (frame <= 0) return 0;
  const amount = clamp(camera.motionBlur.amount ?? 0.12, 0, 1);
  const maxBlur = clamp(camera.motionBlur.maxBlur ?? 28, 0, 120);
  const d = Math.abs(pushInScale(camera, frame, frames) - pushInScale(camera, frame - 1, frames));
  return Math.min(maxBlur, d * (width / 2) * amount);
}

function cameraTransform(
  camera: CameraSpec | undefined,
  scene: SceneSpec,
  frame: number,
  frames: number,
  fps: number,
  width: number,
  height: number,
): string {
  if (!camera) return "";
  if (camera.type === "push_in") {
    const s = pushInScale(camera, frame, frames);
    const px = pushInPan(camera.panX, frame, frames) * width;
    const py = pushInPan(camera.panY, frame, frames) * height;
    if (px !== 0 || py !== 0) {
      return `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${s.toFixed(4)})`;
    }
    return `scale(${s.toFixed(4)})`;
  }
  if (camera.type === "follow_caret") {
    const pan = followCaretPan(scene, frame, frames, fps, width);
    return `translateX(${pan.toFixed(1)}px)`;
  }
  if (camera.type === "keyframes") {
    // 3D 씬은 Camera3DWrapper 가 담당 (공유 원근 + POI 궤도) — 여기선 무시
    if (scene.space === "3d") return "";
    const c = sampleCameraKeyframes(camera.keyframes ?? [], frame);
    const parts: string[] = [];
    // 3D 회전이 있으면 perspective 를 맨 앞에 (rotateX/Y 가 입체로 읽히도록)
    if (c.rotateX !== 0 || c.rotateY !== 0) parts.push("perspective(1200px)");
    if (c.x !== 0 || c.y !== 0)
      parts.push(`translate(${(c.x * width).toFixed(1)}px, ${(c.y * height).toFixed(1)}px)`);
    if (c.rotateX !== 0) parts.push(`rotateX(${c.rotateX.toFixed(2)}deg)`);
    if (c.rotateY !== 0) parts.push(`rotateY(${c.rotateY.toFixed(2)}deg)`);
    if (c.rotate !== 0) parts.push(`rotate(${c.rotate.toFixed(2)}deg)`);
    if (c.scale !== 1) parts.push(`scale(${c.scale.toFixed(4)})`);
    return parts.join(" ");
  }
  return "";
}

// Dispatch the new transition_out specs to their style function. Returns
// styles applied to the outgoing scene over its last N frames (or null).
// text_collapse_fill is intentionally excluded here — it is handled by the
// existing `tcf` path with its own layered slots.
function resolveSceneExit(
  t: SceneSpec["transition_out"],
  frame: number,
  frames: number,
): SceneExitStyles | null {
  if (typeof t !== "object" || t === null) return null;
  switch (t.type) {
    case "slide_push":
      return slidePushStyles(t, frame, frames);
    case "zoom_punch":
      return zoomPunchStyles(t, frame, frames);
    case "wipe_collapse":
      return wipeCollapseStyles(t, frame, frames);
    case "light_sweep":
      return lightSweepStyles(t, frame, frames);
    default:
      return null;
  }
}

const SceneBody: React.FC<{
  scene: SceneSpec;
  frames: number;
  brand?: VideoSpec["brandDefaults"];
  /** 컴포지션 내 씬 시작 프레임 — BgBlobs 위상 연속용 (trevor) */
  from?: number;
  /** cross-scene 게스트 — 배경 위, 씬 콘텐츠 아래에 그린다.
   *  (LiveLight 단계에서 그리면 씬 배경 fill 이 게스트를 덮어 안 보임 — 실측:
   *   배경 있는 씬으로 연장된 셰이더 실종) */
  guests?: React.ReactNode;
}> = ({ scene, frames, brand, from, guests }) => {
  const space3dP = React.useContext(Space3DCtx);
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  // legacy fade transition
  const fadeOut =
    scene.transition_out === "fade"
      ? interpolate(frame, [Math.max(0, frames - 12), frames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;

  const cam = cameraTransform(scene.camera, scene, frame, frames, fps, width, height);
  const camBlur = cameraMotionBlurPx(scene.camera, frame, frames, width);

  // text_collapse_fill transition decomposes the scene into 3 layered
  // styles (textWrap, bar, fillOverlay).
  const tcf =
    typeof scene.transition_out === "object" &&
    scene.transition_out?.type === "text_collapse_fill"
      ? collapseFillStyles(scene.transition_out, frame, frames, width)
      : null;

  const exit = resolveSceneExit(scene.transition_out, frame, frames);

  const bgOpacity =
    scene.background?.fadeInFrame != null
      ? interpolate(
          frame,
          [
            scene.background.fadeInFrame,
            scene.background.fadeInFrame + (scene.background.fadeDuration ?? 8),
          ],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      : 1;

  return (
    <AbsoluteFill style={{ opacity: fadeOut, ...(space3dP ? { transformStyle: "preserve-3d" as const } : {}), ...exit?.sceneWrap }}>
      {/* 3D 씬에선 내부 배경 생략 — z=0 배경 "평면" 이 z<0 콘텐츠(orbit 뒤 카드)를
          깊이 정렬로 가린다 (실측). 배경은 뷰포트 밖 카메라 고정 플레이트가 담당. */}
      {!space3dP && (scene.background?.color || scene.background?.gradient) ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: scene.background.color,
            background: scene.background.gradient ?? undefined,
            opacity: bgOpacity,
          }}
        />
      ) : null}
      {/* 이미지/영상 배경 (Figma 식 fill) — 색/그라디언트 위에 얹힘 */}
      {!space3dP && scene.background?.fill ? (
        <div aria-hidden style={{ position: "absolute", inset: 0, opacity: bgOpacity }}>
          <FillLayer fill={scene.background.fill} />
        </div>
      ) : null}
      {scene.background?.blobs?.length ? (
        <BgBlobs colors={scene.background.blobs} frameOffset={from ?? 0} />
      ) : null}
      {guests}
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: cam || undefined,
          // push_in 속도 연동 모션블러 (trevor) — push_in 은 2D 씬 전용이라
          // 3D preserve-3d 체인과 충돌하지 않는다.
          filter: camBlur > 0.3 ? `blur(${camBlur.toFixed(1)}px)` : undefined,
          // 3D 씬: 카메라/전환 래퍼가 3D 체인을 평탄화하지 않게 (스펙 엄밀성 —
          // Chromium 이 관용적으로 통과시켜도 명시가 안전). 전환 중 opacity<1 은
          // 브라우저가 어차피 평탄화 — AE 도 2D 연산이 끼면 3D 그룹이 접힘(동일 규칙).
          ...(space3dP ? { transformStyle: "preserve-3d" as const } : {}),
          transformOrigin: "50% 50%",
        }}
      >
        {/* position:absolute + inset:0 is load-bearing here, not decorative:
            tcf.textWrap injects a `transform` during the collapse phase, and
            ANY element with transform!=none becomes a new containing block
            for its absolutely-positioned descendants (CSS transforms spec).
            Without an explicit full-screen box on THIS div, it defaults to a
            zero-height flow box pinned to the top of its parent (all real
            content inside is position:absolute so contributes no height) —
            so transformOrigin "50% 50%" anchors at screen TOP, not center,
            and the collapse squish renders as a thin distorted line stuck to
            the top edge instead of a centered smear. Keeping this div
            full-screen at all times (transform or not) makes 50/50 mean the
            actual screen center. */}
        <div style={{ position: "absolute", inset: 0, ...(space3dP ? { transformStyle: "preserve-3d" as const } : {}), ...tcf?.textWrap }}>
          {(() => {
            const items = (scene.elements ?? []).map((el, i) => ({
              key: el.id ?? i,
              pos: elementCurvePos(el),
              node: (
                // data-el + display:contents — 렌더 무영향 에디터 계측 태그
                // (motion-editor 셀렉션 오버레이의 DOM 측정용).
                <div key={el.id ?? i} style={{ display: "contents" }} data-el={i}>
                  <SceneElement
                    spec={el}
                    sceneFrames={frames}
                    brand={brand}
                    fit={scene.fit}
                  />
                </div>
              ),
            }));
            // scene.curve3d — 기본 "bend": 씬 화면 전체를 한 장으로 보고 슬라이스로
            // 굽힌다(글리프까지 휨). mode:"drum" 이면 요소들을 곧은 판으로 원통 배치.
            if (!scene.curve3d) return items.map((c) => c.node);
            return (scene.curve3d.mode ?? "bend") === "drum" ? (
              <CurveDrum curve={scene.curve3d} items={items} />
            ) : (
              <CurveSurface curve={scene.curve3d} sizePx={{ w: width, h: height }} contentZone={sceneContentZone(scene.elements ?? [])}>
                {items.map((c) => c.node)}
              </CurveSurface>
            );
          })()}
        </div>
      </div>
      {tcf?.bar ? <div style={tcf.bar} aria-hidden /> : null}
      {tcf?.fillOverlay ? <div style={tcf.fillOverlay} aria-hidden /> : null}
      {exit?.overlay ? (
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, pointerEvents: "none", ...exit.overlay }}
        />
      ) : null}
      {scene.flash ? (
        <FlashOverlay flash={scene.flash} frame={frame} frames={frames} />
      ) : null}
    </AbsoluteFill>
  );
};

/** 씬 요소들이 실제로 지나가는 영역(0..1, 애니메이션 포함) — 워프 인코딩 정밀도를
 *  콘텐츠에 집중시키기 위한 존. 위치·키프레임 x/y·frame 박스에 요소 크기 여유(0.25)
 *  패딩. 콘텐츠 없는 극단 영역이 8-bit 범위를 부풀려 계단을 만드는 것 방지. */
function sceneContentZone(elements: SceneElementSpec[]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = 0.5, x1 = 0.5, y0 = 0.5, y1 = 0.5;
  const addPt = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  const visit = (els: SceneElementSpec[], box?: { x: number; y: number; w: number; h: number }) => {
    for (const el of els) {
      const toAbs = (p: { x: number; y: number }) =>
        box ? { x: box.x + p.x * box.w, y: box.y + p.y * box.h } : p;
      const pos = toAbs(elementCurvePos(el as never));
      addPt(pos.x, pos.y);
      const kfs = (el as { keyframes?: { x?: number; y?: number }[] }).keyframes;
      if (Array.isArray(kfs)) {
        for (const k of kfs) {
          const p = toAbs({ x: typeof k.x === "number" ? k.x : 0.5, y: typeof k.y === "number" ? k.y : 0.5 });
          addPt(p.x, p.y);
        }
      }
      if (el.element === "frame") {
        const b = el.base ?? {};
        const bw = (b.width ?? 40) / 100;
        const bh = (b.height ?? 30) / 100;
        const bp = b.position ?? { x: 0.5, y: 0.5 };
        const abs = box ? { x: box.x + bp.x * box.w, y: box.y + bp.y * box.h } : bp;
        const fb = { x: abs.x - bw / 2, y: abs.y - bh / 2, w: bw, h: bh };
        addPt(fb.x, fb.y);
        addPt(fb.x + fb.w, fb.y + fb.h);
        visit(el.children ?? [], fb);
      } else if (el.element === "group") {
        visit(el.children ?? [], box);
      }
    }
  };
  visit(elements);
  const PAD = 0.25; // 요소 자체 크기 여유
  return {
    x0: Math.max(-0.3, x0 - PAD),
    x1: Math.min(1.3, x1 + PAD),
    y0: Math.max(-0.3, y0 - PAD),
    y1: Math.min(1.3, y1 + PAD),
  };
}

const FlashOverlay: React.FC<{
  flash: FlashSpec;
  frame: number;
  frames: number;
}> = ({ flash, frame, frames }) => {
  const startAt = clamp(flash.startAt ?? 0.55, 0, 1);
  const fullAt = clamp(flash.fullAt ?? 1, startAt + 0.001, 1);
  const start = startAt * frames;
  const end = fullAt * frames;
  const opacity = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        backgroundColor: flash.color,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};

export const Ad: React.FC<{ spec: VideoSpec }> = ({ spec }) => {
  const { fps, width } = useVideoConfig();
  const brand = spec.brandDefaults ?? {};
  const bg = brand.background; // 색/그라디언트/이미지/영상 (없으면 base 색만)

  // 씬 시작 프레임 누적 (cross-scene 게스트 계산용)
  const sceneList = spec.scenes ?? [];
  const frameCounts = sceneList.map((sc) => sceneFrames(sc, fps));
  const sceneStartAt: number[] = [];
  {
    let acc = 0;
    for (const f of frameCounts) {
      sceneStartAt.push(acc);
      acc += f;
    }
  }
  // cross-scene 연장: timing.end 가 자기 씬 길이를 넘는 요소는 다음 씬(들)에
  // "게스트"로 한 번 더 렌더한다. 게스트는 음수 from 의 Sequence 로 클록을
  // 홈 씬과 이어붙여(연속 프레임) 경계에서 픽셀 단위로 이어진다 — 셰이더가
  // 씬 넘어갈 때 다시 재생되지 않는 이유. z 는 씬 콘텐츠 뒤(배경 연속).
  const guestsFor = (i: number) => {
    const out: { el: SceneElementSpec; shift: number; homeTotal: number; key: string; homeFit?: SceneFit }[] = [];
    for (let j = 0; j < i; j++) {
      const totalJ = frameCounts[j];
      for (let k = 0; k < (sceneList[j].elements?.length ?? 0); k++) {
        const el = sceneList[j].elements[k];
        const end = (el as { timing?: { end?: number } }).timing?.end;
        if (typeof end !== "number" || end <= totalJ) continue;
        if (sceneStartAt[j] + end > sceneStartAt[i]) {
          out.push({ el, shift: sceneStartAt[i] - sceneStartAt[j], homeTotal: totalJ, key: `g-${j}-${k}`, homeFit: sceneList[j].fit });
        }
      }
    }
    return out;
  };

  let cursor = 0;
  const clips = audioClipList(spec.audio);
  const resolveAudioSrc = (s: string) =>
    /^(https?:)?\/\//.test(s) || s.startsWith("data:") ? s : staticFile(s.replace(/^\//, ""));
  // 프리뷰(Player) 한정: 오디오 소스를 미리 blob 캐시에 — 재생 중 클립 시작
  // 프레임에서 <Audio> 가 마운트될 때 네트워크 로드/시킹 지연으로 순간
  // 끊기던 문제 방지 (layout:none Sequence 는 premountFor 미지원이라 이 방식).
  // 렌더(오프라인)는 프레임 단위 결정적이라 불필요 — 환경 가드.
  const clipSrcKey = clips.map((c) => c.src).join("|");
  React.useEffect(() => {
    if (!getRemotionEnvironment().isPlayer) return;
    const handles = clips.map((c) => prefetch(resolveAudioSrc(c.src), { method: "blob-url" }));
    return () => handles.forEach((h) => h.free());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipSrcKey]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#0D0B10" }}>
      {clips.map((clip, ci) => {
        const src = resolveAudioSrc(clip.src);
        const vol = clip.volume ?? 1;
        const fadeIn = Math.max(0, clip.fadeIn ?? 0);
        // fadeOut 은 클립 끝 기준이라 duration 이 있어야 앵커된다
        const fadeOut = clip.duration != null ? Math.max(0, clip.fadeOut ?? 0) : 0;
        const dur = clip.duration;
        return (
          <Sequence key={clip.id ?? `audio-${ci}`} from={clip.start ?? 0} durationInFrames={dur} layout="none">
            <Audio
              src={src}
              volume={
                fadeIn > 0 || fadeOut > 0
                  ? (f) => {
                      let v = vol;
                      if (fadeIn > 0 && f < fadeIn) v *= f / fadeIn;
                      if (fadeOut > 0 && dur != null && f > dur - fadeOut) v *= Math.max(0, (dur - f) / fadeOut);
                      return Math.max(0, v);
                    }
                  : vol
              }
              trimBefore={Math.round((clip.trimStart ?? 0) * fps) || undefined}
            />
          </Sequence>
        );
      })}
      {bg != null && <FillLayer fill={bg} />}
      {(spec.scenes ?? []).map((scene, i) => {
        const frames = sceneFrames(scene, fps);
        const from = cursor;
        cursor += frames;
        const guests = guestsFor(i);
        const guestNodes = guests.map((g) => (
          <Sequence key={g.key} from={-g.shift} durationInFrames={g.shift + frames} layout="none">
            <SceneElement spec={g.el} sceneFrames={g.homeTotal} brand={brand} fit={g.homeFit} />
          </Sequence>
        ));
        return (
          // premountFor: 씬 트리를 1초 먼저 투명 마운트 — WebGL 셰이더/폰트/
          // 이미지가 경계 프레임에 "그 자리에서" 초기화되며 플레이어가 프레임을
          // 놓치던 깜빡임 제거 (실측: 재생 중 모든 씬 경계에서 blink).
          // postmountFor: 끝난 씬도 1초 유지 — 이전 씬으로 되감을 때 재마운트
          // 깜빡임 제거. 오프라인 렌더는 프레임 단위 결정적이라 둘 다 영향 없음.
          <Sequence key={scene.id ?? i} from={from} durationInFrames={frames} premountFor={fps} postmountFor={fps}>
            {/* data-scene — 에디터 계측 태그. 프리마운트된 "다음" 씬도 DOM 에
                있지만 항상 활성 씬 뒤에 오므로 오버레이의 first-match 는 활성 씬. */}
            <div style={{ display: "contents" }} data-scene={i}>
              <LiveLight scene={scene}>
                {/* cross-scene 게스트 — 이전 씬에서 넘어온 요소. 음수 from 으로
                    클록 연속(홈 씬 로컬 프레임 그대로), 자체 timing.end 게이트가
                    끝 지점에서 숨긴다. data-el 태그 없음(편집은 홈 씬에서). */}
                <Space3DCtx.Provider value={scene.space === "3d" ? Math.round(scene.perspective ?? width * 1.3889) : null}>
                  {scene.space === "3d" ? (
                    // 3D 씬: 뷰포트 perspective + 카메라 래퍼(preserve-3d, 현재 identity).
                    // 불변식: 카메라 무동작 + z=0 이면 2D 렌더와 픽셀 동일해야 한다.
                    <>
                      {/* 카메라 고정 배경판 — 씬 배경이 3D 월드와 함께 회전하면
                          컴프 경계가 드러난다(AE 의 comp bg 는 카메라 불변). 씬 fill 을
                          뷰포트 밖에 한 장 더 깔아 경계 밖을 같은 배경으로 채운다. */}
                      {(scene.background?.color || scene.background?.gradient) && (
                        <div aria-hidden style={{ position: "absolute", inset: 0, backgroundColor: scene.background?.color, background: scene.background?.gradient ?? undefined }} />
                      )}
                      {scene.background?.fill != null && (
                        <div style={{ position: "absolute", inset: 0 }}>
                          <FillLayer fill={scene.background.fill} radius={0} />
                        </div>
                      )}
                      <div style={{ position: "absolute", inset: 0, perspective: Math.round(scene.perspective ?? width * 1.3889), perspectiveOrigin: "50% 50%" }}>
                        <Camera3DWrapper scene={scene}>
                          <SceneBody scene={scene} frames={frames} brand={brand} from={from} guests={guestNodes} />
                        </Camera3DWrapper>
                      </div>
                    </>
                  ) : (
                    <SceneBody scene={scene} frames={frames} brand={brand} from={from} guests={guestNodes} />
                  )}
                </Space3DCtx.Provider>
              </LiveLight>
            </div>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
