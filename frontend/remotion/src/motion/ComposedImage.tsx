// ComposedImage.tsx
// 이미지 요소 — Figma식으로 붙여넣기/업로드한 그림 자체가 하나의 요소다(프레임/그룹에
// 안 묶여도 독립 배치). shape 의 wrapper 채널 합성 / 키프레임 / 클립 트림을 그대로
// 재사용해 이동·스케일·회전·투명도·키프레임·트림이 전부 동일하게 동작한다.
// 렌더는 Remotion <Img> — 헤드리스 렌더에도 프레임에 캡처된다(<Video> 와 동일 관례).
//
// base.src 는 URL 문자열만 담는다(업로드 결과 "/assets/..." 또는 외부 URL). 스토리지가
// 로컬이든 R2든 spec 은 URL 만 알면 되므로, 이식 시 업로드 경로만 바꾸면 된다.

import { ExtrudeStack, backfaceFor } from "./extrude";
import React from "react";
import { FlowItemCtx } from "./SceneRenderer";
import { rot3d } from "./transform3d";
import { CurveCloneCtx } from "./curve3d";
import { useCurrentFrame, useVideoConfig, Img, staticFile } from "remotion";
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


// ---------------------------------------------------------------------------
// A2 decompose — 정적 UI 이미지를 조각(mask rect)으로 분해해 순차 조립 (v06 재현).
//
// AE 원본 워크플로우(ae_transcripts v06 정제 레시피):
//   요소별 mask -> position+opacity 키프레임 -> 시작 아래+opacity 0 ->
//   bounce 표현식(Amp .04 / Freq 1.8 / Decay 3) -> Split Mask -> Offset(sequence).
//
// AE inertial bounce 수식 (graymachine/creativecow 표준 표현식 확인):
//   value + v * amp * sin(2*PI*freq*t) / exp(decay*t)
//   v = velocityAtTime(마지막 키프레임) — 진폭이 "도착 속도"에 비례한다.
//   즉 linear 접근(도착 속도 = travel/approach초)이 끝난 지점부터 감쇠 사인.
//   node 검증(docs/motion_math.md): travel 0.12*1080px, 접근 5f@24fps ->
//   v=622px/s, 첫 피크 착지+3.3f에서 16.4px 오버슛, 1초 후 5%로 감쇠.
// ---------------------------------------------------------------------------
export type DecomposeSpec = {
  /** grid = cols x rows 균등 분할. masks = rects[] 직접 지정. 기본 grid. */
  mode?: "grid" | "masks";
  /** grid 분할 수. 기본 3x4 (buildlist A2 spec 예시). */
  cols?: number;
  rows?: number;
  /** masks 모드 — 이미지 기준 fraction rect (0..1). */
  rects?: Array<{ x: number; y: number; w: number; h: number }>;
  /** 조각 등장 방향(어느 쪽에서 날아오나). 기본 bottom (v06: 시작 아래로). */
  entry?: "bottom" | "top" | "left" | "right";
  /** 조각당 지연 프레임. cemented 5 (v06 실측: 조각마다 5프레임 offset). */
  stagger?: number;
  /** 이동 거리(요소 크기 fraction). v06 화면 관찰 근사 0.12 — 정밀 재측정 시 갱신. */
  travel?: number;
  /** 전체 시작 지연(씬-로컬 프레임). 기본 0. */
  delay?: number;
};

export type ImageElementSpec = {
  element: "image";
  id?: string;
  base: {
    /** 이미지 URL (업로드 결과 "/assets/..." 또는 외부 URL). PNG/JPG/SVG/webp 등. */
    src: string;
    /** 크기 (vw / vh 기준 percent). w=화면폭 %, h=화면높이 %. shape 와 동일 규칙. */
    width?: number;
    height?: number;
    /** 중심 위치 (0..1). 기본 0.5/0.5. */
    position?: { x: number; y: number };
    /** 정적 회전(deg) — 에디터 회전 핸들. */
    /** 테두리 (Figma Stroke — inside ring). */
    stroke?: string;
    strokeWidth?: number; // px
    rotate?: number;
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    /** object-fit. 기본 contain(비율 유지, 잘림 없음). */
    fit?: "contain" | "cover" | "fill";
    /** 모서리 라운드(px). */
    radius?: number;
    /** 요소 자체 불투명도(0..1). wrapper opacity 와 곱해짐. */
    opacity?: number;
  };
  /** UI 분해 조립(A2). 있으면 이미지를 조각으로 잘라 순차 bounce 조립. */
  decompose?: DecomposeSpec;
  /** wrapper 레이어(fade/scale/move/blur 등). */
  layers?: MotionLayer[];
  /** 속성 키프레임 애니메이션(위치·스케일·회전·투명도). */
  keyframes?: ElementKeyframe[];
  /** 클립 트림(씬-로컬 in/out 프레임). */
  timing?: ElementTiming;
};

