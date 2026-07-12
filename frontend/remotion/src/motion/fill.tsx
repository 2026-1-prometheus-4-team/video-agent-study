// fill.tsx
// Figma 식 fill 시스템 — 채울 수 있는 요소(도형/텍스트/frame fill, 씬 배경, 문서 배경)가
// 공유한다. solid / gradient(CSS) / image / video / noise 페인트를 하나의 FillSpec 으로.
//
// 멀티 fill 스택(Figma): fill 은 단일 페인트 또는 페인트 배열. 배열은 **index 0 = 바닥,
// 마지막 = 최상단**으로 아래→위로 합성한다(Figma data 순서와 동일; 에디터 리스트는 역순 표시).
// 각 페인트는 visible/opacity/blend(mix-blend-mode)를 가진다. 스택은 isolation:isolate 로
// 감싸 blend 가 스택 안에서만 합성되게 한다(뒤 씬으로 새지 않게).
//
// 뒤 호환: 그냥 문자열이면 solid 색 또는 CSS 그라디언트. 단일 객체도 그대로 동작.

import React from "react";
import { Video, useVideoConfig, useCurrentFrame } from "remotion";

export type FillFit = "cover" | "contain" | "fill";

// CSS mix-blend-mode 로 그대로 매핑.
export type FillBlend =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light"
  | "difference" | "exclusion" | "hue" | "saturation" | "color" | "luminosity";

// 페인트 공통 필드(객체 변형에 공유).
type PaintCommon = {
  /** 표시 여부. 기본 true. false 면 스택에서 건너뜀. */
  visible?: boolean;
  /** 0..1 페인트 자체 불투명도. */
  opacity?: number;
  /** 블렌드 모드(아래 페인트와 합성). 기본 normal. */
  blend?: FillBlend;
};

export type SolidPaint = PaintCommon & { type: "solid"; color: string };
export type GradientPaint = PaintCommon & { type: "gradient"; css: string };
export type ImagePaint = PaintCommon & {
  type: "image";
  src: string;
  fit?: FillFit;
  posX?: number; // 0..1 배경 위치(크롭 느낌). 기본 0.5
  posY?: number;
};
export type VideoPaint = PaintCommon & {
  type: "video";
  src: string;
  fit?: FillFit;
  trimStart?: number; // 소스 시작(초)
  trimEnd?: number; // 소스 끝(초)
  loop?: boolean;
};
// 노이즈 페인트 — 절차적 그레인. 별도 이미지 없이 SVG feTurbulence 로.
export type NoisePaint = PaintCommon & {
  type: "noise";
  /** 그레인 밀도(0.2~1.5, 클수록 촘촘). 기본 0.65. */
  scale?: number;
  /** 그레인 색(단색). 기본 흰색. */
  color?: string;
};
// 오로라 페인트 — 드리프트하는 radial 블롭(절차적, 결정론). 배경 fill 용.
// 과거 brandDefaults.colors 가 자동 트리거하던 Ad 레벨 오로라를 대체 —
// idle 모션은 명시 옵트인(fill 스택에 이 페인트를 넣을 때만).
export type AuroraPaint = PaintCommon & {
  type: "aurora";
  /** 블롭 색 (스팟에 순환 적용). 생략 시 기본 팔레트. */
  colors?: string[];
  /** 드리프트 속도 배수. 0 = 정적(부분 방사형 글로우). 기본 1. */
  speed?: number;
  /** 방사형 스팟 개수 (1~6). 기본 3. */
  spots?: number;
  /** 배치 시드 — 지정 시 결정론적 "랜덤" 배치. 없으면 기본 수동 배치. */
  seed?: number;
};

/** 단일 페인트 또는 페인트 스택. */
export type FillPaint =
  | string
  | SolidPaint
  | GradientPaint
  | ImagePaint
  | VideoPaint
  | NoisePaint
  | AuroraPaint;
export type FillSpec = FillPaint | FillPaint[];

