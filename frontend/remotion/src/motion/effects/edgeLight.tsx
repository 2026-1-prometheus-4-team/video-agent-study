// edge_light — 라운드 사각 둘레의 스침광(grazing light)을 "일반 요소"로.
//
// preset(glow_card 등)의 orbit 은 시간(period/easing)이 요소 안에 숨어 있어
// 트랙에서 보이지도 수정되지도 않았다. edge_light 는 하이라이트 위치를
// progress 채널 키프레임으로 받는다:
//   progress 0 -> 1 = 한 바퀴 (정수부 = 랩 수, fract 만 사용)
//   회전 속도/이징 = 키프레임 간격/이징 그 자체 (AE 와 같은 모델)
// 나머지(x/y/scale/rotate/opacity/blur)도 표준 채널. frame 과 조합해
// "글로우 카드" 를 일반 요소들로 조립할 수 있다.

import React from "react";
import { useVideoConfig } from "remotion";
import { FrameBoxCtx } from "../SceneRenderer";
import { grazingLight } from "./orbitGlow";
import { usePresetTransform, presetWrapStyle, type PresetBase } from "./presetTransform";
import type { ElementKeyframe, ElementTiming } from "../keyframes";

export type EdgeLightSpec = {
  element: "edge_light";
  id?: string;
  base?: PresetBase & {
    radius?: number; // 코너 반경(vw). 기본 1.3
    progress?: number; // 정적 하이라이트 위치 (키 없을 때). 0..1, 기본 0
    span?: number; // 밝은 구간 길이(경로 비율). 기본 0.38
    thickness?: number; // 하이라이트 최대 두께(px). 기본 3
    colors?: [string, string]; // [중심, 양끝]. 기본 보라
    dim?: string; // 빛 없는 구간의 희미한 림. 기본 없음(투명)
    bloom?: number; // halo 배율. 기본 1
    glow?: number; // 전체 강도. 기본 1
  };
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
};

export const EdgeLight: React.FC<{ spec: EdgeLightSpec }> = ({ spec }) => {
  const t = usePresetTransform(spec);
  const { width, height } = useVideoConfig();
  const vw = (v: number) => (v / 100) * width;
  const b = spec.base ?? {};
  // frame 자식 + width/height 미지정 = 부모 콘텐츠 박스를 채움(auto).
  // 카드/알약의 "테두리 빛"은 컨테이너와 한 몸이라, frame 을 리사이즈하면
  // 빛도 따라 커져야 한다 (실측: vw 고정이라 frame 만 커지던 버그).
  const box = React.useContext(FrameBoxCtx);
  const auto = box != null && b.width == null && b.height == null;
  const w = auto ? (box.pxW ?? box.w * width) : vw(b.width ?? 22);
  const h = auto ? (box.pxH ?? box.h * height) : vw(b.height ?? 15);
  const r = vw(b.radius ?? 1.3);
  const bw = b.thickness ?? 3;
  const colors: [string, string] = b.colors ?? ["#C9A0FF", "#7C3AED"];
  // progress 채널: 키프레임 우선, 없으면 base.progress (정지 하이라이트)
  const progress = t.progress ?? b.progress ?? 0;
  if (!t.visible) return null;

  const wrap = presetWrapStyle(t);
  return (
    // % 포지셔닝 — shape 와 같은 규칙: frame 자식이면 frame-로컬, 씬 직속이면
    // comp 좌표. px 로 계산하면 frame 안에서 comp 크기 기준으로 튀어나간다(실측).
    <div
      style={{
        position: "absolute",
        left: `${(t.pos.x * 100).toFixed(4)}%`,
        top: `${(t.pos.y * 100).toFixed(4)}%`,
        width: w,
        height: h,
        opacity: t.opacity,
        filter: wrap.filter,
        transform: ["translate(-50%, -50%)", wrap.transform].filter(Boolean).join(" "),
        transformOrigin: "50% 50%",
      }}
    >
      <svg width={w} height={h} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {b.dim && (
          <rect
            x={bw / 2}
            y={bw / 2}
            width={w - bw}
            height={h - bw}
            rx={Math.max(0, r - bw / 2)}
            fill="none"
            stroke={b.dim}
            strokeWidth={Math.max(1.2, bw * 0.16)}
          />
        )}
        {grazingLight({
          p: progress,
          span: b.span,
          colors,
          bloom: b.bloom,
          x: bw / 2,
          y: bw / 2,
          w: w - bw,
          h: h - bw,
          r: Math.max(0, r - bw / 2),
          bw,
          glow: b.glow ?? 1,
        })}
      </svg>
    </div>
  );
};