// v06 cemented 실측값 — 출처: ae_transcripts.txt 정제 레시피 [v06 Static-to-Life].
const DECOMPOSE_STAGGER = 5; // 조각당 offset 프레임 (v06: "조각마다 5프레임씩 offset")
const DECOMPOSE_APPROACH = 5; // 접근(이동) 프레임 (v06 전사 "move by five frames" 해석)
const BOUNCE_AMP = 0.04; // v06 실측: bounce Amp 0.04
const BOUNCE_FREQ = 1.8; // v06 실측: Freq 1.8 (Hz)
const BOUNCE_DECAY = 3; // v06 실측: Decay 3 (1/s)
const DECOMPOSE_TRAVEL = 0.12; // 이동 거리(요소 크기 fraction) — v06 화면 관찰 근사

/** 조각 하나의 시간 상태: 등장 오프셋(px, 진행 방향)과 불투명도.
 *  local < 0 이면 아직 시작 전(숨김). 접근 구간은 linear(도착 속도를 만들기 위해 —
 *  ease-out 이면 도착 속도 0 이라 bounce 가 사라진다), 이후 AE inertial bounce. */
function decomposePieceState(
  local: number,
  travelPx: number,
  fps: number,
): { off: number; opacity: number } {
  if (local < 0) return { off: travelPx, opacity: 0 };
  if (local < DECOMPOSE_APPROACH) {
    const p = local / DECOMPOSE_APPROACH;
    return { off: travelPx * (1 - p), opacity: p };
  }
  // 착지 후 bounce: v = 도착 속도(px/s, 목표 방향으로 음수), t = 착지 후 경과 초
  const v = -travelPx / (DECOMPOSE_APPROACH / fps);
  const t = (local - DECOMPOSE_APPROACH) / fps;
  const off = (v * BOUNCE_AMP * Math.sin(2 * Math.PI * BOUNCE_FREQ * t)) / Math.exp(BOUNCE_DECAY * t);
  return { off, opacity: 1 };
}

/** decompose rect 목록 (이미지 fraction 0..1). grid 는 row-major (위->아래). */
function decomposeRects(d: DecomposeSpec): Array<{ x: number; y: number; w: number; h: number }> {
  if (d.mode === "masks" && Array.isArray(d.rects) && d.rects.length > 0) {
    return d.rects.map((r) => ({
      x: clamp(r.x, 0, 1),
      y: clamp(r.y, 0, 1),
      w: clamp(r.w, 0.01, 1),
      h: clamp(r.h, 0.01, 1),
    }));
  }
  const cols = Math.round(clamp(d.cols ?? 3, 1, 12));
  const rows = Math.round(clamp(d.rows ?? 4, 1, 12));
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows });
  return out;
}

