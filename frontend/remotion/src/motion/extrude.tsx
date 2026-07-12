// extrude.tsx — 평면 요소에 두께(3D 압출). AE Geometry Options 의
// Extrusion Depth(C4D 렌더러) 등가를 CSS 3D 로.
//
// 기법: 콘텐츠를 Z 축으로 N 장 적층 (검증된 CSS 3D 압출 기법). 앞장은 원본,
// 뒤 장들은 어둡게(brightness) — 회전 시 옆면 벽처럼 읽힌다. 부모 컨테이너에
// transform-style: preserve-3d + 자기 transform 의 perspective() 가 자식
// translateZ 를 투영한다.
//
// cemented: N=10 장 (GPU 레이어 예산 — curve3d 스트립 32장 안전 실측의 1/3),
// 옆면 밝기 0.45 (관찰 기반 — 금속/잉크 압출 룩의 관례적 명도).
//
// 한계 (구조적): 같은 컨테이너에 CSS filter(글로우/모션블러)가 걸리면 브라우저가
// 3D 를 평탄화(flatten)한다 — extrude 와 glow 는 동시 사용 불가. 에디터 힌트로 안내.

import React from "react";

/** 압출 깊이 px. 0/undefined = 끔. */
export type ExtrudeDepth = number;

// 층수는 깊이에 비례 — 간격이 ~1.6px 를 넘으면 "얇은 판 여러 장" 으로 읽힌다
// (실측: depth 59 를 10장으로 나누면 6.5px 간격 = 판 분리 가시). 상한 48장
// (GPU 레이어 예산 — curve3d 32장 안전 실측 대비 요소당 한시적 여유).
const layersFor = (depth: number) => Math.max(10, Math.min(48, Math.round(depth / 1.6) + 1));
const SIDE_BRIGHTNESS = 0.45;

export function ExtrudeStack(props: {
  depth: number;
  children: React.ReactNode;
  /** true = 부모가 고정 크기(도형/이미지): 래퍼가 inset:0.
   *  false(기본) = 콘텐츠가 크기를 정함(텍스트): 앞장이 in-flow 로 남아
   *  컨테이너 크기 기준을 유지한다 (전부 absolute 면 0x0 으로 수축 — 실측). */
  fill?: boolean;
}): React.ReactElement {
  const { depth, children, fill } = props;
  const LAYERS = layersFor(depth);
  const step = depth / (LAYERS - 1);
  const copies = Array.from({ length: LAYERS - 1 }, (_, i) => {
    const z = -depth + i * step; // 뒤(-depth) .. 앞 직전
    return (
      <div
        key={i}
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateZ(${z.toFixed(2)}px)`,
          filter: `brightness(${SIDE_BRIGHTNESS})`,
          backfaceVisibility: "visible",
          pointerEvents: "none",
        }}
      >
        {children}
      </div>
    );
  });
  return (
    <div
      style={{
        position: fill ? "absolute" : "relative",
        inset: fill ? 0 : undefined,
        transformStyle: "preserve-3d",
      }}
    >
      {copies}
      {/* 앞장 — in-flow(텍스트 크기 기준) 또는 fill. translateZ(0) = 스택 최전면 */}
      <div
        style={{
          position: fill ? "absolute" : "relative",
          inset: fill ? 0 : undefined,
          transform: "translateZ(0.01px)",
          backfaceVisibility: "visible",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** 뒷면 표시 규칙 — 뒷면이 실제로 보일 수 있는 각도에서만 visible.
 *  (backface hidden 은 글리프 떨림 방지 GPU 콤보의 일부라 평상시 유지 —
 *  90도 이내 기울기에서는 뒷면이 안 보이므로 hidden 이 무해하다.) */
export function backfaceFor(rotXDeg: number, rotYDeg: number): "visible" | "hidden" {
  const wrap = (d: number) => {
    const m = ((d % 360) + 360) % 360;
    return m > 180 ? 360 - m : m;
  };
  return wrap(rotXDeg) > 90 || wrap(rotYDeg) > 90 ? "visible" : "hidden";
}
