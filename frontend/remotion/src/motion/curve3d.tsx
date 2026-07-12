// curve3d.tsx — 3D 커브드 캔버스 (AE CC Cylinder 방식: 스트립 슬라이싱).
// "화면(면)을 평면이라 보고 그 면 자체를 굽힌다": 콘텐츠를 N개 스트립으로 잘라
// 각 스트립을 원기둥 위 각도에 3D 배치(기울기+호 투영 위치+z). 조각이 충분하면
// 요소 픽셀 자체가 휘어 보인다 — 텍스트 글리프도 실제로 굽는다(Google 레퍼런스 룩).
//
// 적용 단위: 씬 전체(scene.curve3d — 씬의 모든 콘텐츠가 한 곡면) / group·frame
// (자식 전체가 한 곡면) / 개별 요소(자기 콘텐츠만 굽음, 요소 위치가 곡면 중심).
//
// 방향: amount 양수 = 안쪽(원통 내부에서 본 룩 — 가장자리가 기울며 멀어짐, Google)
//       amount 음수 = 바깥쪽(볼록 — 가장자리가 다가옴).
// 결정론적: 프레임/랜덤 없음, 순수 기하.

import React from "react";

export type Curve3DSpec = {
  /** 굴곡 세기(deg, 가장자리 각). +안쪽(오목/구글 룩) / -바깥쪽(볼록). */
  amount: number;
  /** 굴곡 축. "y"=위아래로 굽음(행이 말림, rotateX) / "x"=좌우로 굽음(rotateY) / "both"=구체. 기본 "y". */
  axis?: "x" | "y" | "both";
  /** 프로파일. "arc"=전체 원호 / "edges"=중앙 평평·끝만 굽음. 기본 "arc". */
  profile?: "arc" | "edges";
  /** z 깊이 배율 기준(px). 420 = 원기둥 기하 그대로. 기본 420. */
  depth?: number;
  /** perspective(px). 작을수록 왜곡 강함. 기본 1100. */
  perspective?: number;
  /** 가장자리 블러 최대치(px). 굴곡 진행도 비례. 기본 0. */
  edgeBlur?: number;
  /** 슬라이스 수(4..28). 많을수록 매끈, 무거움. 기본 16(구체는 10x10 캡). */
  segments?: number;
  /** 적용 방식. "bend"=면 자체를 슬라이스로 굽힘(CC Cylinder — 픽셀이 휨) /
   *  "drum"=자식들을 곧은 판으로 원통 위에 배치(Google 커브드 월 — 줄 선명).
   *  기본: 씬/요소 = bend, 그룹 = drum. */
  mode?: "bend" | "drum";
};

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 한 축 위의 곡면 포즈 — 호 길이 보존 수치 적분. 프로파일이 어떤 모양이든
// (arc 든 edges 든) 표면이 연속으로 이어진다(조각 찢어짐 방지).
//   φ(u) = fall(u)·|amt| (표면 기울기), 위치 = ∫cos·du(축 방향), 깊이 = ∫sin·du.
// 볼록(convex, amount>0): 가장자리가 뒤로 말림(중앙이 튀어나와 보임).
// 오목(concave, amount<0): 가장자리가 앞으로 말림(움푹 파인 느낌).
function bendAxisPose(
  off: number,
  c: Curve3DSpec,
  spanPx: number,
): { t: number; z: number; rot: number; prog: number } {
  const amtDeg = c.amount ?? 0;
  if (!amtDeg || !off) {
    // off=0 도 rot/z 는 0 이지만 prog 0 유지.
    if (!amtDeg) return { t: 0, z: 0, rot: 0, prog: 0 };
  }
  const convex = amtDeg > 0;
  const mag = Math.abs(amtDeg);
  const amtRad = (mag * Math.PI) / 180;
  const profile = c.profile ?? "arc";
  const fall = (o: number): number => {
    const n = clampN(o / 0.5, -1, 1);
    if (profile === "edges") return Math.sign(n) * Math.pow(Math.abs(n), 2.6);
    return n;
  };
  const zScale = (c.depth ?? 420) / 420;
  // 0 → |off| 수치 적분 (호 길이 보존: 표면을 따라 잰 거리가 원래 평면 거리).
  const N = 48;
  const ao = Math.abs(off);
  const du = ao / N;
  let along = 0; // 축 방향 투영 누적 (fraction)
  let depth = 0; // 깊이 누적 (fraction)
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) * du;
    const phi = Math.abs(fall(u)) * amtRad;
    along += Math.cos(phi) * du;
    depth += Math.sin(phi) * du;
  }
  const f = fall(off);
  const t = (Math.sign(off) * along - off) * spanPx; // 압축량(가장자리 안쪽으로)
  const z = -depth * spanPx * zScale * (convex ? 1 : -1);
  // 기울기: 볼록이면 위 조각(off<0)의 윗변이 뒤로 → rotateX 양수 (오목은 반대).
  const rot = (convex ? -f : f) * mag;
  return { t, z, rot, prog: Math.abs(f) };
}