const fitToSize: Record<FillFit, string> = { cover: "cover", contain: "contain", fill: "100% 100%" };
const fitToObject: Record<FillFit, React.CSSProperties["objectFit"]> = { cover: "cover", contain: "contain", fill: "fill" };

// 페인트 하나를 절대 레이어로 렌더. blend/opacity 는 여기서 건다.
const SinglePaint: React.FC<{ paint: FillPaint; radius?: number | string }> = ({ paint, radius }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  if (typeof paint === "string") {
    return <div style={{ position: "absolute", inset: 0, background: paint, borderRadius: radius }} />;
  }
  if (paint.visible === false) return null;

  const common: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    opacity: paint.opacity ?? 1,
    mixBlendMode: paint.blend && paint.blend !== "normal" ? paint.blend : undefined,
    borderRadius: radius,
  };

  if (paint.type === "solid") {
    return <div style={{ ...common, background: paint.color }} />;
  }
  if (paint.type === "gradient") {
    return <div style={{ ...common, background: paint.css }} />;
  }
  if (paint.type === "image") {
    if (!paint.src) return null; // 소스 미지정 (타입 전환 직후) — 빈 레이어
    const fit = paint.fit ?? "cover";
    return (
      <div
        style={{
          ...common,
          backgroundImage: `url(${paint.src})`,
          backgroundSize: fitToSize[fit],
          backgroundPosition: `${(paint.posX ?? 0.5) * 100}% ${(paint.posY ?? 0.5) * 100}%`,
          backgroundRepeat: "no-repeat",
        }}
      />
    );
  }
  if (paint.type === "video") {
    if (!paint.src) return null; // 소스 미지정 — Remotion <Video> 는 빈 src 에 throw
    const fit = paint.fit ?? "cover";
    const startFrom = paint.trimStart != null ? Math.round(paint.trimStart * fps) : undefined;
    const endAt = paint.trimEnd != null ? Math.round(paint.trimEnd * fps) : undefined;
    return (
      <div style={{ ...common, overflow: "hidden" }}>
        <Video
          src={paint.src}
          startFrom={startFrom}
          endAt={endAt}
          loop={paint.loop ?? true}
          muted
          style={{ width: "100%", height: "100%", objectFit: fitToObject[fit] }}
        />
      </div>
    );
  }
  if (paint.type === "noise") {
    // SVG feTurbulence 그레인 — 반투명 오버레이(불투명 색 채움 X). 결정론적(프레임 무관).
    // grain 자체는 회색조. paint.opacity + blend(soft-light/multiply)로 아래에 살짝 얹힌다.
    const s = Math.max(0.1, Math.min(2, paint.scale ?? 0.65));
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'>` +
      `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${s}' numOctaves='2' stitchTiles='stitch'/>` +
      `<feColorMatrix type='saturate' values='0'/></filter>` +
      `<rect width='140' height='140' filter='url(%23n)'/></svg>`;
    return (
      <div
        style={{
          ...common,
          backgroundImage: `url("data:image/svg+xml,${svg}")`,
          backgroundRepeat: "repeat",
          backgroundSize: "140px 140px",
        }}
      />
    );
  }
  if (paint.type === "aurora") {
    // 컨테이너 % 기반 — 씬 배경뿐 아니라 frame/도형 fill 에서도 크기가 맞는다.
    // frame 만 입력으로 쓰는 순수 함수 (결정론 렌더 안전).
    const colors = paint.colors && paint.colors.length > 0 ? paint.colors : ["#7C4DFF", "#52C5FF", "#FF4D9D"];
    const sp = paint.speed ?? 1;
    const spotsN = Math.max(1, Math.min(6, Math.round(paint.spots ?? 3)));
    // 배치: seed 지정 시 mulberry32 결정론 "랜덤", 아니면 수동 튜닝 기본 3점
    const BASE = [
      { x: 25, y: 70, ph: 0, r: 55 },
      { x: 75, y: 30, ph: 2.1, r: 55 },
      { x: 50, y: 55, ph: 4.2, r: 55 },
    ];
    let spots: { x: number; y: number; ph: number; r: number }[];
    if (paint.seed != null || spotsN !== 3) {
      let a = (paint.seed ?? 1) >>> 0;
      const rand = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      spots = Array.from({ length: spotsN }, () => ({
        x: 10 + rand() * 80,
        y: 10 + rand() * 80,
        ph: rand() * 6.283,
        r: 38 + rand() * 34,
      }));
    } else {
      spots = BASE.slice(0, spotsN);
    }
    return (
      <div style={{ ...common, overflow: "hidden" }}>
        {spots.map((bp, i) => {
          const c = colors[i % colors.length];
          const x = bp.x + (sp === 0 ? 0 : Math.sin((frame * sp) / 90 + bp.ph) * 6);
          const y = bp.y + (sp === 0 ? 0 : Math.cos((frame * sp) / 110 + bp.ph) * 5);
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${x}%`,
                top: `${y}%`,
                width: `${bp.r}%`,
                aspectRatio: "1",
                transform: "translate(-50%, -50%)",
                background: `radial-gradient(circle, ${c} 0%, transparent 70%)`,
                opacity: 0.09,
                filter: "blur(40px)",
              }}
            />
          );
        })}
      </div>
    );
  }
  return null;
};

// fill(단일 또는 스택)을 요소 전체를 채우는 절대 레이어로 렌더.
// 부모가 overflow:hidden + radius 로 클립. 스택은 isolation:isolate 로 blend 격리.
export const FillLayer: React.FC<{ fill?: FillSpec; radius?: number | string }> = ({ fill, radius }) => {
  const paints = normalizeFills(fill);
  if (paints.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, isolation: "isolate", borderRadius: radius }}>
      {paints.map((p, i) => (
        <SinglePaint key={i} paint={p} radius={radius} />
      ))}
    </div>
  );
};

/** fill 을 페인트 배열로 정규화(단일 → [단일], none → []). */
export function normalizeFills(fill: FillSpec | undefined): FillPaint[] {
  if (fill == null || fill === "") return [];
  return Array.isArray(fill) ? fill.filter((p) => p != null && p !== "") : [fill];
}

// fill 이 "비어있음"(none) 인지
export function isEmptyFill(fill: FillSpec | undefined): boolean {
  return normalizeFills(fill).length === 0;
}

// hex(#rgb/#rrggbb) → rgba 문자열 (opacity 반영). 그 외 형식은 그대로.
function withAlpha(color: string, opacity?: number): string {
  const a = opacity ?? 1;
  if (a >= 1 || !color.startsWith("#")) return color;
  let h = color.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** 페인트 → CSS <image> 값 (텍스트 glyph clip 의 backgroundImage 레이어 용).
 *  size/position 은 호출부가 별도 프로퍼티로 지정하므로 shorthand 금지.
 *  video/noise 는 텍스트 클립 미지원 → null. 배열 렌더 시 호출부가 역순(위→아래)로. */
export function paintToCssLayer(p: FillPaint): string | null {
  if (typeof p === "string") {
    if (p === "") return null;
    return p.includes("gradient(") ? p : `linear-gradient(${p}, ${p})`;
  }
  if (p.visible === false) return null;
  if (p.type === "solid") {
    const c = withAlpha(p.color, p.opacity);
    return `linear-gradient(${c}, ${c})`;
  }
  if (p.type === "gradient") return p.css;
  if (p.type === "image") return `url("${p.src}")`;
  return null;
}

/** fill 이 "단일 불투명 solid 색"이면 그 색을 반환(엔진 색 경로 유지용). 아니면 null. */
export function singleSolidOf(fill: FillSpec | undefined): string | null {
  const ps = normalizeFills(fill);
  if (ps.length !== 1) return null;
  const p = ps[0];
  if (typeof p === "string") return p.includes("gradient(") ? null : p;
  if (p.type === "solid" && (p.opacity ?? 1) >= 1 && p.visible !== false) return p.color;
  return null;
}
