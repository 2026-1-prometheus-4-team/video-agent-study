// text3d — 텍스트 압출을 "진짜 글리프 지오메트리" 로 (AE C4D 렌더러 방식).
//
// CSS 는 글리프 윤곽을 따라가는 옆벽을 만들 수 없다 (판 적층은 에지온에서
// 줄무늬 — 실측). AE 처럼: 폰트 아웃라인(OTF, opentype.js) -> THREE.Shape ->
// ExtrudeGeometry(깊이 + 베벨) 실제 지오메트리. 디바이스(ComposedDevice)와
// 같은 ThreeCanvas 파이프라인 — 프레임 순수 렌더 = 결정론.
//
// 크기 관례: PerspectiveCamera 를 z=P 에 두고 fov = 2 atan(H/2P) — z=0 평면이
// 1px=1unit 으로 렌더된다 (CSS perspective 불변식과 동일 수학). 따라서 글리프는
// CSS 텍스트와 같은 픽셀 크기, 회전 원근은 base.perspective(기본 1100)와 일치.
//
// 조명: 씬 라이트(SceneLightSpec) -> three DirectionalLight 브리지
// (docs/motion_math.md 조명 절: lightPos = (cos az cos el, sin az cos el, sin el),
// CSS y-down -> three y-up 부호 반전). 라이트 없으면 기본 스튜디오 근사
// (상단좌측 키 + 앰비언트 — extrudeBox 의 고정광과 같은 방향).

import React from "react";
import * as THREE from "three";
import { ThreeCanvas } from "@remotion/three";
import { staticFile, delayRender, continueRender } from "remotion";
import opentype from "opentype.js";
import type { SceneLightSpec } from "./lighting";

// 폰트 파일 매핑 (Root.tsx 의 General Sans 로딩과 동일 소스)
const GS_DIR = "fonts/GeneralSans_Complete/Fonts/OTF";
function fontFileFor(weight?: number | string): string {
  const w = typeof weight === "string" ? parseInt(weight, 10) || 600 : (weight ?? 600);
  if (w >= 700) return `${GS_DIR}/GeneralSans-Bold.otf`;
  if (w >= 600) return `${GS_DIR}/GeneralSans-Semibold.otf`;
  if (w >= 500) return `${GS_DIR}/GeneralSans-Medium.otf`;
  return `${GS_DIR}/GeneralSans-Regular.otf`;
}

// 폰트 로드 캐시 (탭 수명) — opentype.Font 는 불변 객체
const fontCache = new Map<string, Promise<opentype.Font>>();
function loadFont(url: string): Promise<opentype.Font> {
  let p = fontCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`font fetch ${r.status}: ${url}`);
        return r.arrayBuffer();
      })
      .then((buf) => opentype.parse(buf));
    fontCache.set(url, p);
  }
  return p;
}

/** opentype Path -> THREE.Shape[] (y-down 폰트 좌표 그대로 — 메시에서 y 반전) */
function pathToShapes(path: opentype.Path): THREE.Shape[] {
  const sp = new THREE.ShapePath();
  let started = false;
  for (const c of path.commands) {
    if (c.type === "M") {
      sp.moveTo(c.x, c.y);
      started = true;
    } else if (!started) {
      continue;
    } else if (c.type === "L") sp.lineTo(c.x, c.y);
    else if (c.type === "C") sp.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else if (c.type === "Q") sp.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
    // Z 는 Shape 가 자동 닫음
  }
  // isCCW 자동 판정 — 구멍(counter) 감지 (o, e 등의 안쪽)
  return sp.toShapes(false);
}

function buildTextGeometry(
  font: opentype.Font,
  text: string,
  fontSizePx: number,
  depth: number,
  letterSpacingPx: number,
): THREE.ExtrudeGeometry {
  // getPath 가 커닝 포함 어드밴스 처리. letterSpacing 은 글자별 경로 이어붙이기.
  const shapes: THREE.Shape[] = [];
  if (letterSpacingPx !== 0) {
    let x = 0;
    for (const ch of text) {
      const p = font.getPath(ch, x, 0, fontSizePx);
      shapes.push(...pathToShapes(p));
      x += font.getAdvanceWidth(ch, fontSizePx) + letterSpacingPx;
    }
  } else {
    shapes.push(...pathToShapes(font.getPath(text, 0, 0, fontSizePx)));
  }
  // 베벨: AE Bevel Depth 근사 — 깊이의 6%, 최대 2.5px (글리프 디테일 보호)
  const bevel = Math.min(2.5, depth * 0.06);
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevel > 0.2,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 10,
  });
  geo.computeBoundingBox();
  return geo;
}

function SceneLights(props: { light: SceneLightSpec | null }) {
  const L = props.light;
  // 브리지: CSS 관례 azimuth 0=우, 90=상 / three y-up — y 부호 반전
  const az = (((L?.azimuth ?? 135) * Math.PI) / 180);
  const el = (((L?.elevation ?? 40) * Math.PI) / 180);
  const r = 900;
  const pos: [number, number, number] = [
    Math.cos(az) * Math.cos(el) * r,
    Math.sin(az) * Math.cos(el) * r,
    Math.sin(el) * r,
  ];
  return (
    <>
      {/* 대비 튜닝: ambient 과다 시 회전해도 면 밝기 변화가 안 읽힌다 (실측) */}
      <ambientLight intensity={(L?.ambient ?? 0.35) * Math.PI * 0.55} />
      <directionalLight position={pos} intensity={(L?.intensity ?? 0.9) * Math.PI * 1.15} />
    </>
  );
}