/** 오프셋(중심 기준) → 곡면 포즈 (양 축 조합). */
export function curvePose(
  offX: number,
  offY: number,
  c: Curve3DSpec,
): { tx: number; ty: number; rx: number; ry: number; z: number; blur: number } {
  const axis = c.axis ?? "y";
  let rx = 0, ry = 0, tx = 0, ty = 0, z = 0, prog = 0;
  if (axis === "y" || axis === "both") {
    const p = bendAxisPose(offY, c, 1080);
    rx = p.rot;
    ty = p.t;
    z += p.z;
    prog = Math.max(prog, p.prog);
  }
  if (axis === "x" || axis === "both") {
    const p = bendAxisPose(offX, c, 1920);
    ry = -p.rot; // 좌우 축은 회전 방향이 거울상
    tx = p.t;
    z += p.z;
    prog = Math.max(prog, p.prog);
  }
  const blur = (c.edgeBlur ?? 0) * prog;
  return { tx, ty, rx, ry, z, blur };
}

// 곡면 위 연속 좌표 — 중심(0)에서 오프셋 o 까지 호 길이 보존 적분.
// along = 축 방향 투영(fraction), depth = 깊이(fraction, 항상 양수).
function surfacePoint(o: number, c: Curve3DSpec): { along: number; depth: number } {
  const amtDeg = Math.abs(c.amount ?? 0);
  if (!amtDeg || !o) return { along: o, depth: 0 };
  const amtRad = (amtDeg * Math.PI) / 180;
  const profile = c.profile ?? "arc";
  const fall = (u: number): number => {
    const n = clampN(u / 0.5, -1, 1);
    if (profile === "edges") return Math.sign(n) * Math.pow(Math.abs(n), 2.6);
    return n;
  };
  const N = 64;
  const ao = Math.abs(o);
  const du = ao / N;
  let along = 0;
  let depth = 0;
  for (let i = 0; i < N; i++) {
    const u = (i + 0.5) * du;
    const phi = Math.abs(fall(u)) * amtRad;
    along += Math.cos(phi) * du;
    depth += Math.sin(phi) * du;
  }
  return { along: Math.sign(o) * along, depth };
}

// ---------------------------------------------------------------------------
// Bend = 힌지 스트립 + 스트립별 완전한 matrix3d(원근 포함) 기하.
//
// 왜 displacement 필터가 아닌가 (전부 실측): SVG feDisplacementMap 의 맵은 8-bit
// 서페이스라 스텝 = 필요범위/255. 씬 전체 80° 같은 강한 굴곡은 범위가 1000px+ 라
// 스텝이 수 px = 슬라브 계단이 물리적으로 불가피하다. 다중 패스도 중간 서페이스가
// 8-bit 로 재양자화돼 오차가 합산될 뿐 정밀도를 못 올린다.
//
// 기하(CSS matrix)는 float 정밀도라 이 벽이 없다. 스트립의 과거 문제(조각 이음새)는
// 두 가지로 제거한다:
//  - 힌지 체인: 각 스트립을 시작 경계에 앵커하고 경계→경계 현(chord) 각으로 회전
//    → 이웃 경계가 수학적으로 정확히 이어짐 (기존 검증된 방식).
//  - 공유 perspective 컨테이너(preserve-3d) 대신 스트립마다 원근까지 포함한
//    matrix3d 를 직접 계산해 "평평한" 요소로 렌더 → 3D 컴포지팅 레이어 분리/스냅이
//    사라지고 foreignObject 안에서 한 서페이스로 페인트된다.
// 세그먼트 32 고정: 80° 기준 현-원호 편차(sagitta) < 0.7px — 항상 매끈, 노브 불필요.
// ---------------------------------------------------------------------------

