// ComposedGooey.tsx
// 구이(gooey / metaball) 요소 — 두 블롭이 SVG goo 필터(feGaussianBlur +
// feColorMatrix 알파 임계) 아래 하나로 뭉쳐 있다가, 이동 블롭이 ease(frame) 로
// 떨어져 나가며 끈적한 목(neck)이 늘어나다 임계값을 지나 툭 끊긴다.
// 결정론적: 정수 프레임의 순수 함수 (rAF/random 없음).
//
// 렌더 모델(선택): SVG 한 장 안에서 goo 필터를 건 <g> 가 색칠된 <circle> 2개를
// 직접 감싼다(feGaussianBlur 로 번지게 → feColorMatrix 알파 임계로 뭉치게). 이게
// 교과서적 metaball 기법이라 Remotion 의 Chromium 헤드리스에서 조용히 깨질 여지가
// 없다. 대안이던 "CSS mask:url(#frag) 로 HTML FillLayer 오려내기"는 이미지/영상
// fill 까지 재사용할 수 있지만, HTML 요소에 인라인 SVG <mask> 를 거는 경로가
// (Blink 에선 되지만) 취약해 시각 검증 없이 채택하기엔 위험 → v1 은 solid 색
// SVG-native 로 확정. fill 은 색 문자열(#hex/rgb/named)만 반영, 그 외(그라디언트/
// 이미지/영상)는 fallback 색으로 떨어진다(스펙 타입 FillSpec 은 그대로 보존).

import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { clamp, clamp01, lerp, resolveEasing } from "./core/easing";
import {
  resolveTimings,
  type MotionLayer,
  type SceneFit,
} from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { channelsToCss, composeChannels } from "./wrappers";
import { CurveCloneCtx } from "./curve3d";
import { type FillSpec } from "./fill";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";

// SVG solid paint 로 쓸 색 추출. FillSpec 은 색/그라디언트 문자열 또는
// 이미지/영상 객체 — SVG <circle fill> 은 solid 색만 유효하므로 그라디언트/
// 객체는 fallback 으로 떨군다(스펙 타입은 보존, v1 렌더만 solid).
const GOOEY_FALLBACK_FILL = "#7C4DFF";
function solidFill(fill: FillSpec | undefined): string {
  if (typeof fill !== "string") return GOOEY_FALLBACK_FILL;
  // 그라디언트 등 함수형 CSS 값은 SVG fill 로 무효 → fallback.
  if (fill.includes("(") && !/^rgb|^hsl/i.test(fill.trim()))
    return GOOEY_FALLBACK_FILL;
  return fill;
}

export type GooeyStickiness = "loose" | "medium" | "sticky" | "glue";

// 끈적임 프리셋 -> feColorMatrix 알파 행 (0 0 0 <mul> <off>).
// alpha_out = clamp(mul*alpha_in + off). mul 클수록 경계가 날카롭고(액체금속),
// 임계값(= -off/mul)이 낮을수록 얇은 겹침도 solid 로 읽혀 목(neck)이 오래 붙어있다.
export const GOOEY_STICKINESS: Record<
  GooeyStickiness,
  { alphaMul: number; alphaOff: number }
> = {
  loose:  { alphaMul: 20, alphaOff: -9.0 }, // 임계 ~0.45, 날카롭고 일찍 끊김
  medium: { alphaMul: 18, alphaOff: -7.0 }, // 클래식 goo (임계 ~0.39)
  sticky: { alphaMul: 14, alphaOff: -5.0 }, // 임계 ~0.36, 목이 길고 부드러움
  glue:   { alphaMul: 11, alphaOff: -3.5 }, // 임계 ~0.32, 시럽처럼 아주 길게
};

export type GooeyElementSpec = {
  element: "gooey";
  id?: string;
  base: {
    /** 소스 블롭(고정) 중심 — Figma식 fraction(0..1). shape 의 base.position 대응. */
    fromShape: { x: number; y: number };
    /** 블롭 반지름 (min(w,h) 대비 %, = vmin). 기본 6. 화면 비율과 무관하게 원. */
    radius?: number;
    /** 떨어져 나가는 블롭의 이동량 — viewport fraction. dx=폭%, dy=높이% (카메라 키프레임 관례와 동일). */
    travel?: { dx: number; dy: number };
    /** 채움 — 두 블롭 공통. 색 / CSS 그라디언트 / 이미지 / 영상 (Figma fill). */
    fill?: FillSpec;
    /** 끈적임 프리셋 -> 임계 매트릭스. 기본 "medium". */
    stickiness?: GooeyStickiness;
    /** goo 블러 반경(px, min-dim 1080 기준으로 스케일). 클수록 목이 굵고 오래 붙어있다. 기본 12. */
    blur?: number;
    /** 이동 블롭이 떨어지며 부푸는 배율(도착 시점). 기본 1(변화 없음). 1.15=커지고 0.85=작아짐. */
    swell?: number;
    /** 필드 전체 정적 회전(deg) — 에디터 회전 핸들. */
    rotate?: number;
    /** 요소 자체 불투명도(0..1). wrapper opacity 와 곱해짐. */
    opacity?: number;
  };
  /** wrapper 레이어(fade/scale/blur 등) + detach 타이밍 레이어(type:"gooey_travel").
   *  gooey_travel 은 채널을 내지 않는 타이밍 전용 레이어 → resolveTimings 가
   *  startFrame/window 만 잡아 detach 구간으로 쓴다. props: { duration, easing?, delay? }. */
  layers?: MotionLayer[];
  /** 속성 키프레임(scale/rotate/opacity). x/y 는 gooey 에선 무시(위치는 fromShape). */
  keyframes?: ElementKeyframe[];
  /** 클립 트림(씬-로컬 in/out 프레임). */
  timing?: ElementTiming;
};

