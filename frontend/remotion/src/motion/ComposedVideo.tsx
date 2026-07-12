// ComposedVideo.tsx
// 영상 요소 — image 요소의 <Video> 판. 붙여넣기/드롭/업로드한 영상 자체가 독립 요소다
// (프레임/그룹에 안 묶여도 독립 배치). shape/image 의 wrapper 채널 합성 / 키프레임 /
// 클립 트림을 그대로 재사용해 이동·스케일·회전·투명도·키프레임·트림이 동일하게 동작한다.
// 렌더는 Remotion <Video> — 헤드리스 렌더에 프레임 캡처 + 사운드가 최종물에 들어간다.
//
// base.src 는 URL 문자열만(업로드 결과 "/assets/..." 또는 외부 URL). 스토리지 무관.

import React from "react";
import { rot3d } from "./transform3d";
import { CurveCloneCtx } from "./curve3d";
import { useCurrentFrame, useVideoConfig, Video, staticFile } from "remotion";
import { clamp } from "./core/easing";
import {
  resolveTimings,
  type MotionLayer,
  type SceneFit,
} from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { channelsToCss, composeChannels } from "./wrappers";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";

// 업로드 에셋("/assets/...")은 staticFile 로 — 프리뷰(Next public)와 달리
// 렌더 번들 서버는 절대경로를 그대로 요청해 404(=MEDIA Format error)가 났다.
function resolveAssetSrc(src: string): string {
  if (/^(https?:)?\/\//.test(src) || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return staticFile(src.replace(/^\//, ""));
}


export type VideoElementSpec = {
  element: "video";
  id?: string;
  base: {
    /** 영상 URL (업로드 결과 "/assets/..." 또는 외부 URL). mp4/webm 등. */
    src: string;
    /** 크기 (vw / vh 기준 percent). shape/image 와 동일 규칙. */
    width?: number;
    height?: number;
    /** 중심 위치 (0..1). 기본 0.5/0.5. */
    position?: { x: number; y: number };
    /** 정적 회전(deg). */
    /** 테두리 (Figma Stroke — inside ring). */
    stroke?: string;
    strokeWidth?: number; // px
    rotate?: number;
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    /** object-fit. 기본 cover(배경 영상 관례 — 꽉 채움). */
    fit?: "contain" | "cover" | "fill";
    /** 모서리 라운드(px). */
    radius?: number;
    /** 요소 불투명도(0..1). wrapper opacity 와 곱해짐. */
    opacity?: number;
    /** 루프 재생. 기본 true(배경 영상). */
    loop?: boolean;
    /** 음소거. 기본 true. */
    muted?: boolean;
    /** 재생 속도. 기본 1. */
    playbackRate?: number;
    /** 소스 영상 트림 오프셋(frame). 긴 영상을 30s 씬 여러 개로 나눌 때
     *  각 씬이 이어서 재생되도록 지정 (에이전트 결과 spec 분할용). */
    trimBefore?: number;
  };
  layers?: MotionLayer[];
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
};

export const ComposedVideo: React.FC<{
  spec: VideoElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
}> = ({ spec, sceneFrames, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();

  const base = spec.base ?? ({} as VideoElementSpec["base"]);
  const pos = base.position ?? { x: 0.5, y: 0.5 };
  const wPx = (clamp(base.width ?? 40, 0.5, 400) / 100) * width;
  const hPx = (clamp(base.height ?? 22.5, 0.5, 400) / 100) * height;

  // 클립 트림 게이트 + clock 시프트.
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  const layers: MotionLayer[] = Array.isArray(spec.layers) ? spec.layers : [];
  const timed = resolveTimings(layers, winLen, { fps, unitCount: 1 }, intrinsicForLayer, fit);
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

  if (layers.length > 0 && timed.every((l) => frame < l.startFrame)) return null;
  if (!base.src) return null;

  const radius = base.radius ?? 0;
  return (
    <div
      style={{
        position: "absolute",
        left: `${(kf.x ?? pos.x) * 100}%`,
        top: `${(kf.y ?? pos.y) * 100}%`,
        width: wPx,
        height: hPx,
        transform: `translate(-50%, -50%)${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY, perspective: base.perspective })}${inCurveClone ? "" : " translate3d(0,0,0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        willChange: inCurveClone ? undefined : "transform, opacity",
        backfaceVisibility: "hidden",
        borderRadius: radius,
        overflow: "hidden",
      }}
    >
      <Video
        src={resolveAssetSrc(base.src)}
        loop={base.loop ?? true}
        muted={base.muted ?? true}
        playbackRate={base.playbackRate ?? 1}
        trimBefore={base.trimBefore}
        style={{ width: "100%", height: "100%", objectFit: base.fit ?? "cover", display: "block" }}
      />
      {base.stroke && (
        <div style={{ position: "absolute", inset: 0, borderRadius: radius, boxShadow: `inset 0 0 0 ${base.strokeWidth ?? 2}px ${base.stroke}`, pointerEvents: "none" }} />
      )}
    </div>
  );
};
