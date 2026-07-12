// ComposedDevice — 실제 3D 디바이스 목업 (glTF) 요소. A3 의 3D 확장.
//
// 딥 리서치 근거 (docs/motion_math.md device 절, 리서치 wf_e8f20271):
//  - 모델: public/models/ 에 vendoring (mac-draco.glb MIT / iphone15.glb CC-BY 4.0
//    — 라이선스 전문은 옆 *.license.txt. CC-BY attribution 필수).
//  - 로딩: drei useGLTF + 로컬 Draco 디코더(public/draco — gstatic CDN 의존 0).
//    ThreeCanvas 가 Suspense 내장이라 수동 delayRender 불필요 (공식 gltf 예제 패턴).
//  - 스크린: 스크린 "머티리얼 이름"으로 메시를 찾아 meshBasicMaterial(map) 교체
//    (노드명은 mangled 될 수 있어 머티리얼명이 안정적).
//    texture.flipY = false (glTF UV 규약) + SRGBColorSpace (r152+ 물빠짐 방지).
//  - 조명: 씬 light(azimuth/elevation) -> three 방향광. 좌표 매핑(우리: az 0=오른쪽
//    90=위, el 90=정면):  pos = (cos az cos el, sin az cos el, sin el) * r
//    (three 는 y-up 이라 lighting.ts 의 y-down 부호만 뒤집힘 — 같은 빛).
//    금속 반사: three 내장 RoomEnvironment(완전 procedural, 네트워크 0) PMREM.
//  - 회전: rotateX/rotateY 키프레임 채널 값을 <group rotation> props 로 선언 전달
//    (C4 uniforms-via-props 와 동일 — useFrame 누적 금지). 채널 loop 도 그대로 동작.
//  - 렌더: chromiumOptions gl:"angle" (remotion.config 기존 설정), frameloop never.

import React from "react";
import { useCurrentFrame, useVideoConfig, staticFile, delayRender, continueRender, getRemotionEnvironment, Video as RemotionVideo } from "remotion";
import { ThreeCanvas, useVideoTexture, useOffthreadVideoTexture } from "@remotion/three";
import { useGLTF, useTexture } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { sampleElementKeyframes } from "./keyframes";
import type { ElementKeyframe } from "./keyframes";
import { type MotionLayer, type SceneFit, resolveTimings } from "./core/timing";
import { composeChannels, channelsToCss } from "./wrappers";
import { LightCtx, type SceneLightSpec } from "./lighting";
import { PhoneScreenChrome } from "./chrome";
// type-only — SceneRenderer 와의 순환은 타입이라 런타임에 지워진다
import type { SceneElementSpec } from "./SceneRenderer";

export type DeviceElementSpec = {
  element: "device";
  id?: string;
  /** 디바이스 종류 — deviceRegistry 참조. */
  device: "macbook" | "iphone15";
  /** (레거시) 스크린 콘텐츠 — 이미지/비디오 텍스처 교체 경로. 새 문서는
   *  children(스크린 앵커 frame)의 fill 을 쓴다 — 이 필드는 하위호환 유지. */
  screen?: { src: string };
  /** 스크린 앵커 자식 — 3D 스크린 면에 호모그래피로 접착되는 요소들
   *  (보통 frame 하나). 좌표계 = 스크린 논리 px (iPhone 393x852). */
  children?: SceneElementSpec[];
  /** 스크린 상태바 (기본 true, iPhone 전용) — 아일랜드 + 시간/셀룰러/배터리. */
  statusBar?: boolean;
  /** 상태바 시간 (기본 "9:41"). */
  time?: string;
  /** 맥북 뚜껑 각도 (deg). 0=수직, 음수=뒤로 젖힘. 기본 -15. */
  lidAngle?: number;
  base?: {
    position?: { x: number; y: number };
    width?: number; // 캔버스 %
    height?: number; // 캔버스 %
    opacity?: number;
    /** 2D 회전 (deg) — 다른 요소의 base.rotate 와 동일. */
    rotate?: number;
    /** 정적 3D 자세 (deg) — 3D 모델 회전으로 들어감. */
    rotateX?: number;
    rotateY?: number;
  };
  layers?: MotionLayer[];
  keyframes?: ElementKeyframe[];
  timing?: { start?: number; end?: number };
};

