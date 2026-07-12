// extrudeBox — 도형 압출을 "진짜 옆면 지오메트리" 로 (AE C4D 렌더러 방식).
//
// AE 의 Extrusion Depth 는 앞/뒷면 윤곽을 잇는 실제 옆벽 폴리곤을 만든다.
// 판 적층(slice stack)은 에지온(측면 90도)에서 판 사이 틈이 줄무늬로 드러나는
// 구조적 한계가 있어(실측), 도형은 CSS 3D 박스 정석 기법으로 교체:
//   앞면(z=0) + 뒷면(z=-d) + 옆벽 세그먼트들(직선 벽 4 + 라운드 코너 호 분할).
// 모든 벽이 같은 preserve-3d 공간의 실제 평면이라 씬 카메라 회전에도 정확하다.
//
// 벽 파라미터 family: wall(px, py, phi, len) —
//   위치 (px,py), 바깥 법선 각도 phi (0=+x/우, 90=상… CSS y-down 기준 (cos, -sin)),
//   transform: translate3d(px,py,-d/2) rotateZ(-phi) rotateY(90), 크기 d x len.
//   (rotateY(90) 이 div 의 가로축을 z 로 눕히고, rotateZ(-phi) 가 법선을 (cos,-sin) 으로.)
//
// 음영: 고정 상단좌측 광 기준 램버트 근사 — b = base + range*max(0, cos(phi-135deg)).
// (AE 기본 material 룩. 씬 라이트 연동은 후속.)
//
// 텍스트/이미지는 글리프 윤곽 벽을 CSS 로 만들 수 없어 판 적층 유지 (문서화).

import React from "react";
import { LightCtx, lightBasisFor, rotateNormal } from "./lighting";

const CORNER_SEGS = 7; // 90도 호 분할 수 (7 -> 세그먼트당 ~12.9도, 시각 매끈 실측)
const ELLIPSE_SEGS = 40;

type Basis = { L: [number, number, number]; ambient: number; intensity: number };

// 면 음영 — 로컬 법선을 요소 회전(rx/ry)으로 월드에 세운 뒤 광원과 램버트.
// 요소가 돌면 어느 면이 빛을 받는지가 실제로 바뀐다 (사용자 리포트 수정:
// 이전엔 로컬 phi 만 봐서 회전해도 음영이 고정이었다).
function faceShade(localN: [number, number, number], rx: number, ry: number, basis: Basis): number {
  const N = rotateNormal(localN, rx, ry);
  const dot = N[0] * basis.L[0] + N[1] * basis.L[1] + N[2] * basis.L[2];
  return Math.max(0.1, Math.min(1.45, basis.ambient + basis.intensity * Math.max(0, dot)));
}

type Wall = { px: number; py: number; phi: number; len: number };

function wallDiv(w: Wall, depth: number, fill: string, key: number, rx: number, ry: number, basis: Basis): React.ReactElement {
  const phiRad = (w.phi * Math.PI) / 180;
  return (
    <div
      key={key}
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: depth,
        height: w.len + 0.5, // 세그먼트 이음새 미세 겹침 (헤어라인 틈 방지)
        marginLeft: -depth / 2,
        marginTop: -(w.len + 0.5) / 2,
        transform: `translate3d(${w.px.toFixed(2)}px, ${w.py.toFixed(2)}px, ${(-depth / 2).toFixed(2)}px) rotateZ(${(-w.phi).toFixed(3)}deg) rotateY(90deg)`,
        background: fill,
        filter: `brightness(${faceShade([Math.cos(phiRad), -Math.sin(phiRad), 0], rx, ry, basis).toFixed(3)})`,
        backfaceVisibility: "hidden",
        pointerEvents: "none",
      }}
    />
  );
}

