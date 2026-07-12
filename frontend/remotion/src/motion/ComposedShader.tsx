// ComposedShader.tsx — C4 셰이더 fx 레이어 (WebGL/GLSL).
// SVG 로는 근사만 되는 "살아 움직이는" 유체/유기체 계열을 GPU fragment shader 로
// 직접 그린다. 프로토타입 프리셋: living_gradient (흐르는 메시 그라데이션 배경).
//
// 결정론 (remotion 렌더 재현성의 핵심):
//  - 시간은 useCurrentFrame() 에서만 온다 -> uTime = frame/fps. R3F useFrame() 금지.
//  - ThreeCanvas 는 frameloop="never" 를 강제(@remotion/three) — 프레임이 같으면
//    uniforms 가 같고, 셰이더는 uniforms 의 순수 함수라 픽셀이 같다.
//  - 노이즈는 GLSL 내 해시 기반 simplex(시드 상수) — Math.random 없음.
//  - 헤드리스 렌더: remotion.config.ts 의 Config.setChromiumOpenGlRenderer("angle")
//    (Spike3D 에서 검증된 경로).
//
// GLSL 기법 (docs/shader_layer_spec.md 에 근거/링크):
//  - Ashima/IQ simplex noise + fbm(옥타브 합) + domain warping
//    (Inigo Quilez: f(p + 4*fbm(p + 4*fbm(p))) 패턴) 으로 "구름처럼 꿈틀거리는"
//    저주파 유동장을 만들고, 그 값으로 브랜드 팔레트를 보간한다.

import React, { useMemo } from "react";
import * as THREE from "three";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { clamp } from "./core/easing";
import { type MotionLayer, type SceneFit, resolveTimings } from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { channelsToCss, composeChannels } from "./wrappers";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";
import { CurveCloneCtx } from "./curve3d";

export type ShaderElementSpec = {
  element: "shader";
  id?: string;
  /** 프리셋.
   *  - living_gradient: 화면 전체 흐르는 메시 그라데이션
   *  - horizon_flow: 하단 가장자리에만 깔리는 물결 그라데이션 (수면처럼 울렁이는
   *    경계 + 스웰). AE 관례(하단 오프스크린 그라데이션 + Turbulent Displace)의
   *    셰이더 등가. 배경은 palette[0] (기본 검정). */
  preset?: "living_gradient" | "horizon_flow" | "horizon_glow";
  /** horizon_glow 색 스탑 — 팔레트 2/3/4번 색의 로브 배치 (좌->우).
   *  x: 하단 위치(0..1), reach: 도달 높이 배율(기본 1), intensity: 강도(기본 1). */
  stops?: { x?: number; reach?: number; intensity?: number }[];
  base?: {
    /** 중심 위치(0..1). 기본 0.5/0.5. */
    position?: { x: number; y: number };
    /** 크기(vw/vh %). 기본 100/100 (풀캔버스 배경). */
    width?: number;
    height?: number;
    /** 모서리 라운드(px). */
    radius?: number;
    opacity?: number;
    /** 2D 회전 (deg) — 다른 요소와 동일 (감사 #4: 회전 핸들이 조용히 무시되던 것). */
    rotate?: number;
  };
  /** 팔레트(2~4색 hex). 기본 brandDefaults 계열 대신 자체 기본값. */
  palette?: string[];
  /** 흐름 속도 배율. 1 = 기본(느린 드리프트). */
  speed?: number;
  layers?: MotionLayer[];
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
};