// 디바이스 레지스트리 — 모델별 스크린 머티리얼/힌지/자세 (리서치로 확정된 값)
const DEVICES = {
  macbook: {
    // 2021 MacBook Pro 14 (M1) — akshatmittal CC-BY 4.0 (mbp14.license.txt).
    // 노치/얇은 베젤/터치바 없음 — 리서치로 확정한 커뮤니티 표준 모던 모델.
    glb: "models/mbp14.glb",
    screenMaterial: "UpOvKwLUUXPmnPU",
    hingeNode: null as string | null,
    // 모델 원본 크기 -> 뷰 맞춤 스케일/오프셋 (시각 튜닝값)
    fitScale: 9,
    yOffset: -0.85,
    camera: { z: 6.2, y: 0.9, fov: 26 },
    /** 스크린 영역 종횡비 (w/h) — 14인치 3024x1964 근사. */
    screenAspect: 1.54,
    /** 스크린 논리 해상도 (pt) — 앵커 frame 좌표계. MBP14 1512x982. */
    screenPx: { w: 1512, h: 982 },
    /** 디스플레이 코너 반경 (스크린 pt) — MBP14 상단만 라운드. */
    screenRadius: "12px 12px 0 0",
    /** 스크린 법선의 루트 공간 z 부호 — 이 모델은 rotY 0 에서 스크린이 카메라를
     *  향한다 (device-demo 실측: rotY +-26 스윕에서 화면 보임). */
    screenFront: 1,
    // 이 모델 스크린 UV 는 상하만 반전 (실측 진실표: 무보정=상하반전,
    // U플립=180도, 따라서 V 단독 플립이 정답)
    screenFlipU: false,
    screenFlipV: true,
  },
  iphone15: {
    glb: "models/iphone15.glb",
    screenMaterial: "pIJKfZsazmcpEiU",
    hingeNode: null as string | null,
    fitScale: 14,
    yOffset: 0,
    camera: { z: 5.2, y: 0.5, fov: 26 },
    // 19.5:9 세로 패널
    screenAspect: 9 / 19.5,
    /** 스크린 논리 해상도 (pt) — iPhone 15 Pro 393x852. */
    screenPx: { w: 393, h: 852 },
    /** 디스플레이 코너 반경 (스크린 pt) — 실기기 55pt. */
    screenRadius: "55px",
    /** 이 모델은 rotY 0 에서 등판이 카메라를 향한다 — 스크린 법선 = -z
     *  (device-demo 실측: rotY 189 부근에서 화면 보임). */
    screenFront: -1,
    // 이 모델 스크린 UV 도 상하만 반전 — 사용자 실캡처(잠금화면 텍스트)로
    // 좌우 거울 확인, flipU 제거 (이전 그라데이션 판독이 좌우를 놓쳤음)
    screenFlipU: false,
    screenFlipV: true,
  },
} as const;

/** 디바이스 스크린 논리 해상도 (pt) — 에디터/SceneRenderer 가 앵커 frame 의
 *  FrameBoxCtx pxW/pxH 로 쓴다. */
export function deviceScreenPx(kind: "macbook" | "iphone15"): { w: number; h: number } {
  return (DEVICES[kind] ?? DEVICES.iphone15).screenPx;
}

// 우리 조명 규약 -> three 방향광 위치 (az 0=오른쪽, 90=위 / el 90=정면)
function lightPos(light: SceneLightSpec): [number, number, number] {
  const az = ((light.azimuth ?? 90) * Math.PI) / 180;
  const el = ((light.elevation ?? 35) * Math.PI) / 180;
  const r = 6;
  return [Math.cos(az) * Math.cos(el) * r, Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r];
}

// ---- 스크린 앵커 수학 (호모그래피 오버레이) ----------------------------------
// 원리: AE 의 corner-pin 스크린 교체와 동일 — 스크린 메시 4 코너를 모델에서
// 한 번 추출하고, 매 프레임 rig 회전 + 카메라 투영을 "순수 수학"으로 복제해
// 요소 px 좌표를 얻은 뒤, DLT 호모그래피로 DOM 오버레이(matrix3d)를 접착한다.
// (검증: scratchpad/homography-check.mjs — 재투영 오차 1.6e-13px)

type Vec3 = [number, number, number];