/** 라운드 사각형 벽 목록: 직선 벽 4 + 코너 호 세그먼트 4x CORNER_SEGS */
function rectWalls(w: number, h: number, r: number): Wall[] {
  const walls: Wall[] = [];
  const cr = Math.max(0, Math.min(r, w / 2, h / 2));
  // 직선 벽: 우(phi 0), 상(90), 좌(180), 하(270)
  if (h - 2 * cr > 0.5) {
    walls.push({ px: w / 2, py: 0, phi: 0, len: h - 2 * cr });
    walls.push({ px: -w / 2, py: 0, phi: 180, len: h - 2 * cr });
  }
  if (w - 2 * cr > 0.5) {
    walls.push({ px: 0, py: -h / 2, phi: 90, len: w - 2 * cr });
    walls.push({ px: 0, py: h / 2, phi: 270, len: w - 2 * cr });
  }
  if (cr > 0.5) {
    // 코너 중심 4곳: [시작 phi] 우상(0->90), 좌상(90->180), 좌하(180->270), 우하(270->360)
    const corners: Array<{ cx: number; cy: number; from: number }> = [
      { cx: w / 2 - cr, cy: -h / 2 + cr, from: 0 },
      { cx: -w / 2 + cr, cy: -h / 2 + cr, from: 90 },
      { cx: -w / 2 + cr, cy: h / 2 - cr, from: 180 },
      { cx: w / 2 - cr, cy: h / 2 - cr, from: 270 },
    ];
    const seg = 90 / CORNER_SEGS;
    const segLen = 2 * cr * Math.sin(((seg / 2) * Math.PI) / 180); // 호의 현 길이
    for (const c of corners) {
      for (let i = 0; i < CORNER_SEGS; i++) {
        const phi = c.from + seg * (i + 0.5);
        const rad = (phi * Math.PI) / 180;
        walls.push({
          px: c.cx + cr * Math.cos(rad),
          py: c.cy - cr * Math.sin(rad),
          phi,
          len: segLen,
        });
      }
    }
  }
  return walls;
}

/** 타원 벽 목록: 둘레를 ELLIPSE_SEGS 개 현으로 */
function ellipseWalls(w: number, h: number): Wall[] {
  const a = w / 2;
  const b = h / 2;
  const walls: Wall[] = [];
  for (let i = 0; i < ELLIPSE_SEGS; i++) {
    const t0 = (2 * Math.PI * i) / ELLIPSE_SEGS;
    const t1 = (2 * Math.PI * (i + 1)) / ELLIPSE_SEGS;
    const tm = (t0 + t1) / 2;
    // 점 (a cos t, -b sin t) (y-down 화면에서 t=90도 가 위쪽)
    const x0 = a * Math.cos(t0), y0 = -b * Math.sin(t0);
    const x1 = a * Math.cos(t1), y1 = -b * Math.sin(t1);
    const len = Math.hypot(x1 - x0, y1 - y0);
    // 타원 바깥 법선: (cos t / a, -sin t / b) 정규화 -> phi
    const nx = Math.cos(tm) / a, ny = Math.sin(tm) / b;
    const phi = (Math.atan2(ny, nx) * 180) / Math.PI;
    walls.push({ px: (x0 + x1) / 2, py: (y0 + y1) / 2, phi, len });
  }
  return walls;
}

/** 도형 압출 — 앞면(children)/뒷면/실제 옆벽. 부모는 perspective "속성" +
 *  회전 래퍼(preserve-3d) 구조를 그대로 사용 (ComposedShape). */
export function ExtrudedBox(props: {
  widthPx: number;
  heightPx: number;
  depth: number;
  radiusPx: number;
  kind: "rectangle" | "ellipse";
  fill: string;
  /** 요소 3D 자세 — 면별 월드 법선 계산 (회전 시 음영이 돈다) */
  rx?: number;
  ry?: number;
  /** 요소 중심 (comp fraction) — point 라이트 방향용 */
  elemPos?: { x: number; y: number; z?: number };
  children: React.ReactNode; // 앞면 비주얼 (ShapeVisual)
}): React.ReactElement {
  const { widthPx: w, heightPx: h, depth, radiusPx, kind, fill, children } = props;
  const light = React.useContext(LightCtx);
  const rx = props.rx ?? 0;
  const ry = props.ry ?? 0;
  const basis = lightBasisFor(light, props.elemPos);
  const walls = kind === "ellipse" ? ellipseWalls(w, h) : rectWalls(w, h, radiusPx);
  const radius = kind === "ellipse" ? "50%" : radiusPx;
  return (
    <div style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d" }}>
      {/* 뒷면 — 법선 (0,0,-1). 카메라가 뒤로 돌면 이 면이 보인다. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          transform: `translateZ(${(-depth).toFixed(2)}px)`,
          background: fill,
          borderRadius: radius,
          filter: `brightness(${faceShade([0, 0, -1], rx, ry, basis).toFixed(3)})`,
          pointerEvents: "none",
        }}
      />
      {/* 옆벽 — 실제 지오메트리 (에지온에서도 빈틈 없음) */}
      {walls.map((wl, i) => wallDiv(wl, depth, fill, i, rx, ry, basis))}
      {/* 앞면 — 법선 (0,0,1). 텍스트(three)와 같은 광원 기저라 요소 간 일치. */}
      <div style={{ position: "absolute", inset: 0, transform: "translateZ(0.01px)", backfaceVisibility: "hidden", filter: `brightness(${faceShade([0, 0, 1], rx, ry, basis).toFixed(3)})` }}>{children}</div>
    </div>
  );
}
