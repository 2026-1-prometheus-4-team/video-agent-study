// pathLayout.tsx — B2: 그룹 자식들을 SVG 경로 위에 배치/이동 (AE Path Carousel, v05).
//
// 수학 (docs/motion_math.md B2 절, node 검증):
//  - 경로 샘플링: SVGPathElement.getTotalLength()/getPointAtLength(s) — 브라우저
//    네이티브(헤드리스 Chrome 포함), 같은 d 에 같은 값 = 결정론.
//  - 분포: 자식 i 의 호 길이 위치 s_i = L * frac(i/N + progress). loop 면 mod 로
//    순환(캐러셀), 아니면 clamp.
//  - 접선(orient tangent): atan2(p(s+eps) - p(s-eps)) — 화면 픽셀 공간에서
//    (경로 좌표는 0..100 이라 x 는 width/100, y 는 height/100 로 스케일 후 각도).
//  - 대관람차(orient upright): 자식 회전을 걸지 않는다 = 궤도는 돌되 곤돌라는
//    수평 유지(캐러셀 카운터 회전과 등가 — 회전을 아예 부모에 두지 않는 구현).
//    swing 은 감쇠 진자 alpha(t) = A * e^(-zeta*w*t) * cos(wd*t + phase_i),
//    wd = w*sqrt(1-zeta^2) — 씬 시작에서 놓인 진자가 서서히 안정.
//
// cemented (출처 표기):
//  - progress 기본 48f + easeInOut: v05 실측 "Path Progress 키프레임 2초 + F9
//    Easy Ease" (ae_transcripts 정제 레시피).
//  - swing A=5deg, f=0.6Hz, zeta=0.12: 물리 표준 감쇠 진자 관례값(관찰 기반,
//    실측 아님을 명시 — 레퍼런스 정밀 재측정 시 갱신).


// B1 orbit — v04 Revolving 재현. 자식들을 3D 수평 궤도(캐러셀)에 배치:
// theta_i = 2pi(i/N + progress), 월드 (x,z) = R(sin, cos), 원근 s = P/(P-z).
// 뒤쪽 카드는 작아지고(zIndex 정렬로 앞 카드 뒤로 지나감), 카드는 항상 카메라를
// 본다(billboard — v04 의 원판들과 동일). 등속 무한 회전 = loop blob
// (AE loopOut(continue) 등가, v04 실측), 안무 회전 = progress 키프레임 채널.
export type OrbitLayoutSpec = {
  type: "orbit";
  /** 궤도 중심 오프셋 (0..100 캔버스 %) — 드래그 이동용. */
  origin?: { x: number; y: number };
  /** 궤도 반지름 (캔버스 폭 %, 기본 28). P=1100 미만 유지 위해 최대 45. */
  radius?: number;
  /** 궤도 기울기 (0..40, 반지름 대비 세로 타원 %). 0 = 정측면 캐러셀. 기본 0. */
  tilt?: number;
  /** 등속 무한 회전(한 바퀴 프레임). 키프레임 progress 가 있으면 그쪽 우선. */
  progress?: { loop: true; durationF?: number };
};

export type GroupLayoutSpec = PathLayoutSpec | OrbitLayoutSpec;

export type PathLayoutSpec = {
  type: "path";
  /** 경로 전체 오프셋 (0..100 캔버스 %) — 캔버스에서 요소/그룹 드래그 = 이 값.
   *  AE 에서 레이어를 드래그하면 모션 패스가 통째로 따라가는 것과 등가. */
  origin?: { x: number; y: number };
  /** 피그마식 점+핸들 경로 — 캔버스에서 직접 편집. d/preset 보다 우선. */
  points?: PathPoint[];
  /** points 경로를 닫을지 (원형 순환). */
  closed?: boolean;
  /** SVG path d — 좌표계 0..100 (x=캔버스 폭 %, y=높이 %). preset 대신 직접 지정. */
  d?: string;
  /** 프리셋 경로. circle=원(대관람차/회전 캐러셀), arc=완만한 호, wave=물결. */
  preset?: "circle" | "arc" | "wave";
  /** circle 반지름(캔버스 높이 %, 기본 30). */
  radius?: number;
  /** true(기본)면 자식 등간격 분포, false 면 전부 같은 progress 지점. */
  distribute?: boolean;
  /** 등속 무한 순환(AE loopOut 등가) — 대관람차/캐러셀. 안무된 이동(가감속)은
   *  이 blob 이 아니라 group keyframes 의 progress 채널로 찍는다(키 간격 = 속도,
   *  세그먼트 이징 = 가감속 — 다른 채널과 완전히 같은 체계). */
  progress?: {
    loop: true;
    durationF?: number; // 한 바퀴 프레임 수. 기본 240 (10s@24)
  };
  /** 자식 방향. upright(기본)=수평 유지(대관람차), tangent=경로 접선 회전. */
  orient?: "upright" | "tangent";
  /** 감쇠 진자 흔들림(대관람차 곤돌라). 기본 false. */
  swing?: boolean;
};