/** 스크린 메시(머티리얼명 매칭)의 표시면 4 코너를 모델 루트 공간에서 추출.
 *  순서: TL, TR, BR, BL — 스크린 "콘텐츠" 기준.
 *
 *  방식: 버텍스를 루트 공간으로 옮겨 평면 기저(right/up)에 투영한 바운딩
 *  사각형. bbox face 방식은 틸트가 버텍스에 베이크된 모델(맥북 뚜껑 틸트 실측)에서
 *  수직 평면을 만들어 오프셋이 생긴다 — 실제 지오메트리 기반이 정답.
 *  - 법선: 최장 반경 버텍스와의 외적 최대화 (평면 메시에 결정론적, 와인딩 무관)
 *  - 부호: 레지스트리 screenFront(z 부호)로 정렬 (iPhone 모델은 -z 가 표시면)
 *  - right = worldUp x n 이라 스크린이 -z 를 봐도 콘텐츠 좌우가 안 뒤집힌다 */
function extractScreenQuad(root: THREE.Object3D, matName: string, screenFront: number): Vec3[] | null {
  let found: THREE.Mesh | null = null;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!found && m.isMesh) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (mats.some((mm) => mm && (mm as THREE.Material).name === matName)) found = m;
    }
  });
  if (!found) return null;
  const mesh: THREE.Mesh = found;
  const posAttr = mesh.geometry.getAttribute("position");
  if (!posAttr || posAttr.count < 3) return null;
  // 메시 -> 루트 상대 변환 (루트 자체 변환 제외 — rig 의 primitive 가 덮어쓴다)
  const rel = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
  // 극단 코너 버텍스가 스킵되면 쿼드가 줄어든다 — 보통 크기 메시는 전수 조사
  const stride = posAttr.count > 20000 ? Math.floor(posAttr.count / 8000) : 1;
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i < posAttr.count; i += stride) {
    verts.push(new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(rel));
  }
  const c = verts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / verts.length);
  // 평면 법선: 중심에서 가장 먼 버텍스(a)와, a 와의 외적이 최대인 버텍스로
  const a = verts
    .reduce((bp, p) => (p.distanceToSquared(c) > bp.distanceToSquared(c) ? p : bp), verts[0])
    .clone()
    .sub(c);
  const n = new THREE.Vector3();
  let bestCross = 0;
  const tmp = new THREE.Vector3();
  for (const p of verts) {
    tmp.copy(p).sub(c).cross(a);
    const m2 = tmp.lengthSq();
    if (m2 > bestCross) {
      bestCross = m2;
      n.copy(tmp);
    }
  }
  if (bestCross < 1e-12) return null;
  n.normalize();
  if (Math.sign(n.z) !== Math.sign(screenFront)) n.negate();
  // 콘텐츠 기저: right = worldUp x n, up = n x right (직립 디바이스 가정)
  const right = new THREE.Vector3(0, 1, 0).cross(n);
  if (right.lengthSq() < 1e-6) return null; // 수평 스크린 — 미지원
  right.normalize();
  const up = n.clone().cross(right).normalize();
  let uMin = Infinity, uMax = -Infinity, wMin = Infinity, wMax = -Infinity;
  const d = new THREE.Vector3();
  for (const p of verts) {
    d.copy(p).sub(c);
    const u = d.dot(right);
    const w = d.dot(up);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (w < wMin) wMin = w;
    if (w > wMax) wMax = w;
  }
  const corner = (u: number, w: number) => c.clone().addScaledVector(right, u).addScaledVector(up, w);
  return [corner(uMin, wMax), corner(uMax, wMax), corner(uMax, wMin), corner(uMin, wMin)].map(
    (v) => [v.x, v.y, v.z] as Vec3,
  );
}

/** rig 회전 + 카메라 투영 복제 — 루트 공간 코너 -> 요소 박스 px.
 *  ThreeCanvas 와 동일 체인: primitive(scale fitScale, y+=yOffset) ->
 *  group rotation [rx, ry, 0] -> PerspectiveCamera(bleedFov, lookAt(0,-0.05,0)). */