export type ContentZone = { x0: number; x1: number; y0: number; y1: number };

/** 곡면 클론 내부 여부 — 소비자(Composed*)는 이 안에서 GPU 레이어 관용구
 *  (translate3d(0,0,0)/scale3d/willChange)를 끄고 2D 로 렌더한다(레이어 예산). */
export const CurveCloneCtx = React.createContext(false);


// --- 4x4 행렬 (내부 row-major, CSS 방출 시 column-major 변환) — 스트립용 ---
type M4 = Float64Array;
function mMul(a: M4, b: M4): M4 {
  const o = new Float64Array(16);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      o[r * 4 + c] = s;
    }
  return o;
}
const mTrans = (x: number, y: number, z: number): M4 =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
const mRotX = (rad: number): M4 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float64Array([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
};
const mRotY = (rad: number): M4 => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float64Array([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
};
const mPersp = (p: number): M4 =>
  new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1 / p, 1]);
function mCss(m: M4): string {
  const v: string[] = [];
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      const x = m[r * 4 + c];
      v.push(Math.abs(x) < 1e-12 ? "0" : x.toPrecision(10));
    }
  return `matrix3d(${v.join(",")})`;
}

/** 단일 요소/씬/frame 용 곡면 — 사전 투영(pre-projected) 삼각형 메시.
 *
 *  모든 축(y 원통 / x 원통 / both 돔)을 같은 경로로 렌더한다:
 *  1) 곡면 위 정점 그리드를 CPU 에서 계산하고 원근 나눗셈까지 마친 "화면 2D
 *     좌표"로 투영한다.
 *  2) 셀마다 삼각형 2개(공유 정점 -> 피스와이즈-선형 연속, 이음새 0)를
 *     "2D affine matrix()" 로 페인트한다.
 *
 *  왜 matrix3d 가 아닌가(전부 실측): 3D 변환은 조각마다 컴포지팅 레이어를
 *  만들고, (조각 수 x 콘텐츠 텍스처)가 Chromium GPU 예산을 넘는 순간 조각
 *  콘텐츠가 "비결정적으로" 드랍된다. 2D matrix 는 페인트 타임 변환이라 레이어가
 *  없다. 셀 내부의 원근 비선형성 손실은 이 밀도에선 서브픽셀.
 *  클론 내부의 GPU 레이어 관용구는 CurveCloneCtx 로 끈다(같은 예산 문제).
 *
 *  측정용 고스트가 논리 위치를 유지하므로 에디터 선택박스는 평면 좌표를 잰다. */
