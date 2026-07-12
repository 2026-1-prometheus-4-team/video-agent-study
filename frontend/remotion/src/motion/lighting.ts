// lighting.ts — 씬 조명 + 요소 머티리얼 (AE Light 레이어 + Material Options 등가).
//
// AE 모델: Layer > New > Light(방향/강도) 가 씬에 있고, 3D 레이어마다 Material
// Options(Accepts Lights, Diffuse, Specular Intensity/Shininess)가 있어 레이어의
// 3D 자세와 빛 방향의 관계로 밝기가 계산된다. 동전이 돌 때 번쩍이는 게 이것.
//
// 우리 구현 (평행광 + 평면 요소 — AE Parallel light 등가):
//  - 법선 N: CSS 체인 rotateX(a) rotateY(b) 적용 후의 e_z
//      N = (sin b, -sin a cos b, cos a cos b)   (화면 y 아래 방향 좌표)
//  - 빛 방향 L(표면->광원): azimuth 0=오른쪽, 90=위(반시계), elevation 0=측면광,
//    90=정면광(카메라 쪽에서 쏨)
//      L = (cos az cos el, -sin az cos el, sin el)
//  - Lambert diffuse: |N.L| (양면 — 동전 뒷면도 빛 받음)
//  - Blinn-Phong specular: |N.H|^shininess, H = normalize(L + V), V = (0,0,1)
//    -> 스핀 중 글린트가 half-angle 에서 피크 (node 검증: az180/el10 에서 140deg)
//  - 최종 밝기 = ambient + intensity*diff + specular*spec, clamp [0.05, 2.2]
//    CSS filter: brightness() 로 적용 (평면 요소의 평행광 셰이딩은 균일 —
//    물리적으로 정확).
//
// 기본값 (AE 동일): 라이트가 씬에 있으면 "모든" 요소가 반응한다 — AE 의
// Material Options > Accepts Lights 기본 ON 과 동일. material.lit=false 로
// 요소별 제외 (AE 에서 Accepts Lights 끄기 등가).

import React from "react";
import { lerp, resolveEasing } from "./core/easing";

export type SceneLightSpec = {
  /** 라이트 종류 (AE Light Settings 의 Light Type):
   *  parallel(기본) = 방향광 (태양). point = 위치 기반 감쇠 (스탠드 조명). */
  type?: "parallel" | "point";
  /** point: 광원 위치 (comp fraction 0..1 + z comp-width %, AE +z 안쪽). */
  position?: { x: number; y: number; z?: number };
  /** point: 감쇠 반경 (comp-width fraction, 기본 0.6) — AE Falloff Distance. */
  falloff?: number;
  /** 빛 방위각 (deg). 0=오른쪽에서, 90=위에서, 180=왼쪽에서, 270=아래에서. */
  azimuth?: number;
  /** 빛 고도 (deg). 0=측면광(드라마틱), 90=정면광(플랫). 기본 35. */
  elevation?: number;
  /** 직사광 강도 0..1.5 (기본 0.8). */
  intensity?: number;
  /** 바닥 밝기 0..1 (기본 0.35) — 빛 안 받는 면이 완전히 검지 않게. */
  ambient?: number;
  /** 빛 색 (2D 라이트 풀/틴트용, 기본 #FFFFFF). */
  color?: string;
  /** 라이트 키프레임 — 카메라와 같은 씬-로컬 프레임, 채널별 독립 보간. */
  keyframes?: LightKeyframe[];
};

/** 라이트 키프레임 — 정의한 채널만 그 채널 보간에 기여 (요소/카메라와 동일 모델). */
export type LightKeyframe = {
  frame: number;
  /** point 위치 (comp fraction / z comp-width %). */
  x?: number;
  y?: number;
  z?: number;
  intensity?: number;
  ambient?: number;
  /** parallel 방향. */
  azimuth?: number;
  elevation?: number;
  falloff?: number;
  /** on/off 스텝 채널 (0|1) — 보간 없이 유지(hold). 한 트랙에서 A on / B off /
   *  C on 같은 다중 활성 구간을 만든다. 첫 on-키 이전은 기본 켜짐(1). */
  on?: 0 | 1;
  /** 이 키로 들어오는 구간 이징. 기본 easeInOut. */
  easing?: string;
};