function projectScreenQuad(
  quad: Vec3[],
  dev: (typeof DEVICES)[keyof typeof DEVICES],
  rotX: number,
  rotY: number,
  wPx: number,
  hPx: number,
  bleedFov: number,
): { pts: { x: number; y: number }[]; front: boolean } {
  const k = 1 + 2 * BLEED;
  const cam = new THREE.PerspectiveCamera(bleedFov, wPx / hPx, 0.1, 1000);
  cam.position.set(0, dev.camera.y, dev.camera.z);
  cam.lookAt(0, -0.05, 0);
  cam.updateMatrixWorld(true);
  const eul = new THREE.Euler((rotX * Math.PI) / 180, (rotY * Math.PI) / 180, 0, "XYZ");
  const pts = quad.map(([x, y, z]) => {
    const v = new THREE.Vector3(x, y, z).multiplyScalar(dev.fitScale);
    v.y += dev.yOffset;
    v.applyEuler(eul);
    v.project(cam);
    // NDC -> bleed 캔버스 px -> 요소 박스 px (캔버스가 -BLEED 만큼 밖에서 시작)
    return {
      x: (v.x / 2 + 0.5) * (wPx * k) - BLEED * wPx,
      y: (1 - (v.y / 2 + 0.5)) * (hPx * k) - BLEED * hPx,
    };
  });
  // shoelace (y-down): TL->TR->BR->BL 이 시계방향(양수)이면 앞면, 음수면 뒷면
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    area += p.x * q.y - q.x * p.y;
  }
  return { pts, front: area > 0 };
}

/** DLT 호모그래피 — (0,0)(sw,0)(sw,sh)(0,sh) -> 투영 코너 4점. 8x8 가우스
 *  소거(부분 피벗). 반환: CSS matrix3d (transform-origin 0 0 전제). */
function homographyCss(sw: number, sh: number, p: { x: number; y: number }[]): string | null {
  const src = [
    [0, 0],
    [sw, 0],
    [sw, sh],
    [0, sh],
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const { x: X, y: Y } = p[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j < 8; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  // H = [[h0 h1 h2],[h3 h4 h5],[h6 h7 1]] -> column-major matrix3d (z 항 무변형)
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}

// 3D 는 요소 박스 밖으로 삐져나올 수 있다(회전한 노트북 모서리 등) — 캔버스를
// 박스보다 BLEED 만큼 크게 렌더하고 fov 를 보정해 모델 크기는 유지, 잘림만 제거.
// fov' = 2 atan(k tan(fov/2)), k = 1 + 2*BLEED (수학: 화면 px 크기 불변 조건).
const BLEED = 0.35;

// 제품샷 카메라 — 살짝 위에서 내려다보며 원점 응시 (정면 y=0 카메라는 기물이
// 뒤로 넘어가 보이는 어색함). 렌즈는 fov 26 상당(왜곡 완화).
function ProductCamera({ y }: { y: number }) {
  const { camera } = useThree();
  React.useLayoutEffect(() => {
    camera.lookAt(0, -0.05, 0);
    camera.updateProjectionMatrix();
  }, [camera, y]);
  return null;
}

// RoomEnvironment PMREM — 외부 파일 0. 씬당 1회 생성/정리.
// delayRender 로 환경맵 적용 "전" 프레임이 캡처되는 걸 차단 — 없으면 env 적용
// 시점이 탭/타이밍마다 달라 결정론 게이트가 깨진다 (실측: f13+ 해시 발산).
function StudioEnvironment({ intensity }: { intensity: number }) {
  const { gl, scene } = useThree();
  const [handle] = React.useState(() => delayRender("device RoomEnvironment PMREM"));
  const done = React.useRef(false);
  React.useLayoutEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = intensity;
    if (!done.current) {
      done.current = true;
      continueRender(handle);
    }
    return () => {
      scene.environment = null;
      env.texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene, intensity, handle]);
  return null;
}

// 공통: 모델 복제(머티리얼 교체가 로더 캐시를 오염시키지 않게) + 스크린 주입 + 힌지
function usePreparedModel(
  kind: keyof typeof DEVICES,
  screenTex: THREE.Texture | null,
  lidAngle: number,
) {
  const dev = DEVICES[kind];
  // Draco 디코더 로컬 경로 — gstatic CDN 의존 제거 (오프라인/결정론)
  const gltf = useGLTF(staticFile(dev.glb), staticFile("draco/"));
  return React.useMemo(() => {
    const root = gltf.scene.clone(true);
    if (screenTex) {
      screenTex.flipY = false; // glTF UV 규약
      screenTex.colorSpace = THREE.SRGBColorSpace;
      // 모델별 UV 축 플립 + cover-fit 중앙 크롭 (CSS object-fit: cover 등가).
      // 크롭 창 [o, o+r] 을 뒤집으려면 offset = o + r, repeat = -r (u' = o + u*r).
      const img = screenTex.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
      const iw = img?.videoWidth || img?.width;
      const ih = img?.videoHeight || img?.height;
      let rx = 1, ry = 1, ox = 0, oy = 0;
      if (iw && ih) {
        const ia = iw / ih;
        const sa = dev.screenAspect;
        if (ia > sa) {
          rx = sa / ia;
          ox = (1 - rx) / 2;
        } else {
          ry = ia / sa;
          oy = (1 - ry) / 2;
        }
      }
      if (dev.screenFlipU) { ox = ox + rx; rx = -rx; }
      if (dev.screenFlipV) { oy = oy + ry; ry = -ry; }
      screenTex.repeat.set(rx, ry);
      screenTex.offset.set(ox, oy);
      screenTex.wrapS = THREE.ClampToEdgeWrapping;
      screenTex.wrapT = THREE.ClampToEdgeWrapping;
      screenTex.needsUpdate = true;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          mats.forEach((m, i) => {
            if (m && (m as THREE.Material).name === dev.screenMaterial) {
              const basic = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
              if (Array.isArray(mesh.material)) (mesh.material as THREE.Material[])[i] = basic;
              else mesh.material = basic;
            }
          });
        }
      });
    }
    if (dev.hingeNode) {
      const hinge = root.getObjectByName(dev.hingeNode);
      if (hinge) hinge.rotation.x = (lidAngle * Math.PI) / 180;
    }
    return root;
  }, [gltf.scene, screenTex, lidAngle, dev.screenMaterial, dev.hingeNode]);
}