export const CurveSurface: React.FC<{
  curve: Curve3DSpec;
  /** 곡면 중심(0..1). 단일 요소는 그 요소 위치. */
  center?: { x: number; y: number };
  /** 컨테이너 픽셀 크기 — 씬은 comp, frame 은 박스. 기본 1920x1080. */
  sizePx?: { w: number; h: number };
  /** (호환용 — 메시 기하는 전 영역 float 정밀도라 사용하지 않음) */
  contentZone?: ContentZone;
  children: React.ReactNode;
}> = ({ curve, center = { x: 0.5, y: 0.5 }, sizePx, children }) => {
  const amt = curve.amount ?? 0;
  if (!amt) return <>{children}</>;
  const w = sizePx?.w ?? 1920;
  const h = sizePx?.h ?? 1080;
  const axis = curve.axis ?? "y";
  const P = curve.perspective ?? 1100;
  const zSign = amt > 0 ? 1 : -1;
  const edgeBlur = curve.edgeBlur ?? 0;
  const cx = center.x * w;
  const cy = center.y * h;
  const A = (Math.abs(amt) * Math.PI) / 180;

  // ---- 단일 축(y/x 원통) = 힌지 스트립 + matrix3d --------------------------
  // 이 경로는 사용자 검증 완료("딱 좋았던" 룩). matrix3d 레이어는 텍스처를 GPU 로
  // 샘플링해 스트립 경계가 이음새 없이 이어진다. 2D matrix() 페인트로 통일해 봤더니
  // 밴드마다 글리프가 "따로 래스터"되어 행 경계가 어긋나 보이는 계단이 생겼다
  // (2026-07-09 실측) — 원통은 32 레이어뿐이라 GPU 예산 문제도 없으므로 유지.
  if (axis !== "both") {
    const vertical = axis !== "x";
    const K = 32;
    const spanPx = vertical ? h : w;
    const centerOff = vertical ? center.y : center.x;
    // 클립 오버랩 — 고정 % 는 작은 frame 에서 1px 미만이 되어 슬라이스 사이
    // 헤어라인이 보인다 (실측: frame 곡면 가로줄). 실제 px 기준(~0.9px)으로 환산.
    const eps = Math.max(0.04, (0.9 / Math.max(1, spanPx)) * 100);
    // % — 캔버스 밖 콘텐츠 확장. 굽힘이 강하면 원통의 위/아래 가장자리가 큰
    // 각도로 꺾이며 화면 밖 콘텐츠가 많이 말려 들어온다 — 60% 로는 끝 행이
    // 중간에서 잘렸다(실측: marquee 원통 상하단 절단). 넉넉히 확장.
    const PAD = 160;
    const mView = mMul(mMul(mTrans(w / 2, h / 2, 0), mPersp(P)), mTrans(-w / 2, -h / 2, 0));

    const pts: { along: number; z: number; off: number }[] = [];
    for (let k = 0; k <= K; k++) {
      const off = k / K - centerOff;
      const sp = surfacePoint(off, curve);
      pts.push({ along: sp.along * spanPx, z: -sp.depth * spanPx * zSign, off });
    }

    const strips: React.ReactNode[] = [];
    for (let i = 0; i < K; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dAlong = b.along - a.along;
      const dZ = b.z - a.z;
      const angRad = vertical ? Math.atan2(dZ, dAlong) : Math.atan2(-dZ, dAlong);
      const shift = a.along - a.off * spanPx; // 시작 경계의 압축 이동(px)
      const hingePx = (i / K) * spanPx; // 힌지 = 시작 경계 (컨테이너 px)
      const ox = vertical ? w / 2 : hingePx;
      const oy = vertical ? hingePx : h / 2;
      // L = T(O) · T(축 shift) · T(0,0,z) · Rot(ang) · T(-O)
      let L = mTrans(ox, oy, 0);
      L = mMul(L, vertical ? mTrans(0, shift, 0) : mTrans(shift, 0, 0));
      L = mMul(L, mTrans(0, 0, a.z));
      L = mMul(L, vertical ? mRotX(angRad) : mRotY(angRad));
      L = mMul(L, mTrans(-ox, -oy, 0));
      const M = mMul(mView, L);

      const startPct = (i / K) * 100;
      const endPct = ((i + 1) / K) * 100;
      const lead = i === 0 ? -PAD : Math.max(0, startPct - eps);
      const trail = i === K - 1 ? -PAD : Math.max(0, 100 - endPct - eps);
      const clip = vertical
        ? `inset(${lead}% 0% ${trail}% 0%)`
        : `inset(0% ${trail}% 0% ${lead}%)`;
      const midOff = (a.off + b.off) / 2;
      const blur = edgeBlur * Math.min(1, Math.abs(midOff) / 0.5);

      strips.push(
        // 순서가 핵심: transform > (blur) > clip — 이전엔 clip 이 blur "위"라
        // 조각 경계에서 번짐이 칼로 잘려 세로/가로 이음선이 보였다 (실측:
        // 3D canvas + 블러). clip 을 안쪽으로 내리면 잘린 조각이 블러로
        // 살짝 밖까지 번지며 이웃 조각과 겹쳐 이음선이 사라진다.
        <div
          key={i}
          data-nobounds="true"
          style={{
            position: "absolute",
            inset: 0,
            transform: mCss(M),
            transformOrigin: "0 0",
          }}
        >
          <div style={{ position: "absolute", inset: 0, filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined }}>
            <div style={{ position: "absolute", inset: 0, clipPath: clip }}>
              <CurveCloneCtx.Provider value={true}>{children}</CurveCloneCtx.Provider>
            </div>
          </div>
        </div>,
      );
    }

    return (
      <div data-nobounds="true" style={{ position: "absolute", inset: 0 }}>
        {/* 측정용 고스트 — 변환 없는 투명 사본. 에디터 선택박스가 논리 위치를 재게. */}
        <div aria-hidden data-nobounds="true" style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}>
          {children}
        </div>
        {/* 주의: foreignObject 로 감싸면 Chromium 이 내부 3D 변환을 무시(전체 평평).
            일반 DOM 에서 스트립별 matrix3d 로 페인트한다. */}
        <div data-curveclones="true" style={{ position: "absolute", inset: 0 }}>{strips}</div>
      </div>
    );
  }

  // ---- 돔(axis both) = 사전 투영 2D affine 삼각형 메시 ----------------------

  // 곡면 함수 — 축별. 단일 축은 surfacePoint(호 길이 보존 + profile 지원),
  // 돔(both)은 축별 반지름(Rx=w/2A, Ry=h/2A) 구면 캡(arc 프로파일).
  const Ry = h / 2 / Math.max(0.05, A);
  const Rx = w / 2 / Math.max(0.05, A);
  const domeAngles = (x: number, y: number): { lam: number; th: number } => {
    const lam = (y - cy) / Ry;
    const cl = Math.max(0.05, Math.cos(clampN(lam, -1.53, 1.53)));
    return { lam, th: (x - cx) / (Rx * cl) };
  };
  const surf = (x: number, y: number): [number, number, number] => {
    if (axis === "both") {
      const a = domeAngles(x, y);
      const lam = clampN(a.lam, -1.53, 1.53);
      const cl = Math.max(0.05, Math.cos(lam));
      const th = clampN(a.th, -1.53, 1.53);
      return [
        cx + Rx * cl * Math.sin(th),
        cy + Ry * Math.sin(lam),
        -zSign * (Ry * (1 - cl) + Rx * cl * (1 - Math.cos(th))),
      ];
    }
    // (단일 축은 위 스트립 분기에서 처리 — 여기는 both 전용)
    const sp = surfacePoint(y / h - center.y, curve);
    return [x, (center.y + sp.along) * h, -zSign * sp.depth * h];
  };

  // 그리드 밀도 — 각도에 비례(작은 굴곡은 셀도 적게 = 렌더 비용 절감).
  const KX = Math.round(clampN((9 * A) / 1.4, 3, 9));
  const KY = Math.round(clampN((12 * A) / 1.4, 4, 12));
  const HORIZON = 1.35; // rad — 돔 접힘 전 컬링 마진

  // 정점 그리드 (source px -> 곡면 3D)
  const V: [number, number, number][][] = [];
  for (let j = 0; j <= KY; j++) {
    const row: [number, number, number][] = [];
    for (let i = 0; i <= KX; i++) row.push(surf((i / KX) * w, (j / KY) * h));
    V.push(row);
  }

  // 원근 투영(w 나눗셈까지 CPU 에서) — 컨테이너 중앙이 소실점.
  const proj = (Pt: [number, number, number]): [number, number] => {
    const x = Pt[0] - w / 2, y = Pt[1] - h / 2, z = Pt[2];
    const wclip = Math.max(0.2, 1 - z / P);
    return [w / 2 + x / wclip, h / 2 + y / wclip];
  };

  const cells: React.ReactNode[] = [];
  const triNode = (
    key: string,
    s: [number, number][],
    Pv: [number, number, number][],
    blurAmt: number,
    clipPts: [number, number][],
  ) => {
    const e1 = [s[1][0] - s[0][0], s[1][1] - s[0][1]];
    const e2 = [s[2][0] - s[0][0], s[2][1] - s[0][1]];
    const det = e1[0] * e2[1] - e1[1] * e2[0];
    if (Math.abs(det) < 1e-6) return null;
    const p0 = proj(Pv[0]), p1 = proj(Pv[1]), p2 = proj(Pv[2]);
    const q1 = [p1[0] - p0[0], p1[1] - p0[1]];
    const q2 = [p2[0] - p0[0], p2[1] - p0[1]];
    const i11 = e2[1] / det, i12 = -e2[0] / det, i21 = -e1[1] / det, i22 = e1[0] / det;
    const ma = q1[0] * i11 + q2[0] * i21;
    const mc = q1[0] * i12 + q2[0] * i22;
    const mb = q1[1] * i11 + q2[1] * i21;
    const md = q1[1] * i12 + q2[1] * i22;
    const me = p0[0] - ma * s[0][0] - mc * s[0][1];
    const mf = p0[1] - mb * s[0][0] - md * s[0][1];
    const M2 = `matrix(${ma.toFixed(8)}, ${mb.toFixed(8)}, ${mc.toFixed(8)}, ${md.toFixed(8)}, ${me.toFixed(3)}, ${mf.toFixed(3)})`;
    // clip 폴리곤 — 무게중심에서 살짝 확장(이웃과 미세 오버랩, AA 틈 방지)
    const gx = (clipPts[0][0] + clipPts[1][0] + clipPts[2][0]) / 3;
    const gy = (clipPts[0][1] + clipPts[1][1] + clipPts[2][1]) / 3;
    const EXP = 1.006;
    const poly = clipPts
      .map(([px, py]) => `${(gx + (px - gx) * EXP).toFixed(3)}% ${(gy + (py - gy) * EXP).toFixed(3)}%`)
      .join(", ");
    return (
      <div
        key={key}
        data-nobounds="true"
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `polygon(${poly})`,
          transform: M2,
          transformOrigin: "0 0",
        }}
      >
        <div style={{ position: "absolute", inset: 0, filter: blurAmt > 0.05 ? `blur(${blurAmt.toFixed(2)}px)` : undefined }}>
          <CurveCloneCtx.Provider value={true}>{children}</CurveCloneCtx.Provider>
        </div>
      </div>
    );
  };

  for (let j = 0; j < KY; j++) {
    for (let i = 0; i < KX; i++) {
      const sx0 = (i / KX) * w, sx1 = ((i + 1) / KX) * w;
      const sy0 = (j / KY) * h, sy1 = ((j + 1) / KY) * h;
      // 돔: 수평선 너머 셀 컬링 — 클램프로 접혀 쌓이는 "구겨짐" 방지
      if (axis === "both") {
        const aa = domeAngles(sx0, sy0), ab = domeAngles(sx1, sy1);
        if (
          Math.max(Math.abs(aa.lam), Math.abs(ab.lam)) > HORIZON ||
          Math.max(Math.abs(aa.th), Math.abs(ab.th)) > HORIZON
        ) continue;
      }
      // 테두리 셀 클립 확장(캔버스 밖 콘텐츠가 굽혀 들어오는 부분). 2D matrix 는
      // 레이어가 없어 큰 확장도 예산 부담이 없지만, 시각적으로 15%면 충분.
      const MPAD = 15;
      const cx0 = i === 0 ? -MPAD : (i / KX) * 100;
      const cx1 = i === KX - 1 ? 100 + MPAD : ((i + 1) / KX) * 100;
      const cy0 = j === 0 ? -MPAD : (j / KY) * 100;
      const cy1 = j === KY - 1 ? 100 + MPAD : ((j + 1) / KY) * 100;
      const v00 = V[j][i], v10 = V[j][i + 1], v01 = V[j + 1][i], v11 = V[j + 1][i + 1];
      const mx = (sx0 + sx1) / 2 - cx;
      const my = (sy0 + sy1) / 2 - cy;
      const blur = edgeBlur * Math.min(1, Math.hypot(mx / w, my / h) / 0.5);
      const t1 = triNode(
        `${i}-${j}-a`,
        [[sx0, sy0], [sx1, sy0], [sx0, sy1]],
        [v00, v10, v01],
        blur,
        [[cx0, cy0], [cx1, cy0], [cx0, cy1]],
      );
      const t2 = triNode(
        `${i}-${j}-b`,
        [[sx1, sy0], [sx1, sy1], [sx0, sy1]],
        [v10, v11, v01],
        blur,
        [[cx1, cy0], [cx1, cy1], [cx0, cy1]],
      );
      if (t1) cells.push(t1);
      if (t2) cells.push(t2);
    }
  }

  return (
    <div data-nobounds="true" style={{ position: "absolute", inset: 0 }}>
      {/* 측정용 고스트 — 변환 없는 투명 사본. 에디터 선택박스가 논리 위치를 재게. */}
      <div aria-hidden data-nobounds="true" style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}>
        {children}
      </div>
      {/* data-curveclones — 에디터 측정/히트테스트가 이 서브트리(콘텐츠 클론
          수십~수백 개)를 스캔하지 않게 하는 마커. 측정은 위 고스트가 담당. */}
      <div data-curveclones="true" style={{ position: "absolute", inset: 0 }}>{cells}</div>
    </div>
  );
};