// 감쇠 진자 (관찰 기반 — 물리 표준 파라미터)
const SWING_A_DEG = 5;
const SWING_FREQ_HZ = 0.6;
const SWING_ZETA = 0.12;

// 프리셋 경로 (0..100 좌표) — circle 은 radius 로 동적 생성.
function presetD(preset: "circle" | "arc" | "wave", radiusPct: number): string {
  if (preset === "circle") {
    // 중심 (50,50), 반지름 r(높이 % — x 도 같은 % 라 화면상 타원이 되지만,
    // 16:9 에서 시각적으로 넓은 궤도가 대관람차/캐러셀 레퍼런스와 일치).
    const r = radiusPct;
    return `M 50 ${50 - r} A ${r} ${r} 0 1 1 50 ${50 + r} A ${r} ${r} 0 1 1 50 ${50 - r} Z`;
  }
  if (preset === "arc") {
    return "M 8 62 Q 50 30 92 62";
  }
  // wave — 완만한 두 굽이 물결
  return "M 5 55 C 25 35, 40 75, 58 55 S 88 35, 95 55";
}

// d -> SVGPathElement 캐시 (브라우저 전용, 같은 d 는 재사용).
const pathCache = new Map<string, SVGPathElement>();
function pathFor(d: string): SVGPathElement | null {
  if (typeof document === "undefined") return null;
  const hit = pathCache.get(d);
  if (hit) return hit;
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.setAttribute("d", d);
  if (pathCache.size > 100) pathCache.clear();
  pathCache.set(d, el);
  return el;
}

export type PathPose = {
  /** 경로 위 위치 (캔버스 fraction 0..1) */
  x: number;
  y: number;
  /** 자식 회전(deg) — orient/swing 반영 */
  rotate: number;
  /** 원근 스케일 (2D 씬 orbit 전용, 기본 1) */
  scale?: number;
  /** 깊이 정렬 (2D 씬 orbit 전용 — 앞 카드가 위) */
  zIndex?: number;
  /** 진짜 깊이 px (3D 씬 orbit — translateZ 로 방출, 원근/정렬은 브라우저) */
  zPx?: number;
};

/** 프레임 -> 자식 i 의 경로 포즈. 브라우저 밖(SSR)에서는 null. */
export function samplePathLayout(
  layout: PathLayoutSpec,
  frame: number,
  fps: number,
  childIdx: number,
  childCount: number,
  widthPx: number,
  heightPx: number,
  /** group keyframes 의 progress 채널 값 — 있으면 loop blob 대신 이 값 사용. */
  progressOverride?: number | null,
): PathPose | null {
  const d =
    layout.points && layout.points.length >= 2
      ? pointsToD(layout.points, layout.closed)
      : layout.d ?? presetD(layout.preset ?? "wave", layout.radius ?? 30);
  const path = pathFor(d);
  if (!path) return null;
  const L = path.getTotalLength();
  if (!(L > 0)) return null;

  // progress(0..1): 키프레임 채널이 최우선(안무된 이동), 없으면 loop blob(등속 순환).
  let prog = 0;
  const pr = layout.progress;
  if (progressOverride != null && Number.isFinite(progressOverride)) {
    prog = progressOverride;
  } else if (pr?.loop) {
    // 등속 순환 (AE loopOut cycle 등가) — 한 사이클 = durationF.
    const dur = Math.max(1, pr.durationF ?? 240);
    prog = (frame / dur) % 1;
  }

  const distribute = layout.distribute !== false;
  const fracRaw = distribute ? childIdx / Math.max(1, childCount) + prog : prog;
  const loop = pr?.loop ?? (layout.closed || layout.preset === "circle");
  const frac = loop ? ((fracRaw % 1) + 1) % 1 : Math.max(0, Math.min(1, fracRaw));
  const s = frac * L;

  const p = path.getPointAtLength(s);
  const pose: PathPose = {
    x: (p.x + (layout.origin?.x ?? 0)) / 100,
    y: (p.y + (layout.origin?.y ?? 0)) / 100,
    rotate: 0,
  };

  if ((layout.orient ?? "upright") === "tangent") {
    // 접선 — 화면 픽셀 공간에서 각도 (경로 좌표는 %이므로 축별 스케일).
    const eps = Math.max(0.5, L * 0.002);
    const a = path.getPointAtLength(Math.max(0, s - eps));
    const b = path.getPointAtLength(Math.min(L, s + eps));
    const dx = ((b.x - a.x) / 100) * widthPx;
    const dy = ((b.y - a.y) / 100) * heightPx;
    pose.rotate = (Math.atan2(dy, dx) * 180) / Math.PI;
  }

  if (layout.swing) {
    // 감쇠 진자 — 씬 시작에서 놓여 서서히 안정. 자식별 위상차로 군집감 제거.
    const t = frame / fps;
    const w0 = 2 * Math.PI * SWING_FREQ_HZ;
    const wd = w0 * Math.sqrt(1 - SWING_ZETA * SWING_ZETA);
    pose.rotate +=
      SWING_A_DEG * Math.exp(-SWING_ZETA * w0 * t) * Math.cos(wd * t + childIdx * 0.7);
  }

  return pose;
}