function ModelRig(props: {
  kind: keyof typeof DEVICES;
  root: THREE.Object3D;
  rotX: number;
  rotY: number;
  onScreenQuad?: (q: Vec3[]) => void;
}) {
  const dev = DEVICES[props.kind];
  const { root, onScreenQuad } = props;
  // 스크린 4 코너 추출 (모델 로드당 1회) — DOM 오버레이(스크린 앵커)로 리포트
  React.useLayoutEffect(() => {
    if (!onScreenQuad) return;
    const q = extractScreenQuad(root, dev.screenMaterial, dev.screenFront);
    if (q) onScreenQuad(q);
  }, [root, dev.screenMaterial, dev.screenFront, onScreenQuad]);
  return (
    <group rotation={[(props.rotX * Math.PI) / 180, (props.rotY * Math.PI) / 180, 0]}>
      <primitive object={props.root} scale={dev.fitScale} position={[0, dev.yOffset, 0]} />
    </group>
  );
}

// 스크린 있는 버전 — useTexture 훅 사용 (조건부 훅 회피 위해 컴포넌트 분리)
function DeviceWithScreen(props: { kind: keyof typeof DEVICES; src: string; lidAngle: number; rotX: number; rotY: number; onScreenQuad?: (q: Vec3[]) => void }) {
  const url = /^(https?:)?\//.test(props.src) ? props.src : staticFile(props.src);
  const tex = useTexture(url);
  const root = usePreparedModel(props.kind, tex, props.lidAngle);
  return <ModelRig kind={props.kind} root={root} rotX={props.rotX} rotY={props.rotY} onScreenQuad={props.onScreenQuad} />;
}

function DeviceBare(props: { kind: keyof typeof DEVICES; lidAngle: number; rotX: number; rotY: number; onScreenQuad?: (q: Vec3[]) => void }) {
  const root = usePreparedModel(props.kind, null, props.lidAngle);
  return <ModelRig kind={props.kind} root={root} rotX={props.rotX} rotY={props.rotY} onScreenQuad={props.onScreenQuad} />;
}

// 비디오: 텍스처가 캔버스 밖(프리뷰 <Video>/렌더 offthread)에서 만들어져 prop 으로 들어온다
function DeviceWithTex(props: { kind: keyof typeof DEVICES; tex: THREE.Texture | null; lidAngle: number; rotX: number; rotY: number; onScreenQuad?: (q: Vec3[]) => void }) {
  const root = usePreparedModel(props.kind, props.tex, props.lidAngle);
  return <ModelRig kind={props.kind} root={root} rotX={props.rotX} rotY={props.rotY} onScreenQuad={props.onScreenQuad} />;
}

