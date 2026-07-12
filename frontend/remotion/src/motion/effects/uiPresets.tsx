// uiPresets — 웹 UI 트렌드 컴포넌트의 "영상판" preset element 모음.
//
// 원본 레퍼런스(Aceternity GlowingEffect 카드, glow menu 등)는 마우스 hover
// 기반 인터랙티브 컴포넌트다. 여기서는 그 기법(글로우 테두리, radial 글로우,
// glass 표면)을 프레임 기반 + JSON 파라미터로 번역한다:
//   hover 각도 추적  -> orbit(시간 기반 궤도, effects/orbitGlow.tsx 공유)
//   hover 활성화     -> active 스텝 키({frame, index}) / 등장 램프
// LLM 이 spec JSON 만 뱉으면 되고, 모션 knob 은 사람/LLM 이 수정한다.

import React from "react";
import { useVideoConfig } from "remotion";
import { EASING, clamp01, lerp } from "../core/easing";
import { orbitArcRects, glowFilter, type OrbitSpec } from "./orbitGlow";
import { rampT, type DrawRamp } from "./designverse";
import { usePresetTransform, presetWrapStyle, type PresetBase } from "./presetTransform";
import type { ElementKeyframe, ElementTiming } from "../keyframes";

const SANS = "General Sans, Inter, Helvetica, Arial, sans-serif";

// ---------------------------------------------------------------- glow_card

export type GlowCardSpec = {
  element: "glow_card";
  id?: string;
  // 에디터 표준 transform — base.position/width/height 우선, top-level 은 폴백
  base?: PresetBase;
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
  // 지오메트리(vw)
  width?: number;
  height?: number;
  radius?: number; // vw. 기본 1.3
  position?: { x: number; y: number }; // 0..1. 기본 0.5/0.5
  // glass 표면
  fillColor?: string; // 기본 rgba(16,13,24,0.62)
  glass?: number; // backdrop blur px. 기본 14. 0 이면 없음
  hairline?: string; // 안쪽 얇은 테두리. 기본 rgba(255,255,255,0.09)
  sheen?: number; // 위쪽 하이라이트 0..1. 기본 0.5
  // 테두리 글로우 — orbit 지정 시 혜성이 돌고, 아니면 정적 그라데이션 링
  borderWidth?: number; // px. 기본 3
  orbit?: OrbitSpec;
  borderColors?: [string, string]; // 기본 보라 계열
  glow?: number; // 0..1. 기본 0.8
  // 콘텐츠(선택) — 아이콘 박스(위) + 타이틀/설명(아래), 레퍼런스 카드 배치
  icon?: string; // 이모지/글리프
  title?: string;
  description?: string;
  titleSize?: number; // vw. 기본 1.5
  descSize?: number; // vw. 기본 1.0
  titleColor?: string; // 기본 #F4F1FA
  descColor?: string; // 기본 rgba(228,222,244,0.55)
  padding?: number; // vw. 기본 1.6
  fontFamily?: string;
  // 등장/퇴장
  fadeIn?: DrawRamp;
  rise?: number; // fadeIn 동안 아래에서 올라오는 거리(vw). 기본 0
  fadeOut?: DrawRamp;
};