// living_gradient cemented — 레퍼런스(AI 스타트업 히어로 배경류) 관찰 기반.
// 근거/튜닝 노트: docs/shader_layer_spec.md. 정밀 실측 대상이 아니라 관찰값임을 명시.
const LG_NOISE_SCALE = 0.6; // 노이즈 주파수 — 낮을수록 블롭이 큼(메시 그라데이션은 화면당 2~4덩어리)
const LG_WARP = 1.4; // 도메인 워프 강도 — 높으면 대리석/오일 슬릭처럼 미세 디테일이 폭증
// 시간 흐름은 두 갈래 (docs/motion_math.md C4 절):
//  - 팬(pan): 필드를 통째로 느리게 이동 — 속도가 워프 게인과 무관해 튜닝에 강건.
//    0.020/s = 화면의 ~3%/s 로 블롭이 흘러감 (레퍼런스 관찰 속도).
//  - 워프 진화(evolve): 워프 체인 안 유속. 체인 게인이 옥타브/W 에 따라 크게
//    변하므로(5oct/W3.2 = ~650x, 2oct/W1.4 = ~7x — node 실측) 소량만.
// 프레임당 총 필드 변화 ~0.006 (부드러움), 초당 ~0.15 (살아있음).
const LG_PAN = 0.02;
const LG_EVOLVE = 0.05;
const LG_OCTAVES = 2; // fbm 옥타브 — 3이면 부드러운 저주파 유동장(5는 대리석 질감)

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uAspect;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;

// --- 2D simplex noise (Ashima Arts / Ian McEwan, MIT — 표준 구현) ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// fbm — 옥타브 합 (진폭 절반씩, 주파수 2배씩). 값 대략 [-1,1].
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < ${LG_OCTAVES}; i++) {
    v += a * snoise(p);
    p = p * 2.0 + vec2(31.7, 17.3);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = vUv;
  p.x *= uAspect;
  p *= ${LG_NOISE_SCALE.toFixed(2)};
  float tw = uTime * ${LG_EVOLVE.toFixed(3)};
  vec2 pan = uTime * ${LG_PAN.toFixed(3)} * vec2(1.0, 0.45);
  // 도메인 워프 (IQ): q = fbm(p + 흐름), r = fbm(p + w*q + 다른 방향 흐름),
  // 최종 필드 = fbm(p + w*r). 흐름 벡터를 축마다 달리해 "제자리 왕복" 느낌 제거.
  vec2 q = vec2(
    fbm(p + pan + tw * vec2(0.30, 0.16)),
    fbm(p + pan + vec2(5.2, 1.3) + tw * vec2(-0.22, 0.28))
  );
  vec2 r = vec2(
    fbm(p + pan + ${LG_WARP.toFixed(2)} * q + vec2(1.7, 9.2) + tw * vec2(0.18, -0.24)),
    fbm(p + pan + ${LG_WARP.toFixed(2)} * q + vec2(8.3, 2.8) + tw * vec2(0.24, 0.20))
  );
  float f = fbm(p + pan + ${LG_WARP.toFixed(2)} * r);
  // [-1,1] -> [0,1] 후 팔레트 4점 보간 (완만한 S 커브로 중간색 체류 시간 확보)
  float u = smoothstep(-0.9, 0.9, f);
  vec3 col = mix(uC0, uC1, smoothstep(0.0, 0.38, u));
  col = mix(col, uC2, smoothstep(0.34, 0.72, u));
  col = mix(col, uC3, smoothstep(0.68, 1.0, u));
  // q 를 살짝 섞어 큰 흐름 방향의 밝기 변조 (평평한 영역 방지)
  col *= 0.95 + 0.08 * q.x;
  gl_FragColor = vec4(col, 1.0);
}
`;

// horizon_flow — 하단 수평선 글로우. 수면(경계)을 fbm 으로 울렁이게 하고
// 그 아래만 팔레트로 채운다. uC0=배경, uC1=딥, uC2=메인, uC3=웜 코너 액센트.
// planeGeometry UV: v=0 이 화면 아래.
const HORIZON_FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uAspect;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * snoise(p);
    p = p * 2.0 + vec2(31.7, 17.3);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float t = uTime;
  // 파동장 — 좌우로 천천히 흐르는 저주파 fbm (AE Turbulent Displace 의 등가).
  // 높이 좌표를 워프해서 "경계선 없는" 글로우의 등고선이 울렁이게 한다.
  float wave = fbm(vec2(p.x * 0.8 - t * 0.05, t * 0.04));
  float ripple = fbm(vec2(p.x * 2.2 + t * 0.035, 7.3 + t * 0.055));
  float h = uv.y - 0.07 * wave - 0.03 * ripple; // 워프된 높이(0 = 바닥)
  // 하드 엣지 없음 — 바닥에서부터 순수 지수 감쇠 (거대한 블러 글로우 등가)
  float glow = exp(-max(h, 0.0) * 4.6);
  // 스웰(숨쉬기) — 느리게, 살짝만
  glow *= 0.82 + 0.18 * (0.5 + 0.5 * sin(t * 0.4 + wave * 2.0));
  glow = clamp(glow, 0.0, 1.0);
  // 색 필드: x 저주파 변조로 딥<->메인 이동, 바닥 근처가 메인 쪽
  float hueMix = clamp(0.35 + 0.35 * fbm(vec2(p.x * 0.6 + t * 0.025, 3.1)) + 0.5 * glow, 0.0, 1.0);
  vec3 grad = mix(uC1, uC2, hueMix);
  vec3 col = mix(uC0, grad, glow * 0.9);
  // 웜 코너 액센트 (uC3) — 좌하단 국소, 잔물결 따라 은근히 출렁
  float warm = exp(-length((uv - vec2(0.04, 0.0)) * vec2(1.5, 3.0))) * (0.6 + 0.4 * ripple);
  col += uC3 * warm * glow * 0.5;
  gl_FragColor = vec4(col, 1.0);
}
`;