export function ComposedDevice(props: {
  spec: DeviceElementSpec;
  sceneFrames: number;
  fit?: SceneFit;
  /** 스크린 앵커 자식 — SceneRenderer 가 디스패치해 넘긴다 (spec.children 렌더). */
  screenChildren?: React.ReactNode;
}): React.ReactElement | null {
  const { spec, sceneFrames, fit, screenChildren } = props;
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const light = React.useContext(LightCtx);
  const base = spec.base ?? {};
  const pos = base.position ?? { x: 0.5, y: 0.5 };

  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  // 스크린 비디오 — 프리뷰: <Video> 엘리먼트 텍스처 / 렌더: OffthreadVideo 프레임
  // 추출(프레임 단위 결정론). isRendering/spec 은 세션 내 상수라 분기 훅이 안전.
  // 훅은 전부 최상단 — 타이밍 윈도우 조기 return 이 프레임에 따라 뒤집혀도
  // 훅 순서가 불변이어야 한다 (Rules of Hooks).
  const screenSrc = spec.screen?.src;
  const isVideoScreen = !!screenSrc && /\.(mp4|webm|mov)(\?|$)/i.test(screenSrc);
  const videoUrl = isVideoScreen && screenSrc ? (/^(https?:)?\//.test(screenSrc) ? screenSrc : staticFile(screenSrc)) : null;
  const { isRendering } = getRemotionEnvironment();
  const videoElRef = React.useRef<HTMLVideoElement>(null);
  const previewTex = useVideoTexture(videoElRef);
  let renderTex: THREE.Texture | null = null;
  if (isRendering && isVideoScreen && videoUrl) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- isRendering 은 상수
    renderTex = useOffthreadVideoTexture({ src: videoUrl });
  }
  const videoTex = isVideoScreen ? (isRendering ? renderTex : previewTex) : null;
  // 스크린 앵커 — 모델 루트 공간 4 코너 (Canvas 안에서 1회 추출해 리포트)
  const [screenQuad, setScreenQuad] = React.useState<Vec3[] | null>(null);
  const onScreenQuad = React.useCallback((q: Vec3[]) => setScreenQuad(q), []);
  // WebGL 컨텍스트 유실 자동 복구 (ComposedShader 와 동일 관례) — 캔버스가
  // 많아져 브라우저가 오래된 컨텍스트를 죽이면 재마운트로 되살린다.
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [glKey, setGlKey] = React.useState(0);
  const inWindow = rawFrame >= winStart && rawFrame < winEnd;
  React.useEffect(() => {
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

  const timed = resolveTimings(spec.layers ?? [], winLen, { fps, unitCount: 1 }, () => 0, fit);
  const channels = composeChannels(timed, frame, { width, height, fps });
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  // 다른 요소와 동일한 공통 채널 계층: x/y/scale/rotate/opacity 키프레임 +
  // wrapper 레이어 채널(css) 전부 적용. 단 rotateX/rotateY 채널만은 CSS 가 아닌
  // "진짜 3D 모델 회전"으로 들어간다 (디바이스 요소의 고유 해석).
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  const css = channelsToCss(channels);

  const wPx = ((base.width ?? 56) / 100) * width;
  const hPx = ((base.height ?? 64) / 100) * height;
  const rotX = kf.rotateX ?? base.rotateX ?? 0;
  const rotY = kf.rotateY ?? base.rotateY ?? 0;
  const dev = DEVICES[spec.device] ?? DEVICES.macbook;
  const L: SceneLightSpec = light ?? { azimuth: 120, elevation: 40, intensity: 0.9, ambient: 0.5 };

  // bleed 보정 fov — 모델 px 크기 유지한 채 캔버스만 확장
  const k = 1 + 2 * BLEED;
  const fovRad = (dev.camera.fov * Math.PI) / 180;
  const bleedFov = (2 * Math.atan(k * Math.tan(fovRad / 2)) * 180) / Math.PI;

  // 스크린 앵커 오버레이 — 코너 투영 + 호모그래피 (앞면일 때만 표시).
  // 상태바: iPhone 전용, 스크린 자식이 있으면 디폴트 on (statusBar:true 로
  // 단독 강제 가능 / false 로 off). 자식 없는 레거시 문서는 출력 불변.
  const statusOn = spec.device === "iphone15" && (spec.statusBar === true || (spec.statusBar !== false && !!screenChildren));
  const wantOverlay = !!screenChildren || statusOn;
  const SW = dev.screenPx.w;
  const SH = dev.screenPx.h;
  let anchor: { css: string; front: boolean } | null = null;
  if (wantOverlay && screenQuad) {
    const proj = projectScreenQuad(screenQuad, dev, rotX, rotY, wPx, hPx, bleedFov);
    const m = homographyCss(SW, SH, proj.pts);
    if (m) anchor = { css: m, front: proj.front };
  }

  return (
    <div
      // data-framebox — 에디터 측정: 요소 박스는 이 div (bleed 캔버스가 아니라).
      data-framebox
      style={{
        position: "absolute",
        left: `${(kf.x ?? pos.x) * 100}%`,
        top: `${(kf.y ?? pos.y) * 100}%`,
        width: wPx,
        height: hPx,
        transform: `translate(-50%, -50%)${base.rotate ? ` rotate(${base.rotate}deg)` : ""} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        opacity: (base.opacity ?? 1) * css.opacity,
        filter: css.filter,
      }}
    >
      {/* 바닥 그림자 — 제품샷 접지감 (CSS 타원, 결정론 안전) */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: "2%",
          width: "62%",
          height: "7%",
          transform: "translateX(-50%)",
          background: "radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 68%)",
          pointerEvents: "none",
        }}
      />
      <div
        ref={hostRef}
        data-nobounds="true"
        style={{
          position: "absolute",
          left: `${-BLEED * 100}%`,
          top: `${-BLEED * 100}%`,
          width: `${k * 100}%`,
          height: `${k * 100}%`,
        }}
      >
      <ThreeCanvas key={glKey} width={Math.round(wPx * k)} height={Math.round(hPx * k)} style={{ width: "100%", height: "100%" }} camera={{ position: [0, dev.camera.y, dev.camera.z], fov: bleedFov }}>
        <ProductCamera y={dev.camera.y} />
        <StudioEnvironment intensity={0.5 + (L.ambient ?? 0.35)} />
        <ambientLight intensity={(L.ambient ?? 0.35) * 2.2} />
        <directionalLight position={lightPos(L)} intensity={(L.intensity ?? 0.8) * 3.2} />
        <React.Suspense fallback={null}>
          {isVideoScreen ? (
            <DeviceWithTex kind={spec.device} tex={videoTex} lidAngle={spec.lidAngle ?? -15} rotX={rotX} rotY={rotY} onScreenQuad={onScreenQuad} />
          ) : spec.screen?.src ? (
            <DeviceWithScreen kind={spec.device} src={spec.screen.src} lidAngle={spec.lidAngle ?? -15} rotX={rotX} rotY={rotY} onScreenQuad={onScreenQuad} />
          ) : (
            <DeviceBare kind={spec.device} lidAngle={spec.lidAngle ?? -15} rotX={rotX} rotY={rotY} onScreenQuad={onScreenQuad} />
          )}
        </React.Suspense>
      </ThreeCanvas>
      </div>
      {/* 스크린 앵커 오버레이 — 스크린 논리 px(SW x SH) 평면을 호모그래피로
          3D 스크린 면에 접착. 자식(frame)의 fill/레이아웃이 그대로 화면 콘텐츠가
          되고, 상태바는 콘텐츠 위 디폴트 크롬. 뒷면(front=false)은 숨김. */}
      {anchor && anchor.front && (
        <div
          data-nobounds="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: SW,
            height: SH,
            transform: anchor.css,
            transformOrigin: "0 0",
            borderRadius: dev.screenRadius,
            overflow: "hidden",
          }}
        >
          {screenChildren}
          {statusOn && <PhoneScreenChrome screenW={SW} dark statusBar time={spec.time} />}
        </div>
      )}
      {isVideoScreen && videoUrl && !isRendering && (
        <RemotionVideo
          ref={videoElRef}
          src={videoUrl}
          muted
          style={{ position: "absolute", width: 2, height: 2, opacity: 0, pointerEvents: "none" }}
        />
      )}
    </div>
  );
}