/** on/off 스텝 샘플 — frame 이하의 마지막 on-키 값. on-키가 없거나 첫 키
 *  이전이면 켜짐(1). (끈 시점부터 꺼진다는 직관 유지) */
export function lightOnAt(light: SceneLightSpec, frame: number): boolean {
  const pts = (light.keyframes ?? []).filter((k) => typeof k.on === "number").sort((a, b) => a.frame - b.frame);
  if (pts.length === 0) return true;
  let v: 0 | 1 = 1;
  for (const k of pts) {
    if (k.frame > frame) break;
    v = k.on as 0 | 1;
  }
  return v === 1;
}

/** 라이트 키프레임 샘플 — base(light 필드) 위에 보간값을 덮은 "그 프레임의 라이트".
 *  키가 없으면 base 그대로 (제로 코스트). */
export function sampleLightKeyframes(light: SceneLightSpec, frame: number): SceneLightSpec {
  const kfs = light.keyframes;
  if (!kfs || kfs.length === 0) return light;
  const sorted = [...kfs].sort((a, b) => a.frame - b.frame);
  const chan = (key: Exclude<keyof LightKeyframe, "frame" | "easing">, dflt: number | undefined): number | undefined => {
    const pts = sorted.filter((k) => typeof k[key] === "number");
    if (pts.length === 0) return dflt;
    if (frame <= pts[0].frame) return pts[0][key] as number;
    const last = pts[pts.length - 1];
    if (frame >= last.frame) return last[key] as number;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (frame >= a.frame && frame <= b.frame) {
        const t = resolveEasing(b.easing, "easeInOut")((frame - a.frame) / Math.max(1, b.frame - a.frame));
        return lerp(a[key] as number, b[key] as number, t);
      }
    }
    return dflt;
  };
  const pos = light.position ?? { x: 0.35, y: 0.3, z: -25 };
  return {
    ...light,
    position: {
      x: chan("x", pos.x) ?? pos.x,
      y: chan("y", pos.y) ?? pos.y,
      z: chan("z", pos.z),
    },
    intensity: chan("intensity", light.intensity),
    ambient: chan("ambient", light.ambient),
    azimuth: chan("azimuth", light.azimuth),
    elevation: chan("elevation", light.elevation),
    falloff: chan("falloff", light.falloff),
  };
}

export type MaterialSpec = {
  /** AE Accepts Lights — 기본 ON (라이트가 켜지면 모든 요소가 반응).
   *  false 로 명시해야 제외. (구형 스펙의 lit:true 는 그대로 유효) */
  lit?: boolean;
  /** 하이라이트 강도 0..1.5 (기본 0.5). 금속/유리 반짝임. */
  specular?: number;
  /** 하이라이트 날카로움 (기본 24). 높을수록 좁고 날카로운 글린트. */
  shininess?: number;
};

/** 씬 조명 컨텍스트 — SceneRenderer 가 제공, 요소 래퍼가 소비. */
export const LightCtx = React.createContext<SceneLightSpec | null>(null);

const rad = (d: number) => (d * Math.PI) / 180;

/** 광원 기저 — 방향 L(표면->광원, CSS y-down), ambient/intensity.
 *  light 가 null 이면 기본 스튜디오 광 (az 135 / el 40 / amb 0.35 / int 0.9)
 *  — three.js 텍스트(text3d)의 기본과 동일해 요소 간 조명이 일치한다.
 *  point 는 요소 위치 기준 방향 + smooth 감쇠를 intensity 에 접는다. */
export function lightBasisFor(
  light: SceneLightSpec | null,
  elemPos?: { x: number; y: number; z?: number },
): { L: [number, number, number]; ambient: number; intensity: number } {
  const amb = light?.ambient ?? 0.35;
  let inten = light?.intensity ?? 0.9;
  if (light?.type === "point" && light.position) {
    const lp = light.position;
    const ep = elemPos ?? { x: 0.5, y: 0.5, z: 0 };
    const dx = lp.x - ep.x;
    const dy = lp.y - ep.y; // CSS y-down 그대로 (아래 = +)
    const dz = ((lp.z ?? -20) - (ep.z ?? 0)) / -100;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    const fall = Math.max(0.05, light.falloff ?? 0.6);
    const t = Math.min(1, d / fall);
    inten *= 0.5 + 0.5 * Math.cos(t * Math.PI);
    return { L: [dx / d, dy / d, dz / d], ambient: amb, intensity: inten };
  }
  const az = rad(light?.azimuth ?? 135);
  const el = rad(light?.elevation ?? 40);
  return { L: [Math.cos(az) * Math.cos(el), -Math.sin(az) * Math.cos(el), Math.sin(el)], ambient: amb, intensity: inten };
}