export const CurveDrum: React.FC<{
  curve: Curve3DSpec;
  items: { pos: { x: number; y: number }; node: React.ReactNode; key: string | number }[];
}> = ({ curve, items }) => {
  const amt = curve.amount ?? 0;
  if (!amt) return <>{items.map((it) => it.node)}</>;
  return (
    <div data-nobounds="true" style={{ position: "absolute", inset: 0, perspective: `${curve.perspective ?? 1100}px` }}>
      {/* 측정용 고스트 — 선택박스가 논리적(평면) 위치를 재도록 (CurveSurface 와 동일). */}
      <div aria-hidden data-nobounds="true" style={{ position: "absolute", inset: 0, opacity: 0, pointerEvents: "none" }}>
        {items.map((it) => it.node)}
      </div>
      <div data-nobounds="true" style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d" }}>
        {items.map((it) => {
          const pose = curvePose(it.pos.x - 0.5, it.pos.y - 0.5, curve);
          return (
            <div
              key={it.key}
              data-nobounds="true"
              style={{
                position: "absolute",
                inset: 0,
                transformOrigin: `${it.pos.x * 100}% ${it.pos.y * 100}%`,
                transform: `translate3d(${pose.tx.toFixed(2)}px, ${pose.ty.toFixed(2)}px, 0) rotateX(${pose.rx.toFixed(3)}deg) rotateY(${pose.ry.toFixed(3)}deg) translateZ(${pose.z.toFixed(2)}px)`,
                backfaceVisibility: "hidden",
                willChange: "transform",
              }}
            >
              <div style={{ position: "absolute", inset: 0, filter: pose.blur > 0.05 ? `blur(${pose.blur.toFixed(2)}px)` : undefined }}>
                {it.node}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** 요소 스펙에서 곡면 중심 위치 추출(요소별 관례 흡수). */
export function elementCurvePos(el: {
  element: string;
  base?: { position?: { x: number; y: number }; fromShape?: { x: number; y: number } };
}): { x: number; y: number } {
  if (el.element === "gooey") return el.base?.fromShape ?? { x: 0.5, y: 0.5 };
  return el.base?.position ?? { x: 0.5, y: 0.5 };
}
