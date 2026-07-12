// verify3d.mjs — 3D 좌표/카메라 역변환 수치 검증 하네스 (설계 step 0).
//
// 목적: CSS transform 리스트(좌->우 = 행렬 곱 순서)와 three.js Matrix4 로 만든
// 카메라 pose C / 역변환 C^-1 이 일치하는지 코드로 고정한다. 부호/축/오일러
// 순서를 "문서 신뢰" 가 아니라 수치 대조로 확정 (리서치 리스크 대응).
//
// 좌표 관례 (여기서 고정):
//  - 스펙 z: AE 관례 (+z = 화면 안쪽/멀어짐, comp-width %)
//  - CSS z: +z = 시청자 쪽  ->  css_z = -spec_z
//  - 카메라 pose C = T(poi) R_Y(pan) R_X(tilt) T(-poi) T(panX, panY, -dollyCss) R_Z(roll)
//  - 씬 래퍼 transform = C^-1
//
// 실행: node scripts/verify3d.mjs  (remotion 폴더에서)

import * as THREE from "three";

const EPS = 1e-10;
let failed = 0;

function assertClose(a, b, msg) {
  const d = Math.abs(a - b);
  if (d > EPS) {
    console.error(`FAIL ${msg}: ${a} vs ${b} (diff ${d})`);
    failed++;
  }
}

function matEqual(A, B, msg) {
  for (let i = 0; i < 16; i++) assertClose(A.elements[i], B.elements[i], `${msg}[${i}]`);
}

const deg = (d) => (d * Math.PI) / 180;

// CSS transform 함수들을 Matrix4 로 (CSS 는 column vector, three 도 column-major —
// CSS "f1 f2" 적용 = M(f1) * M(f2), three 의 multiply 와 같은 순서)
const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
const RX = (d) => new THREE.Matrix4().makeRotationX(deg(d));
const RY = (d) => new THREE.Matrix4().makeRotationY(deg(d));
const RZ = (d) => new THREE.Matrix4().makeRotationZ(deg(d));

function mul(...ms) {
  const out = new THREE.Matrix4().identity();
  for (const m of ms) out.multiply(m);
  return out;
}

// ---- 1) 역변환 대수: C * C^-1 = I ----
function cameraPose({ poi, pan, tilt, panX, panY, dolly, roll }) {
  return mul(
    T(poi.x, poi.y, poi.z),
    RY(pan),
    RX(tilt),
    T(-poi.x, -poi.y, -poi.z),
    T(panX, panY, -dolly),
    RZ(roll),
  );
}

// 설계된 CSS 역변환 리스트 (좌->우):
// rotateZ(-roll) translate3d(-panX,-panY,dolly) translate3d(poi) rotateX(-tilt) rotateY(-pan) translate3d(-poi)
function cameraInverseCss({ poi, pan, tilt, panX, panY, dolly, roll }) {
  return mul(
    RZ(-roll),
    T(-panX, -panY, dolly),
    T(poi.x, poi.y, poi.z),
    RX(-tilt),
    RY(-pan),
    T(-poi.x, -poi.y, -poi.z),
  );
}

const cases = [
  { poi: { x: 0, y: 0, z: 0 }, pan: 0, tilt: 0, panX: 0, panY: 0, dolly: 0, roll: 0 },
  { poi: { x: 100, y: -50, z: 30 }, pan: 25, tilt: -12, panX: 40, panY: 20, dolly: 150, roll: 8 },
  { poi: { x: -300, y: 200, z: -80 }, pan: -63, tilt: 41, panX: -10, panY: 55, dolly: -90, roll: -30 },
];

for (const [i, c] of cases.entries()) {
  const C = cameraPose(c);
  const inv = new THREE.Matrix4().copy(C).invert();
  const cssInv = cameraInverseCss(c);
  matEqual(inv, cssInv, `case${i} C^-1 vs CSS 역변환 리스트`);
  matEqual(mul(C, cssInv), new THREE.Matrix4().identity(), `case${i} C*CSS^-1 = I`);
}

// ---- 2) 불변식: 모든 채널 0 -> identity ----
matEqual(
  cameraInverseCss(cases[0]),
  new THREE.Matrix4().identity(),
  "기본 카메라 = identity (2D 픽셀 동일 불변식)",
);

// ---- 3) z 부호 관례: spec z(+안쪽) -> css translateZ(-z) 가 카메라에서 멀어짐 ----
// 원근 투영: 시점 (0,0,P) 에서 z_css 인 점의 겉보기 스케일 = P / (P - z_css)
{
  const P = 2667; // 1920 * 1.3889 (AE 50mm 등가)
  const specZ = 300; // 스펙: 안쪽으로 300px
  const cssZ = -specZ;
  const s = P / (P - cssZ);
  if (!(s < 1)) {
    console.error(`FAIL z 부호: 스펙 +z(멀어짐) 인데 커져 보임 (s=${s})`);
    failed++;
  }
  const sNear = P / (P - specZ); // css +z (가까움)
  if (!(sNear > 1)) {
    console.error("FAIL css +z 가 가까워지지 않음");
    failed++;
  }
}

// ---- 4) 시차 예측: 달리 시 z 별 스케일 변화율 ----
{
  const P = 2667;
  const dolly = 400; // 카메라가 400px 전진 (css: 요소가 +400 다가옴)
  const appar = (zCss, d) => P / (P - (zCss + d));
  const back = appar(-300, 0), backAfter = appar(-300, dolly);
  const front = appar(150, 0), frontAfter = appar(150, dolly);
  const backGain = backAfter / back;
  const frontGain = frontAfter / front;
  if (!(frontGain > backGain)) {
    console.error(`FAIL 시차: 가까운 요소가 더 빨리 커져야 함 (front ${frontGain} vs back ${backGain})`);
    failed++;
  } else {
    console.log(`시차 확인: front x${frontGain.toFixed(3)} > back x${backGain.toFixed(3)} (달리 ${dolly}px)`);
  }
}

if (failed === 0) console.log("verify3d: ALL PASS");
else {
  console.error(`verify3d: ${failed} FAILURES`);
  process.exit(1);
}