// horizon_glow — 레퍼런스 히어로 룩: 딥 네이비 위에 "가산" 글로우 (비비드).
// mix(배경, 색) 는 배경이 섞여 채도가 죽는다 — 여기선 빛을 더하듯 add 하고
// 소프트 톤맵으로 클리핑만 눌러 형광에 가까운 채도를 유지한다.
// uC0=배경, uC1=상단 딥 틴트, uC2=바이올렛 돔, uC3=핫 코너(핑크/코랄).
const HORIZON_GLOW_FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uAspect;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec3 uStopX;
uniform vec3 uStopReach;
uniform vec3 uStopGain;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main() {
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float t = uTime;
  // 유기적 드리프트 — 글로우 중심이 천천히, 그러나 몇 초 안에 체감되게 흐른다
  // (uTime 은 초 단위 — 4s 씬에서도 살아있어야 함)
  float d1 = snoise(vec2(t * 0.22, 1.7)) * 0.10;
  float d2 = snoise(vec2(t * 0.19, 8.2)) * 0.07;
  // 수평 트래블 웨이브 — 글로우 등고선이 좌우로 흐르며 울렁 (모양은 하단 유지)
  float wave = snoise(vec2(p.x * 0.7 - t * 0.25, t * 0.16));
  // 세 개의 하단 로브 — 팔레트 색이 각자 "구분되는" 밴드로 보이게
  // (이전: color2 가 상단 틴트에만 쓰여 사실상 실종, 돔+코너 2색 구성이라
  //  여러 색을 줘도 한 덩어리로 뭉개졌다). 좌->우 = C1, C3, C2.
  // 스탑 파라미터 — 색별 x 위치/도달 높이(reach)/강도(gain)를 에디터에서 편집
  vec2 cA = vec2(uStopX.x * uAspect + d2 * 0.6, -0.14 + wave * 0.025);
  float gA = exp(-pow(length((p - cA) * vec2(0.95, 1.9) / max(uStopReach.x, 0.2)), 1.5) * 2.7);
  vec2 cB = vec2(uStopX.y * uAspect + d1, -0.30 + wave * 0.035);
  float gB = exp(-pow(length((p - cB) * vec2(0.62, 2.0) / max(uStopReach.y, 0.2)), 1.6) * 2.5);
  vec2 cC = vec2(uStopX.z * uAspect - d2 * 0.7, -0.16 - wave * 0.03);
  float gC = exp(-pow(length((p - cC) * vec2(0.9, 1.85) / max(uStopReach.z, 0.2)), 1.5) * 2.7);
  // 상단 딥 틴트 — 아주 은은하게만 (상단은 어둡게 유지)
  float g0 = exp(-uv.y * 2.8);
  // 숨쉬기 — 체감되는 속도로
  float swell = 0.90 + 0.10 * sin(t * 0.8 + wave * 1.5);
  // 색 미세 시머 — 바이올렛이 살짝 밝아졌다 어두워졌다 (t+x 이동)
  float shimmer = 0.9 + 0.2 * snoise(vec2(p.x * 0.5 + t * 0.15, 4.4));
  // 가산 합성 + 소프트 톤맵 (1-exp) — 클리핑 없이 채도 유지
  vec3 col = uC0
    + (uC1 + uC2 + uC3) * g0 * 0.06
    + uC1 * gA * 1.9 * uStopGain.x * swell
    + uC2 * gB * 1.95 * uStopGain.y * swell * shimmer
    + uC3 * gC * 1.85 * uStopGain.z * swell;
  col = vec3(1.0) - exp(-col * 1.55);
  gl_FragColor = vec4(col, 1.0);
}
`;

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function hexToVec3(hex: string): THREE.Vector3 {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x222233;
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

// 기본 팔레트 — 어두운 네이비 -> 바이올렛 -> 시안 (AI 히어로 배경 관례색).
const DEFAULT_PALETTE = ["#0B0E1A", "#31226E", "#7C4DFF", "#52C5FF"];
// horizon_flow 기본 — 검정 배경, 딥 바이올렛 -> 퍼플, 좌하단 웜 액센트 (레퍼런스 관찰색).
const HORIZON_PALETTE = ["#08070B", "#2A1B5E", "#6B3FD4", "#C2502F"];
// horizon_glow 기본 — 비비드: 딥 네이비 / 남색 틴트 / 형광 바이올렛 / 핫핑크.
const HORIZON_GLOW_PALETTE = ["#05030A", "#1B1145", "#7C3AED", "#F43F5E"];
const DEFAULT_STOP_X = new THREE.Vector3(0.08, 0.52, 0.97);
const DEFAULT_STOP_ONE = new THREE.Vector3(1, 1, 1);
void DEFAULT_STOP_ONE;
const DEFAULT_STOP_REACH = new THREE.Vector3(1, 1.3, 1);

const Quad: React.FC<{ time: number; aspect: number; colors: THREE.Vector3[]; frag: string; stopX?: THREE.Vector3; stopReach?: THREE.Vector3; stopGain?: THREE.Vector3 }> = ({ time, aspect, colors, frag, stopX, stopReach, stopGain }) => {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms: {
          uTime: { value: 0 },
          uAspect: { value: 1 },
          uC0: { value: new THREE.Vector3() },
          uC1: { value: new THREE.Vector3() },
          uC2: { value: new THREE.Vector3() },
          uC3: { value: new THREE.Vector3() },
          uStopX: { value: new THREE.Vector3(0.08, 0.52, 0.97) },
          uStopReach: { value: new THREE.Vector3(1, 1, 1) },
          uStopGain: { value: new THREE.Vector3(1, 1, 1) },
        },
        depthTest: false,
        depthWrite: false,
      }),
    [frag],
  );
  // uniforms 는 R3F prop 경로(uniforms-*-value)로 넘긴다 — 직접 mutate 하면
  // frameloop="never" 에서 R3F 가 변경을 몰라 다시 그리지 않는다(시간 정지 버그,
  // 브라우저 픽셀 해시로 실측). prop diff 가 invalidate 를 트리거한다.
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <primitive
        object={material}
        attach="material"
        uniforms-uTime-value={time}
        uniforms-uAspect-value={aspect}
        uniforms-uC0-value={colors[0]}
        uniforms-uC1-value={colors[1]}
        uniforms-uC2-value={colors[2]}
        uniforms-uC3-value={colors[3]}
        uniforms-uStopX-value={stopX ?? DEFAULT_STOP_X}
        uniforms-uStopReach-value={stopReach ?? DEFAULT_STOP_REACH}
        uniforms-uStopGain-value={stopGain ?? DEFAULT_STOP_ONE}
      />
    </mesh>
  );
};

export const ComposedShader: React.FC<{
  spec: ShaderElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
}> = ({ spec, sceneFrames, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const inCurveClone = React.useContext(CurveCloneCtx);

  const base = spec.base ?? {};
  const pos = base.position ?? { x: 0.5, y: 0.5 };
  const wPx = Math.round((clamp(base.width ?? 100, 1, 400) / 100) * width);
  const hPx = Math.round((clamp(base.height ?? 100, 1, 400) / 100) * height);

  // 클립 트림 게이트 + clock 시프트 (다른 요소들과 동일 관례).
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;

  const layers: MotionLayer[] = Array.isArray(spec.layers) ? spec.layers : [];
  const winLen = Math.max(1, winEnd - winStart);
  const timed = resolveTimings(layers, winLen, { fps, unitCount: 1 }, intrinsicForLayer, fit);
  const frame = rawFrame - winStart;
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  const css = channelsToCss(channels, inCurveClone);

  const preset = spec.preset ?? "living_gradient";
  const palette = useMemo(() => {
    const fallback = preset === "horizon_flow" ? HORIZON_PALETTE : preset === "horizon_glow" ? HORIZON_GLOW_PALETTE : DEFAULT_PALETTE;
    const src = Array.isArray(spec.palette) && spec.palette.length >= 2 ? spec.palette : fallback;
    // 4점 미만이면 마지막 색 반복으로 채움 (셰이더는 4 stop 고정)
    const four = [src[0], src[1] ?? src[0], src[2] ?? src[1] ?? src[0], src[3] ?? src[2] ?? src[1] ?? src[0]];
    return four.map(hexToVec3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spec.palette), preset]);

  // WebGL 컨텍스트 유실 자동 복구 — 에디터에서 캔버스(셰이더/3D 목업/프리뷰)가
  // 많아지면 브라우저가 가장 오래된 컨텍스트를 강제 종료해 흰 화면이 된다
  // (실측: "THREE.WebGLRenderer: Context Lost"). 유실 감지 시 key 를 올려
  // ThreeCanvas 를 재마운트 -> 새 컨텍스트로 다시 그린다.
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [glKey, setGlKey] = React.useState(0);
  const inWindow = rawFrame >= winStart && rawFrame < winEnd;
  React.useEffect(() => {
    // inWindow 가 켜질 때(요소 등장) 캔버스가 새로 생기므로 리스너 재부착
    const cv = hostRef.current?.querySelector("canvas");
    if (!cv) return;
    const onLost = (e: Event) => {
      e.preventDefault();
      setGlKey((k) => k + 1);
    };
    cv.addEventListener("webglcontextlost", onLost);
    return () => cv.removeEventListener("webglcontextlost", onLost);
  }, [glKey, inWindow]);

  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  if (layers.length > 0 && timed.every((l) => frame < l.startFrame)) return null;

  const speed = clamp(spec.speed ?? 1, 0, 8);
  const time = (frame / fps) * speed; // 초 단위 — 흐름 계수는 셰이더 안(LG_PAN/LG_EVOLVE)

  return (
    <div
      ref={hostRef}
      style={{
        position: "absolute",
        left: `${(kf.x ?? pos.x) * 100}%`,
        top: `${(kf.y ?? pos.y) * 100}%`,
        width: wPx,
        height: hPx,
        transform: `translate(-50%, -50%)${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${inCurveClone ? "" : " translate3d(0,0,0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
        willChange: inCurveClone ? undefined : "transform, opacity",
        borderRadius: base.radius ?? 0,
        overflow: "hidden",
      }}
    >
      <ThreeCanvas key={glKey} width={wPx} height={hPx} style={{ width: "100%", height: "100%" }}>
        <Quad
          time={time}
          aspect={wPx / hPx}
          colors={palette}
          frag={preset === "horizon_flow" ? HORIZON_FRAG : preset === "horizon_glow" ? HORIZON_GLOW_FRAG : FRAG}
          stopX={new THREE.Vector3(spec.stops?.[0]?.x ?? 0.08, spec.stops?.[1]?.x ?? 0.52, spec.stops?.[2]?.x ?? 0.97)}
          stopReach={new THREE.Vector3(spec.stops?.[0]?.reach ?? 1, spec.stops?.[1]?.reach ?? 1.3, spec.stops?.[2]?.reach ?? 1)}
          stopGain={new THREE.Vector3(spec.stops?.[0]?.intensity ?? 1, spec.stops?.[1]?.intensity ?? 1, spec.stops?.[2]?.intensity ?? 1)}
        />
      </ThreeCanvas>
    </div>
  );
};