function TextMesh(props: {
  text: string;
  fontUrl: string;
  fontSizePx: number;
  depth: number;
  color: string;
  letterSpacingPx: number;
  rotX: number;
  rotY: number;
  /** 폰트에 없는 글리프(한글 등) 감지 시 — CSS 판적층 폴백으로 전환 신호 */
  onUnsupported?: () => void;
}) {
  const { text, fontUrl, fontSizePx, depth, color, letterSpacingPx, rotX, rotY, onUnsupported } = props;
  const [font, setFont] = React.useState<opentype.Font | null>(null);
  React.useEffect(() => {
    const h = delayRender(`text3d font: ${fontUrl}`);
    let alive = true;
    loadFont(fontUrl)
      .then((f) => {
        if (alive) setFont(f);
        continueRender(h);
      })
      .catch((e) => {
        console.error("text3d font load failed", e);
        continueRender(h);
      });
    return () => {
      alive = false;
    };
  }, [fontUrl]);

  // 커버리지: General Sans 는 라틴 전용 — 한글/CJK 는 글리프가 없어 윤곽 추출이
  // 빈 결과가 된다 (실측: 한글 텍스트 미표시). 폴백 신호 후 렌더 중단.
  const covered = React.useMemo(() => {
    if (!font) return true;
    for (const ch of text) {
      if (ch === " " || ch === "\u00a0") continue;
      if (font.charToGlyphIndex(ch) === 0) return false;
    }
    return true;
  }, [font, text]);
  React.useEffect(() => {
    if (font && !covered) onUnsupported?.();
  }, [font, covered, onUnsupported]);

  const geo = React.useMemo(() => {
    if (!font || !covered) return null;
    return buildTextGeometry(font, text, fontSizePx, depth, letterSpacingPx);
  }, [font, covered, text, fontSizePx, depth, letterSpacingPx]);

  const group = React.useMemo(() => {
    if (!geo) return null;
    const bb = geo.boundingBox!;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    return { cx, cy };
  }, [geo]);

  if (!geo || !group) return null;
  // 폰트 좌표 y-down -> three y-up: scale(1,-1,1) + 중심 정렬.
  // 주의(실측 버그 수정): y 를 반전하면 bbox 중심도 부호가 뒤집힌다 —
  // 평행이동은 스케일 "후" 적용이므로 pos_y = +cy (이전 -cy 는 글리프를
  // 2|cy| 만큼 위로 띄웠다). 압출은 -z(AE +z=안쪽), 회전축은 두께 중심.
  return (
    <group rotation={[(-rotX * Math.PI) / 180, (rotY * Math.PI) / 180, 0]}>
      <mesh
        geometry={geo}
        scale={[1, -1, 1]}
        position={[-group.cx, group.cy, -depth / 2]}
      >
        <meshStandardMaterial color={color} metalness={0.15} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** 압출 텍스트 블록 — ComposedText 의 글리프 자리에 들어간다.
 *  부모가 텍스트 박스 크기를 잡고, 캔버스는 회전 오버행용 여유(BLEED)를 갖는다. */
export function ExtrudedText3D(props: {
  text: string;
  fontWeight?: number | string;
  fontSizePx: number;
  widthPx: number;
  heightPx: number;
  depth: number;
  color: string;
  letterSpacingPx?: number;
  perspective?: number;
  rotX: number;
  rotY: number;
  light: SceneLightSpec | null;
  onUnsupported?: () => void;
}) {
  const { text, fontWeight, fontSizePx, widthPx, heightPx, depth, color, letterSpacingPx, perspective, rotX, rotY, light, onUnsupported } = props;
  const BLEED = 0.45; // 회전/베벨 오버행 여유 (양쪽)
  const cw = Math.ceil(widthPx * (1 + BLEED * 2));
  const ch = Math.ceil(heightPx * (1 + BLEED * 2) + depth);
  const P = perspective ?? 1100;
  // z=P 카메라 + fov = 2 atan(h/2P): z=0 평면 1px=1unit (CSS perspective 등가)
  const fovDeg = (2 * Math.atan(ch / (2 * P)) * 180) / Math.PI;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: cw,
        height: ch,
        marginLeft: -cw / 2,
        marginTop: -ch / 2,
        pointerEvents: "none",
      }}
      data-noboundsdeep="true"
    >
      <ThreeCanvas
        width={cw}
        height={ch}
        style={{ width: cw, height: ch }}
        camera={{ fov: fovDeg, near: 10, far: P + 4000, position: [0, 0, P] }}
        gl={{ alpha: true, antialias: true }}
      >
        <SceneLights light={light} />
        <React.Suspense fallback={null}>
          <TextMesh
            text={text}
            fontUrl={staticFile(fontFileFor(fontWeight))}
            fontSizePx={fontSizePx}
            depth={depth}
            color={color}
            letterSpacingPx={letterSpacingPx ?? 0}
            rotX={rotX}
            rotY={rotY}
            onUnsupported={onUnsupported}
          />
        </React.Suspense>
      </ThreeCanvas>
    </div>
  );
}