export const ComposedImage: React.FC<{
  spec: ImageElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
}> = ({ spec, sceneFrames, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const inCurveClone = React.useContext(CurveCloneCtx);
  const flowItem = React.useContext(FlowItemCtx);

  const base = spec.base ?? ({} as ImageElementSpec["base"]);
  const pos = base.position ?? { x: 0.5, y: 0.5 };
  const wPx = (clamp(base.width ?? 30, 0.5, 400) / 100) * width;
  const hPx = (clamp(base.height ?? 20, 0.5, 400) / 100) * height;

  // 클립 트림 게이트 + clock 시프트 (ComposedShape 와 동일).
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  const layers: MotionLayer[] = Array.isArray(spec.layers) ? spec.layers : [];
  const timed = resolveTimings(layers, winLen, { fps, unitCount: 1 }, intrinsicForLayer, fit);
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 요소 키프레임 접기 (scale 곱 / rotate 더함 / opacity 곱)
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  const css = channelsToCss(channels, inCurveClone);

  // 등장 전(모든 wrapper 가 미래)엔 안 그린다.
  if (layers.length > 0 && timed.every((l) => frame < l.startFrame)) return null;
  if (!base.src) return null;

  // src 해석 — 절대 URL("/assets/...", "https://...")은 그대로, 그 외("foo.png")는
  // remotion public/ 파일 이름으로 간주해 staticFile 로 해석(스펙 JSON 에서 public
  // 에셋을 직접 참조할 수 있게 — CapturedScene 의 staticFile 관례와 동일).
  const srcUrl = resolveAssetSrc(base.src);

  const radius = base.radius ?? 0;
  const deco = spec.decompose;

  // 조각 렌더 — 각 조각 div 는 최종 rect 에 놓이고 자기 transform 으로 날아온다
  // (AE 의 "mask 가 레이어와 함께 움직임"과 동일). 안쪽 래퍼가 전체 이미지 크기로
  // 역오프셋돼 조각 영역만 보인다. 조각이 이동 중 요소 박스를 벗어나므로 decompose
  // 모드에선 바깥 overflow 를 열어둔다(v06 도 조각이 UI 밖에서 날아옴).
  let content: React.ReactNode;
  if (deco) {
    const rects = decomposeRects(deco);
    const entry = deco.entry ?? "bottom";
    const stagger = Math.max(0, deco.stagger ?? DECOMPOSE_STAGGER);
    const delay = Math.max(0, deco.delay ?? 0);
    const travelFrac = clamp(deco.travel ?? DECOMPOSE_TRAVEL, 0, 1);
    const vertical = entry === "bottom" || entry === "top";
    const travelPx = travelFrac * (vertical ? hPx : wPx) * (entry === "bottom" || entry === "right" ? 1 : -1);
    content = rects.map((r, i) => {
      const st = decomposePieceState(frame - delay - i * stagger, travelPx, fps);
      if (st.opacity <= 0) return null;
      const tf = vertical
        ? `translate3d(0, ${st.off.toFixed(2)}px, 0)`
        : `translate3d(${st.off.toFixed(2)}px, 0, 0)`;
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: `${r.x * 100}%`,
            top: `${r.y * 100}%`,
            width: `${r.w * 100}%`,
            height: `${r.h * 100}%`,
            transform: tf,
            opacity: st.opacity,
            overflow: "hidden",
            willChange: inCurveClone ? undefined : "transform, opacity",
          }}
        >
          {/* 역오프셋 래퍼 — 전체 이미지에서 이 조각 영역만 보이게 */}
          <div
            style={{
              position: "absolute",
              left: `${(-r.x / r.w) * 100}%`,
              top: `${(-r.y / r.h) * 100}%`,
              width: `${(1 / r.w) * 100}%`,
              height: `${(1 / r.h) * 100}%`,
            }}
          >
            <Img
              src={srcUrl}
              style={{ width: "100%", height: "100%", objectFit: base.fit ?? "contain", display: "block" }}
            />
          </div>
        </div>
      );
    });
  } else {
    content = (
      <Img
        src={srcUrl}
        style={{ width: "100%", height: "100%", objectFit: base.fit ?? "contain", display: "block" }}
      />
    );
  }

  return (
    <div
      style={{
        ...(flowItem
          ? { position: "relative" as const, flexShrink: 0 }
          : { position: "absolute" as const, left: `${(kf.x ?? pos.x) * 100}%`, top: `${(kf.y ?? pos.y) * 100}%` }),
        width: wPx,
        height: hPx,
        transform: `${flowItem ? "" : "translate(-50%, -50%)"}${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${((base as { extrude?: number }).extrude ?? 0) > 0 ? "" : rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY, perspective: base.perspective })}${inCurveClone ? "" : " translate3d(0,0,0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        maskImage: css.maskImage,
        WebkitMaskImage: css.maskImage,
        willChange: inCurveClone ? undefined : "transform, opacity",
        // 뒷면: 90도 넘게 돌 때만 표시. 압출 시 자식 Z 투영 (radius/overflow 는
        // 압출이면 각 장에서 처리 — 컨테이너 overflow:hidden 은 3D 를 평탄화한다).
        backfaceVisibility: backfaceFor(kf.rotateX ?? base.rotateX ?? 0, kf.rotateY ?? base.rotateY ?? 0),
        // perspective 속성 — perspective() 함수는 preserve-3d 자식 z 미투영 (실측)
        perspective: ((base as { extrude?: number }).extrude ?? 0) > 0 ? (base.perspective ?? 1100) : undefined,
        borderRadius: radius,
        overflow: ((base as { extrude?: number }).extrude ?? 0) > 0 ? "visible" : deco ? "visible" : "hidden",
      }}
    >
      {!inCurveClone && ((base as { extrude?: number }).extrude ?? 0) > 0 ? (
        <div style={{ position: "absolute", inset: 0, transform: rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY }, true) || undefined, transformStyle: "preserve-3d" }}>
          <ExtrudeStack depth={(base as { extrude?: number }).extrude ?? 0} fill>
            <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden" }}>{content}</div>
          </ExtrudeStack>
        </div>
      ) : (
        content
      )}
      {base.stroke && (
        <div style={{ position: "absolute", inset: 0, borderRadius: radius, boxShadow: `inset 0 0 0 ${base.strokeWidth ?? 2}px ${base.stroke}`, pointerEvents: "none" }} />
      )}
    </div>
  );
};