const TRAVEL_TYPE = "gooey_travel";

export const ComposedGooey: React.FC<{
  spec: GooeyElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
}> = ({ spec, sceneFrames, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  // 필터 id 를 인스턴스마다 유니크하게 (letterRoll/ComposedText 와 동일 관례).
  const reactId = React.useId();
  const uid = reactId.replace(/[^a-zA-Z0-9_-]/g, "");
  const gooId = `goo-${uid}`;

  const base = spec.base ?? ({} as GooeyElementSpec["base"]);
  const from = base.fromShape ?? { x: 0.5, y: 0.5 };
  const travel = base.travel ?? { dx: 0, dy: -0.22 };
  const md = Math.min(width, height);

  // 클립 트림 게이트 + clock 시프트.
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

  // wrapper 채널 (gooey_travel 은 WRAPPERS 에 없어 composeChannels 가 무시 → 채널 무영향).
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  const inCurveClone = React.useContext(CurveCloneCtx);
  const css = channelsToCss(channels, inCurveClone);

  // detach 진행도 t = ease((frame - travelStart)/travelWindow). travel 레이어가
  // 없으면 씬 전체를 구간으로 폴백 (그래도 애니메이션은 돌게).
  const travelLayer = timed.find((l) => l.type === TRAVEL_TYPE);
  const tStart = travelLayer?.startFrame ?? 0;
  const tWin = Math.max(1, travelLayer?.window ?? sceneFrames);
  const tEasing =
    (travelLayer?.props?.easing as string | undefined) ?? "easeInBack";
  const t = resolveEasing(tEasing, "easeInBack")(clamp01((frame - tStart) / tWin));

  // 등장 가드 — travel 레이어를 제외한 레이어가 모두 미래면 안 그린다. 소스 블롭은
  // detach 전에도 쉬고 있어야 하므로 travel 레이어로는 게이팅하지 않는다.
  const gate = timed.filter((l) => l.type !== TRAVEL_TYPE);
  if (gate.length > 0 && gate.every((l) => frame < l.startFrame)) return null;

  // 블롭 지오메트리 (px). dx 는 폭, dy 는 높이 기준 fraction.
  const rPx = (clamp(base.radius ?? 6, 0.5, 40) / 100) * md;
  const sx = from.x * width;
  const sy = from.y * height;
  const tx = sx + travel.dx * width * t;
  const ty = sy + travel.dy * height * t;
  const swell = clamp(base.swell ?? 1, 0.2, 3);
  const trPx = rPx * lerp(1, swell, t);

  const blurPx = clamp(base.blur ?? 12, 0, 40) * (md / 1080);
  const stick = GOOEY_STICKINESS[base.stickiness ?? "medium"];
  // RGB 행은 항등, 알파 행만 임계. alpha_out = clamp(mul*alpha_in + off).
  const matrix =
    `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${stick.alphaMul} ${stick.alphaOff}`;
  const paint = solidFill(base.fill);

  return (
    <div
      // data-nobounds: 에디터 선택 박스 측정(leafRect)에서 이 풀스크린 컨테이너를
      // 제외 → 블롭(circle)만 재서 선택 박스가 타이트해진다. 안 그러면 화면 전체가
      // gooey 박스로 잡혀 다른 요소 클릭을 가로챈다.
      data-nobounds="true"
      style={{
        position: "absolute",
        inset: 0,
        // 필드 전체 정적 회전 + wrapper transform. translate3d(0,0,0) 로 GPU 레이어 고정.
        transform: `${base.rotate ? `rotate(${base.rotate}deg) ` : ""}${inCurveClone ? "" : "translate3d(0,0,0) "}${css.transform}`,
        // 회전 원점 = 블롭 중심(fromShape) — 컨테이너는 풀스크린이라 50% 원점이면
        // 화면 중심 공전이 되어 캔버스 회전 핸들 기하와 어긋난다 (감사 #6).
        transformOrigin:
          base.rotate && base.fromShape
            ? `${(base.fromShape.x * 100).toFixed(2)}% ${(base.fromShape.y * 100).toFixed(2)}%`
            : css.transformOrigin ?? "50% 50%",
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        willChange: inCurveClone ? undefined : "transform, opacity",
        backfaceVisibility: "hidden",
      }}
    >
      {/* goo 필터를 건 <g> 가 색칠된 블롭 2개를 직접 감싼다. 필터 안에서 블러로
          두 원을 번지게 → feColorMatrix 알파 임계로 다시 뭉치게(경계 선명화).
          두 원이 겹치는 동안은 임계 위라 목(neck)이 이어지고, t 가 커져 간격이
          블러 폭을 넘으면 임계 아래로 떨어져 툭 끊긴다 = detach. */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden
        data-nobounds="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <defs>
          <filter
            id={gooId}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation={blurPx.toFixed(2)}
              result="blur"
            />
            <feColorMatrix in="blur" type="matrix" values={matrix} />
          </filter>
        </defs>
        <g filter={`url(#${gooId})`}>
          <circle
            cx={sx.toFixed(2)}
            cy={sy.toFixed(2)}
            r={rPx.toFixed(2)}
            fill={paint}
          />
          <circle
            cx={tx.toFixed(2)}
            cy={ty.toFixed(2)}
            r={trPx.toFixed(2)}
            fill={paint}
          />
        </g>
      </svg>
    </div>
  );
};