export const GlowCard: React.FC<{ spec: GlowCardSpec }> = ({ spec }) => {
  const t = usePresetTransform(spec);
  const { width, height } = useVideoConfig();
  const vw = (v: number) => (v / 100) * width;
  const frame = t.frame;

  const w = vw(spec.base?.width ?? spec.width ?? 22);
  const h = vw(spec.base?.height ?? spec.height ?? 15);
  const r = vw(spec.radius ?? 1.3);
  const bw = spec.borderWidth ?? 3;
  const pos = t.pos;
  const [c1, c2] = spec.borderColors ?? ["#B47CFF", "#7C3AED"];
  const glow = spec.glow ?? 0.8;

  const inT = rampT(frame, spec.fadeIn);
  const fade = inT * (1 - rampT(frame, spec.fadeOut, 0)) * t.opacity;
  const riseY = spec.rise ? (1 - EASING.easeOut(inT)) * vw(spec.rise) : 0;

  const pad = vw(spec.padding ?? 1.6);
  const gradId = React.useId();
  if (!t.visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: pos.x * width - w / 2,
        top: pos.y * height - h / 2,
        width: w,
        height: h,
        opacity: fade,
        ...presetWrapStyle(t),
        transform: [presetWrapStyle(t).transform, riseY > 0.05 ? `translateY(${riseY.toFixed(1)}px)` : undefined]
          .filter(Boolean)
          .join(" ") || undefined,
      }}
    >
      {/* glass 표면 — fill + backdrop blur + 위쪽 sheen + 안쪽 hairline */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: r,
          background: spec.fillColor ?? "rgba(16,13,24,0.62)",
          backdropFilter: (spec.glass ?? 14) > 0 ? `blur(${spec.glass ?? 14}px)` : undefined,
          boxShadow: `inset 0 0 0 1px ${spec.hairline ?? "rgba(255,255,255,0.09)"}`,
        }}
      />
      {(spec.sheen ?? 0.5) > 0 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: r,
            background: `linear-gradient(175deg, rgba(255,255,255,${(0.07 * (spec.sheen ?? 0.5)).toFixed(3)}) 0%, transparent 38%)`,
          }}
        />
      )}
      {/* 테두리 글로우 — orbit 혜성 또는 정적 그라데이션 링 */}
      <svg
        width={w}
        height={h}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {spec.orbit ? (
          <>
            {/* dim 베이스 링 — 빛이 없는 구간의 희미한 림. borderWidth 는
                하이라이트 최대 두께라서 그대로 쓰면 뚱뚱한 테두리가 된다
                (실측: 검정 12px 링이 디자인을 잡아먹음) — 얇게 고정. */}
            {spec.orbit.dim && (
              <rect
                x={bw / 2}
                y={bw / 2}
                width={w - bw}
                height={h - bw}
                rx={Math.max(0, r - bw / 2)}
                fill="none"
                stroke={spec.orbit.dim}
                strokeWidth={Math.max(1.2, bw * 0.16)}
              />
            )}
            {orbitArcRects({
              orb: spec.orbit,
              frame,
              x: bw / 2,
              y: bw / 2,
              w: w - bw,
              h: h - bw,
              r: Math.max(0, r - bw / 2),
              bw,
              glow,
              opacity: fade > 0 ? 1 : 0,
              fallback: [c1, c2],
            })}
          </>
        ) : (
          <>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={c1} />
                <stop offset="100%" stopColor={c2} />
              </linearGradient>
            </defs>
            <rect
              x={bw / 2}
              y={bw / 2}
              width={w - bw}
              height={h - bw}
              rx={Math.max(0, r - bw / 2)}
              fill="none"
              stroke={`url(#${gradId})`}
              strokeWidth={bw}
              style={{ filter: glowFilter(c1, glow) }}
            />
          </>
        )}
      </svg>
      {/* 콘텐츠 — 아이콘 박스(위) / 타이틀+설명(아래) */}
      {(spec.icon || spec.title || spec.description) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: pad,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            fontFamily: spec.fontFamily ?? SANS,
            borderRadius: r,
            overflow: "hidden",
          }}
        >
          {spec.icon ? (
            <div
              style={{
                width: vw(2.6),
                height: vw(2.6),
                borderRadius: vw(0.55),
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.04)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: vw(1.3),
              }}
            >
              {spec.icon}
            </div>
          ) : (
            <div />
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: vw(0.5) }}>
            {spec.title && (
              <div
                style={{
                  fontSize: vw(spec.titleSize ?? 1.5),
                  fontWeight: 600,
                  letterSpacing: "-0.02em",
                  color: spec.titleColor ?? "#F4F1FA",
                  lineHeight: 1.15,
                }}
              >
                {spec.title}
              </div>
            )}
            {spec.description && (
              <div
                style={{
                  fontSize: vw(spec.descSize ?? 1.0),
                  fontWeight: 400,
                  color: spec.descColor ?? "rgba(228,222,244,0.55)",
                  lineHeight: 1.4,
                }}
              >
                {spec.description}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------- glow_menu

export type GlowMenuItem = {
  label: string;
  icon?: string; // 이모지/글리프
  color?: string; // 활성 글로우 색. 기본 팔레트 순환
};

export type GlowMenuSpec = {
  element: "glow_menu";
  id?: string;
  // 에디터 표준 transform — base.position/scale 우선, top-level 은 폴백
  base?: PresetBase;
  keyframes?: ElementKeyframe[];
  timing?: ElementTiming;
  items: GlowMenuItem[];
  position?: { x: number; y: number }; // 0..1. 기본 0.5/0.5
  height?: number; // vw. 기본 3.4
  fontSize?: number; // vw. 기본 1.05
  gap?: number; // vw. 아이템 간격. 기본 0.4
  radius?: number; // vw. 컨테이너 라운드. 기본 1.2
  fillColor?: string; // 기본 rgba(14,12,20,0.72)
  glass?: number; // backdrop blur px. 기본 12
  hairline?: string; // 기본 rgba(255,255,255,0.08)
  // 활성 항목 스텝 키 — frame 부터 index 가 활성. hover 의 시간 기반 번역.
  active?: { frame: number; index: number }[]; // 기본 [{frame:0, index:0}]
  switchDuration?: number; // 전환 프레임. 기본 10
  labelColor?: string; // 비활성. 기본 rgba(235,230,248,0.5)
  activeLabelColor?: string; // 기본 #FFFFFF
  fadeIn?: DrawRamp;
  fontFamily?: string;
};

const MENU_PALETTE = ["#5B8CFF", "#F97316", "#22C55E", "#EF4444", "#A855F7"];

// hex -> rgba 문자열 (radial 글로우용)
function withAlpha(hex: string, a: number): string {
  const six = /^#[0-9a-fA-F]{6}$/;
  if (!six.test(hex)) return hex;
  const p = parseInt(hex.slice(1), 16);
  return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${a.toFixed(3)})`;
}

export const GlowMenu: React.FC<{ spec: GlowMenuSpec }> = ({ spec }) => {
  const t = usePresetTransform(spec);
  const { width, height } = useVideoConfig();
  const vw = (v: number) => (v / 100) * width;
  const frame = t.frame;

  const pos = t.pos;
  const hPx = vw(spec.height ?? 3.4);
  const fontPx = vw(spec.fontSize ?? 1.05);
  const gapPx = vw(spec.gap ?? 0.4);
  const rPx = vw(spec.radius ?? 1.2);
  const fade = rampT(frame, spec.fadeIn) * t.opacity;
  const switchDur = Math.max(1, spec.switchDuration ?? 10);
  if (!t.visible) return null;

  // 활성 스텝 키: 현재/직전 활성 인덱스 + 전환 진행도
  const keys = (spec.active?.length ? [...spec.active] : [{ frame: 0, index: 0 }]).sort(
    (a, b) => a.frame - b.frame,
  );
  let cur = keys[0];
  let prev: { frame: number; index: number } | null = null;
  for (const k of keys) {
    if (k.frame <= frame) {
      if (k.index !== cur.index) prev = cur;
      cur = k;
    }
  }
  const swT = EASING.easeOut(clamp01((frame - cur.frame) / switchDur));

  const wrap = presetWrapStyle(t);
  return (
    <div
      style={{
        position: "absolute",
        left: pos.x * width,
        top: pos.y * height,
        transform: ["translate(-50%, -50%)", wrap.transform].filter(Boolean).join(" "),
        filter: wrap.filter,
        opacity: fade,
        display: "flex",
        alignItems: "center",
        gap: gapPx,
        padding: `${(hPx * 0.16).toFixed(1)}px ${(hPx * 0.2).toFixed(1)}px`,
        borderRadius: rPx,
        background: spec.fillColor ?? "rgba(14,12,20,0.72)",
        backdropFilter: (spec.glass ?? 12) > 0 ? `blur(${spec.glass ?? 12}px)` : undefined,
        boxShadow: `inset 0 0 0 1px ${spec.hairline ?? "rgba(255,255,255,0.08)"}, 0 10px 34px rgba(0,0,0,0.4)`,
        fontFamily: spec.fontFamily ?? SANS,
      }}
    >
      {spec.items.map((item, i) => {
        const color = item.color ?? MENU_PALETTE[i % MENU_PALETTE.length];
        // 이 항목의 활성도: 켜지는 중(swT) / 꺼지는 중(1-swT) / 유지(1) / 꺼짐(0)
        const a = i === cur.index ? swT : prev && i === prev.index ? 1 - swT : 0;
        // 켜지는 항목만 라벨 3D 플립(레퍼런스 rotateX) — 유지 상태에선 0
        const flip = i === cur.index && prev ? (1 - swT) * 60 : 0;
        return (
          <div
            key={i}
            style={{
              position: "relative",
              padding: `${(hPx * 0.18).toFixed(1)}px ${(hPx * 0.34).toFixed(1)}px`,
              borderRadius: rPx * 0.72,
              perspective: 500,
            }}
          >
            {/* 활성 radial 글로우 — hover glowVariants 의 시간판 */}
            {a > 0.001 && (
              <div
                style={{
                  position: "absolute",
                  inset: `-${(hPx * 0.5).toFixed(1)}px`,
                  borderRadius: rPx,
                  background: `radial-gradient(circle at 50% 60%, ${withAlpha(color, 0.28 * a)} 0%, ${withAlpha(color, 0.1 * a)} 45%, transparent 75%)`,
                  transform: `scale(${lerp(0.75, 1, a).toFixed(3)})`,
                }}
              />
            )}
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: fontPx * 0.45,
                fontSize: fontPx,
                fontWeight: 500,
                color:
                  a > 0.5
                    ? (spec.activeLabelColor ?? "#FFFFFF")
                    : (spec.labelColor ?? "rgba(235,230,248,0.5)"),
                transform: flip > 0.5 ? `rotateX(${flip.toFixed(1)}deg)` : undefined,
                transformOrigin: "center bottom",
                transformStyle: "preserve-3d",
              }}
            >
              {item.icon && (
                <span style={{ fontSize: fontPx * 1.05, color: a > 0.5 ? color : undefined }}>
                  {item.icon}
                </span>
              )}
              <span>{item.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