// 엔진 원근 관례 (curve3d 와 동일 기본값)
const ORBIT_P = 1100;

/** B1 orbit 포즈 — node 검증: 앞 s=P/(P-R)>1 중앙, 뒤 s<1, 좌우 대칭, R<P 발산 없음. */
export function sampleOrbitLayout(
  layout: OrbitLayoutSpec,
  frame: number,
  childIdx: number,
  childCount: number,
  widthPx: number,
  heightPx: number,
  progressOverride?: number | null,
  /** 3D 씬이면 씬 원근 P(px) — 진짜 z 모드 (가짜 스케일/zIndex 미방출). */
  scene3dP?: number | null,
): PathPose {
  let prog = 0;
  if (progressOverride != null && Number.isFinite(progressOverride)) {
    prog = progressOverride;
  } else if (layout.progress?.loop) {
    const dur = Math.max(1, layout.progress.durationF ?? 240);
    prog = (frame / dur) % 1;
  }
  const R = (Math.min(Math.max(layout.radius ?? 28, 5), 45) / 100) * widthPx;
  const th = 2 * Math.PI * (childIdx / Math.max(1, childCount) + prog);
  const z = R * Math.cos(th); // z+ = 카메라 쪽 (theta=0 이 정면)
  const tilt = Math.min(Math.max(layout.tilt ?? 0, 0), 40) / 100;
  if (scene3dP) {
    // 진짜 3D: 위치는 궤도 수식 그대로, 깊이는 translateZ 로 — 원근 확대와
    // 깊이 가림을 브라우저가 계산한다 (가짜 s=P/(P-z) 및 zIndex 제거).
    return {
      x: 0.5 + (layout.origin?.x ?? 0) / 100 + ((R * Math.sin(th)) / widthPx),
      y: 0.5 + (layout.origin?.y ?? 0) / 100 + ((tilt * R * Math.cos(th)) / heightPx),
      rotate: 0,
      zPx: z,
    };
  }
  const s = Math.min(2.5, Math.max(0.4, ORBIT_P / (ORBIT_P - z)));
  return {
    x: 0.5 + (layout.origin?.x ?? 0) / 100 + ((R * Math.sin(th) * s) / widthPx),
    y: 0.5 + (layout.origin?.y ?? 0) / 100 + ((tilt * R * Math.cos(th)) / heightPx), // 앞 아래 / 뒤 위
    rotate: 0,
    scale: s,
    zIndex: Math.round(z),
  };
}


// ---------------------------------------------------------------------------
// motionPath — AE "paste path to position" + Auto-Orient 등가의 근본 프리미티브.
// 그룹 전용이 아니라 "모든 요소"의 속성이다: 요소에 경로를 붙이면 progress
// 키프레임 채널(키 간격=속도, 세그먼트 이징=가감속)이 경로 위 위치를 구동한다.
// 대관람차/캐러셀 같은 N개 배치는 프리셋이 아니라 "같은 경로 + offset(위상)만
// 다른 요소 N개"로 만든다 — AE 와 동일한 조립 방식. (그룹 layout.distribute 는
// 그 N개 등록의 단축일 뿐, 별도 기능이 아니다.)
// ---------------------------------------------------------------------------
/** 경로 앵커 점 — 피그마식 편집 모델. 좌표/핸들 모두 0..100 (x=폭 %, y=높이 %),
 *  핸들은 앵커 기준 상대 벡터. 핸들 없으면 그 방향은 직선. */
export type PathPoint = {
  x: number;
  y: number;
  /** 이전 세그먼트에서 들어오는 베지어 핸들 (앵커 상대). */
  hIn?: { x: number; y: number };
  /** 다음 세그먼트로 나가는 베지어 핸들 (앵커 상대). */
  hOut?: { x: number; y: number };
};