/** CSS rotateX(a) rotateY(b) 를 벡터에 적용 (y-down, lighting.ts 법선 관례와
 *  동일 합성 — (0,0,1) -> (sin b, -sin a cos b, cos a cos b) 재현). */
export function rotateNormal(v: [number, number, number], aDeg: number, bDeg: number): [number, number, number] {
  const a = rad(aDeg);
  const b = rad(bDeg);
  // Ry(b)
  const x1 = v[0] * Math.cos(b) + v[2] * Math.sin(b);
  const y1 = v[1];
  const z1 = -v[0] * Math.sin(b) + v[2] * Math.cos(b);
  // Rx(a) (y-down)
  const x2 = x1;
  const y2 = y1 * Math.cos(a) - z1 * Math.sin(a);
  const z2 = y1 * Math.sin(a) + z1 * Math.cos(a);
  return [x2, y2, z2];
}

/** 요소 3D 자세(+위치) + 씬 조명 -> CSS brightness 배수.
 *  pos: 요소 중심 (comp fraction) — point 라이트의 방향/감쇠 계산에 사용. */
export function shadeBrightness(
  rotXDeg: number,
  rotYDeg: number,
  light: SceneLightSpec,
  mat: MaterialSpec,
  pos?: { x: number; y: number; z?: number },
): number {
  const a = rad(rotXDeg);
  const b = rad(rotYDeg);
  const N = [Math.sin(b), -Math.sin(a) * Math.cos(b), Math.cos(a) * Math.cos(b)];
  let L: number[];
  let atten = 1;
  if (light.type === "point" && light.position) {
    // 표면 -> 광원 벡터 (comp fraction 공간; z 는 width % -> fraction 근사).
    // AE point light 처럼 위치별로 밝기가 달라져 "빛이 있다" 는 체감이 생긴다.
    const lp = light.position;
    const ep = pos ?? { x: 0.5, y: 0.5, z: 0 };
    const dx = lp.x - ep.x;
    const dy = -(lp.y - ep.y); // CSS y-down -> 조명 좌표 y-up
    const dz = ((lp.z ?? -20) - (ep.z ?? 0)) / -100; // +z 안쪽 -> 카메라쪽 양수
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
    L = [dx / d, -dy / d, dz / d];
    const fall = Math.max(0.05, light.falloff ?? 0.6);
    // smooth falloff (AE Falloff: Smooth 등가): 반경 내 1 -> 0 코사인 이징
    const t = Math.min(1, d / fall);
    atten = 0.5 + 0.5 * Math.cos(t * Math.PI);
  } else {
    const az = rad(light.azimuth ?? 90);
    const el = rad(light.elevation ?? 35);
    L = [Math.cos(az) * Math.cos(el), -Math.sin(az) * Math.cos(el), Math.sin(el)];
  }
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const diff = Math.abs(dot(N, L)); // 양면 (동전)
  // Blinn-Phong: V = (0,0,1)
  const Hraw = [L[0], L[1], L[2] + 1];
  const m = Math.sqrt(Hraw[0] * Hraw[0] + Hraw[1] * Hraw[1] + Hraw[2] * Hraw[2]) || 1;
  const H = [Hraw[0] / m, Hraw[1] / m, Hraw[2] / m];
  const spec =
    Math.pow(Math.abs(dot(N, H)), Math.max(1, mat.shininess ?? 24)) * (mat.specular ?? 0.5);
  const v = (light.ambient ?? 0.35) + (light.intensity ?? 0.8) * diff * atten + spec * atten;
  return Math.max(0.05, Math.min(2.2, v));
}