/** 점+핸들 -> SVG d (큐빅 체인). closed 면 마지막->첫 점 세그먼트 + Z. */
export function pointsToD(points: PathPoint[], closed?: boolean): string {
  if (!points || points.length < 2) return "";
  const n = (v: number) => Number(v.toFixed(3));
  let d = `M ${n(points[0].x)} ${n(points[0].y)}`;
  const seg = (a: PathPoint, b: PathPoint) => {
    const c1x = a.x + (a.hOut?.x ?? 0);
    const c1y = a.y + (a.hOut?.y ?? 0);
    const c2x = b.x + (b.hIn?.x ?? 0);
    const c2y = b.y + (b.hIn?.y ?? 0);
    return ` C ${n(c1x)} ${n(c1y)}, ${n(c2x)} ${n(c2y)}, ${n(b.x)} ${n(b.y)}`;
  };
  for (let i = 1; i < points.length; i++) d += seg(points[i - 1], points[i]);
  if (closed) d += seg(points[points.length - 1], points[0]) + " Z";
  return d;
}

// kappa: 큐빅 4분원 근사 상수 (0.5522847498 — 표준 유도값)
const KAPPA = 0.5522847498;

/** 프리셋 -> 편집 가능한 점 배열 (에디터 "포인트로 변환"용). */
export function presetToPoints(preset: "circle" | "arc" | "wave", radius = 30): { points: PathPoint[]; closed: boolean } {
  if (preset === "circle") {
    const r = radius;
    const k = KAPPA * r;
    return {
      closed: true,
      points: [
        { x: 50, y: 50 - r, hIn: { x: -k, y: 0 }, hOut: { x: k, y: 0 } },
        { x: 50 + r, y: 50, hIn: { x: 0, y: -k }, hOut: { x: 0, y: k } },
        { x: 50, y: 50 + r, hIn: { x: k, y: 0 }, hOut: { x: -k, y: 0 } },
        { x: 50 - r, y: 50, hIn: { x: 0, y: k }, hOut: { x: 0, y: -k } },
      ],
    };
  }
  if (preset === "arc") {
    // Q(50,30) 의 큐빅 등가: c = P + 2/3 (Q - P)
    return {
      closed: false,
      points: [
        { x: 8, y: 62, hOut: { x: 28, y: -21.33 } },
        { x: 92, y: 62, hIn: { x: -28, y: -21.33 } },
      ],
    };
  }
  // wave: M 5 55 C 25 35, 40 75, 58 55 S 88 35, 95 55 (S = 반사 핸들)
  return {
    closed: false,
    points: [
      { x: 5, y: 55, hOut: { x: 20, y: -20 } },
      { x: 58, y: 55, hIn: { x: -18, y: 20 }, hOut: { x: 18, y: -20 } },
      { x: 95, y: 55, hIn: { x: -7, y: -20 } },
    ],
  };
}

export type MotionPathSpec = {
  /** 경로 전체 오프셋 (0..100 캔버스 %) — 캔버스 드래그 이동용. */
  origin?: { x: number; y: number };
  /** 피그마식 점+핸들 경로 — 에디터 캔버스에서 직접 편집. d 보다 우선. */
  points?: PathPoint[];
  /** points 경로를 닫을지 (원형 순환 경로). */
  closed?: boolean;
  /** SVG path d (0..100 좌표). preset 대신 직접. 추후: 펜 툴로 그린 라인 ref. */
  d?: string;
  /** 프리셋 경로. */
  preset?: "circle" | "arc" | "wave";
  /** circle 반지름 (높이 %, 기본 30). */
  radius?: number;
  /** AE Auto-Orient Along Path. none(기본)=수평 유지, tangent=경로 방향 회전. */
  orient?: "none" | "tangent";
  /** 경로 시작 위상 (0..1) — 같은 경로에 여러 요소를 다른 지점으로 등록할 때. */
  offset?: number;
  /** 등속 무한 순환(키프레임 없이) — AE loopOut cycle 등가. */
  loop?: boolean | { durationF?: number };
};

/** 요소의 motionPath 포즈. progress 는 요소 keyframes 의 progress 채널 값. */
export function sampleMotionPath(
  mp: MotionPathSpec,
  frame: number,
  fps: number,
  widthPx: number,
  heightPx: number,
  kfProgress?: number | null,
): PathPose | null {
  const loopOn = !!mp.loop;
  const d = mp.points && mp.points.length >= 2 ? pointsToD(mp.points, mp.closed) : mp.d;
  const durationF =
    typeof mp.loop === "object" ? Math.max(1, mp.loop.durationF ?? 240) : 240;
  let prog: number;
  if (kfProgress != null && Number.isFinite(kfProgress)) {
    prog = kfProgress;
  } else if (loopOn) {
    prog = (frame / durationF) % 1;
  } else {
    prog = 0;
  }
  prog += mp.offset ?? 0;
  return samplePathLayout(
    {
      type: "path",
      origin: mp.origin,
      d,
      preset: mp.preset,
      radius: mp.radius,
      distribute: false,
      orient: mp.orient === "tangent" ? "tangent" : "upright",
      progress: loopOn ? { loop: true, durationF } : undefined,
    },
    frame,
    fps,
    0,
    1,
    widthPx,
    heightPx,
    prog,
  );
}
