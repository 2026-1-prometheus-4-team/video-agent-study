// ComposedText.tsx
// Entry point for one text element. Validates the spec with safe fallbacks,
// resolves role timings, branches wrapper vs structural rendering and
// delegates Type B effects (glow, motionBlur) to ./effects.
//
// Color has two render paths:
//   - gradient fill -> a continuous background-clip:text gradient on the whole
//     word (color flows within each letter). Letters render transparent.
//   - solid / palette -> per-letter color via letterColor (inside renderLetters).

import { backfaceFor, ExtrudeStack } from "./extrude";
import { ExtrudedText3D } from "./text3d";
import { LightCtx } from "./lighting";
import React from "react";
import { FlowItemCtx } from "./SceneRenderer";
import { rot3d } from "./transform3d";
import { CurveCloneCtx } from "./curve3d";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { EASING, clamp, clamp01, ease, lerp } from "./core/easing";
import {
  resolveTimings,
  type MotionLayer,
  type SceneFit,
  type TimedLayer,
} from "./core/timing";
import { intrinsicForLayer } from "./intrinsic";
import { channelsToCss, composeChannels } from "./wrappers";
import {
  paletteGradientAt,
  wordGradientAt,
  type ColorSpec,
} from "./color/engine";
import {
  STRUCTURAL,
  cursorCss,
  letterScatterStyle,
  letterChoreoState,
  choreoStyle,
  letterStaggerStyle,
  letterFlickerStyle,
  measureText,
  measureTextBox,
  statRevealState,
  renderLetters,
  splitText,
  typewriterVisible,
  unitCount,
  letterRollState,
  LetterReel,
  DEFAULT_ROLL_CHARSET,
  type LetterRollProps,
  type LetterScatterProps,
  type LetterChoreoProps,
  type LetterStaggerProps,
  type LetterFlickerProps,
  type Letter,
  type StatRevealProps,
  type TypewriterProps,
} from "./structural";
import { glowAuraLayers, type GlowSpec } from "./effects/glow";
import { motionBlurDirectional, type MotionBlurSpec } from "./effects/motionBlur";
import { sampleElementKeyframes, type ElementKeyframe, type ElementTiming } from "./keyframes";
import { normalizeFills, paintToCssLayer, singleSolidOf, type FillSpec } from "./fill";

export type TextElementSpec = {
  element: "text";
  id?: string;
  base: {
    text: string;
    fontSize?: number; // vw
    fontWeight?: number;
    fontFamily?: string;
    letterSpacing?: number; // em
    color?: string;
    /** Figma 식 fill 스택 — 글리프 채움(색/그라디언트/이미지/멀티). 단일 solid 는
     *  base.color 와 동일 취급(엔진 색 경로). 우선순위: spec.color > fill > color. */
    fill?: FillSpec;
    position?: { x: number; y: number }; // 0..1, default center
    rotate?: number; // 정적 회전(deg) — 에디터 회전 핸들. wrapper rotate 와 별개.
    /** 요소 3D 자세 — rotateX=위아래 기울기, rotateY=좌우 팬 (deg). 원근 perspective(px). */
    rotateX?: number;
    rotateY?: number;
    perspective?: number;
    /** 앵커. "center"(기본)=position 이 중심 / "left"=position 이 왼쪽 끝 —
     *  타이프라이터가 왼쪽부터 오른쪽으로 자연스럽게 자라난다(실제 입력창처럼). */
    anchor?: "center" | "left";
  };
  color?: ColorSpec;
  layers?: MotionLayer[];
  /** 속성 키프레임 애니메이션(위치·스케일·회전·투명도). AE 식 트랙. */
  keyframes?: ElementKeyframe[];
  /** 클립 트림(씬-로컬 in/out 프레임). 밖이면 숨김, 안이면 애니메이션 자연재생. */
  timing?: ElementTiming;
  effects?: {
    glow?: GlowSpec;
    motionBlur?: MotionBlurSpec;
  };
};

export const ComposedText: React.FC<{
  spec: TextElementSpec;
  sceneFrames: number;
  brand?: { fontFamily?: string };
  fit?: SceneFit;
}> = ({ spec, sceneFrames, brand, fit }) => {
  const rawFrame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const inCurveClone = React.useContext(CurveCloneCtx);
  const flowItem = React.useContext(FlowItemCtx);
  // 글리프 폴백: 폰트에 없는 문자(한글 등)는 three 윤곽 압출 불가 — CSS 판적층으로
  const [glyphFallback, setGlyphFallback] = React.useState(false);
  // Stable per-instance id used for the SVG motion-blur filter. Must be
  // declared above any early returns so the hook order stays fixed.
  const reactId = React.useId();
  const mbFilterId = `mb-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const base = spec.base ?? { text: "" };
  const text = String(base.text ?? "");
  if (!text) return null;

  const letters = splitText(text);
  const totalChars = Math.max(...letters.map((l) => l.charIdx)) + 1;
  const totalWords = Math.max(...letters.map((l) => l.wordIdx)) + 1;
  // 상한 50vw — 히어로 타이틀(화면 폭 대부분을 차는 한 단어)이 20vw 를 훌쩍
  // 넘는다 (실측: 레퍼런스 "Build" ~28vw). 폭주 방지 안전선만 유지.
  const fontSizePx = (clamp(base.fontSize ?? 4, 0.5, 50) / 100) * width;
  // 글리프 채움 — Figma 식 fill 스택(base.fill).
  // 단일 불투명 solid → 그 색을 baseColor 로(팔레트/이펙트 색 경로 유지).
  // 그라디언트/이미지/멀티 스택 → background-clip:text 로 글리프에 클립(글자 투명).
  //   - 글자 span 이 있는 모든 애니메이션 경로에선 "글자별" clip 이어야 한다.
  //     블록 조상에 clip 을 걸면 transform/filter 가 걸린 자손 글자가 클립
  //     마스크에서 빠져 아예 안 그려진다 (paletteGradientStyleFor 와 동일 이유).
  //   - 애니메이터 없는 plain 텍스트는 span 없이 raw text 로 렌더되므로
  //     블록 레벨 clip 사용 (아래 content fallback).
  // spec.color(팔레트 타임라인)가 있으면 그쪽이 우선(엔진 그라디언트 텍스트).
  let baseColor = base.color ?? "#FFFFFF";
  let glyphFillLayers: string[] | null = null;
  if (!spec.color && base.fill != null) {
    const solid = singleSolidOf(base.fill);
    if (solid) baseColor = solid;
    else {
      const layers = normalizeFills(base.fill)
        .slice()
        .reverse() // CSS background 는 첫 레이어가 위 — 우리 배열(바닥→위)의 역순
        .map(paintToCssLayer)
        .filter((l): l is string => !!l);
      if (layers.length > 0) {
        glyphFillLayers = layers;
        baseColor = "transparent";
      }
    }
  }
  const pos = base.position ?? { x: 0.5, y: 0.5 };


  // 클립 트림: [winStart, winEnd) 밖이면 숨김. 안이면 clock 을 winStart 만큼 시프트해
  // 요소 애니메이션을 winLen 길이의 서브-타임라인으로 자연재생(속도 압축 없음).
  const winStart = spec.timing?.start ?? 0;
  const winEnd = spec.timing?.end ?? sceneFrames;
  if (rawFrame < winStart || rawFrame >= winEnd) return null;
  const frame = rawFrame - winStart;
  const winLen = Math.max(1, winEnd - winStart);

  const layers: MotionLayer[] = Array.isArray(spec.layers) ? spec.layers : [];
  const firstStructural = layers.find((l) => STRUCTURAL.has(l.type));
  const uCount = unitCount(
    text,
    (firstStructural?.props?.unit as "char" | "word") ?? "char",
  );
  const timed = resolveTimings(
    layers,
    winLen,
    { fps, unitCount: uCount },
    intrinsicForLayer,
    fit,
  );

  const wrappers = timed.filter((l) => !STRUCTURAL.has(l.type));
  const structurals = timed
    .filter((l) => STRUCTURAL.has(l.type))
    .sort((a, b) => a.startFrame - b.startFrame);

  // Active structural: the latest one whose window has started.
  let active: TimedLayer | null = null;
  for (const s of structurals) {
    if (frame >= s.startFrame) active = s;
  }
  // If NONE of the structurals have started yet (e.g. an "in" layer with a
  // delay that lets a sibling element finish its exit first), the element
  // should be invisible — not rendered at its home position. Return null.
  if (!active && structurals.length > 0) {
    if (structurals.every((s) => frame < s.startFrame)) return null;
    active = structurals[0];
  }
  // Same logic for wrapper-only elements: if every wrapper is still in the
  // future, the element shouldn't render at IDENTITY (full opacity, full
  // scale) — that's a "pre-flash" of the home state before the animation
  // even starts. zoom_cut's emergeText uses a delayed scale wrapper to
  // pin-emerge from 1px; without this guard it would render at scale 1
  // for every frame before its handoff.
  if (
    !active &&
    structurals.length === 0 &&
    wrappers.length > 0 &&
    wrappers.every((w) => frame < w.startFrame)
  ) {
    return null;
  }

  // -------------------------------------------------------------------------
  // Color: gradient path (whole-word background-clip) vs per-letter path
  // -------------------------------------------------------------------------
  // path_in / marquee_rows render their own colored sub-spans, so the
  // whole-word gradient clip does not apply to them.
  // 구조형 모션이 없을 때만 통짜 background-clip 그라데이션 가능
  // (inline-block 글자 span에는 background-clip:text가 안 먹음)
  const plainGradient =
    !active && wordGradientAt(spec.color, frame) !== null;
  const wordGradient = plainGradient ? wordGradientAt(spec.color, frame) : null;
  const gradientActive = wordGradient !== null;

  // Flowing gradients tile (backgroundSize 200% + positionX shift +
  // default background-repeat). If the stop list's first color != last
  // color, the tile seam shows as a HARD vertical boundary as it scrolls
  // — exactly what rotateStops produces when it rotates a non-palindrome
  // stop array. Close the loop by appending the first stop so every tile
  // ends where the next begins, making the seam invisible regardless of
  // rotation. (A non-flowing gradient, flow≈0, is unaffected.)
  const cyclicStops = gradientActive
    ? [...wordGradient.stops, wordGradient.stops[0]]
    : [];
  const gradientStyle: React.CSSProperties = gradientActive
    ? {
        backgroundImage: `linear-gradient(${wordGradient.angle}deg, ${cyclicStops.join(", ")})`,
        backgroundSize: "200% 100%",
        backgroundRepeat: "repeat",
        backgroundPositionX: `${wordGradient.flow.toFixed(1)}px`,
        // 디센더(g/y 꼬리)·어센더까지 배경이 덮이게 박스 확장 — 안 하면
        // line-height 박스 밖 글리프 픽셀이 배경 없음 = 잘려 보임 (실측)
        paddingBottom: "0.3em",
        marginBottom: "-0.3em",
        paddingTop: "0.12em",
        marginTop: "-0.12em",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
        color: "transparent",
      }
    : {};

  // In gradient mode letters must be transparent so the parent gradient shows
  // through. Otherwise letterColor handles solid/palette per letter.
  const letterSpec = gradientActive ? undefined : spec.color;
  // color 채널 — base.color 오버라이드. letterBase 캡처 "전"이어야 렌더에 반영
  // (팔레트 타임라인 spec.color 는 그대로 우선).
  {
    const kfColor = sampleElementKeyframes(spec.keyframes, rawFrame).color;
    if (kfColor && !spec.color) baseColor = kfColor;
  }
  const letterBase = gradientActive ? "transparent" : baseColor;

  // -------------------------------------------------------------------------
  // Channels: wrapper composition + velocity-linked motion blur
  // -------------------------------------------------------------------------
  const ctx = { width, height, fps };
  const channels = composeChannels(wrappers, frame, ctx);
  // 요소 키프레임을 wrapper 채널에 접기: scale 곱, rotate 더함, opacity 곱.
  // (composeChannels 의 규칙과 동일해 wrapper 모션 위에 자연스레 합성됨)
  // 키프레임은 씬-로컬 계약 (keyframes.ts) — 클립 트림 시프트(frame)가 아니라
  // rawFrame 으로 샘플. 트림/분할 시 에디터가 키를 데이터로 옮기는 모델과 일치.
  const kf = sampleElementKeyframes(spec.keyframes, rawFrame);
  channels.scale *= kf.scale * ((spec as { base?: { scale?: number } }).base?.scale ?? 1); // 정적 base.scale (스톱워치 OFF 리사이즈)
  channels.rotate += kf.rotate;
  channels.opacity *= kf.opacity;
  channels.blur += kf.blur + ((spec as { base?: { blur?: number } }).base?.blur ?? 0); // blur 채널(키프레임+정적)
  // 텍스트 blur 는 CSS blur() 가 아니라 SVG 필터로 — 글자별 background-clip
  // 레이어가 각자 블러돼 span 경계에서 세로 이음선이 생기고 번짐이 박스에
  // 갇힌다 (실측: 그라디언트 텍스트 + blur). SVG 필터는 서브트리를 한 장으로
  // 평탄화한 뒤 블러라 이음선 없이 사방으로 번진다.
  const textBlurPx = channels.blur;
  channels.blur = 0;
  const css = channelsToCss(channels, inCurveClone);

  // Directional motion blur applied via SVG feGaussianBlur (CSS blur()
  // is rotationally symmetric and would smudge in all directions). The
  // filter element is rendered next to the text with a per-element id.
  const mb = motionBlurDirectional(
    spec.effects?.motionBlur,
    wrappers,
    frame,
    ctx,
  );
  const mbActive = mb.x > 0.1 || mb.y > 0.1;
  const softBlurActive = textBlurPx > 0.05;
  const finalFilter =
    [mbActive ? `url(#${mbFilterId})` : "", softBlurActive ? `url(#${mbFilterId}-soft)` : "", css.filter ?? ""]
      .filter(Boolean)
      .join(" ") || undefined;

  // Glow runs through the element-wide clone path (glowAuraLayers + clones
  // below). When the spec has wordIdx the clones are tagged with a scoped
  // class so a data-word-idx CSS rule hides the other letters — the blur
  // then only sees the highlight word's rendered pixels.
  const glowWordIdx =
    spec.effects?.glow?.enabled === true
      ? spec.effects.glow.wordIdx
      : undefined;
  const glowMaskClass =
    glowWordIdx !== undefined
      ? `gm-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`
      : null;
  const glowMaskCss = glowMaskClass
    ? `.${glowMaskClass} [data-word-idx]:not([data-word-idx="${glowWordIdx}"]){visibility:hidden}`
    : null;

  // Paint a letter using background-clip:text so its share of the
  // word-wide palette gradient lines up with its neighbours and the
  // gradient flows continuously across the glyphs. Each letter's bg is
  // the full gradient stretched to (wordLen × glyph width) and shifted
  // by its index, so glyph N shows section N of that gradient.
  // base.fill 스택의 글자별 clip 스타일 — 전체 텍스트 폭으로 늘린 배경을
  // 글자 인덱스만큼 왼쪽 시프트해 글리프 N 이 배경의 N 구간을 보이게.
  // (글자 span 자기 자신의 transform 은 배경도 같이 움직이므로 clip 이 유지됨)
  // 글자별 경로의 흐름 오프셋 — 애니메이터 활성 중에도 그라디언트가 흐르게
  const letterFlowPx = frame * ((spec.color as { flowSpeed?: number } | undefined)?.flowSpeed ?? 0);
  const fillGlyphStyleFor = (l: Letter): React.CSSProperties | null => {
    if (!glyphFillLayers) return null;
    const glyphW = fontSizePx * 0.55;
    const textW = Math.max(1, totalChars) * glyphW;
    const offset = l.charIdx * glyphW;
    return {
      backgroundImage: glyphFillLayers.join(", "),
      backgroundSize: `${textW.toFixed(2)}px 100%`,
      backgroundRepeat: "repeat",
      backgroundPositionX: `${(letterFlowPx - offset).toFixed(2)}px`,
      backgroundPositionY: "0",
      paddingBottom: "0.3em",
      marginBottom: "-0.3em",
      paddingTop: "0.12em",
      marginTop: "-0.12em",
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      WebkitTextFillColor: "transparent",
      color: "transparent",
    };
  };

  const paletteGradientStyleFor = (l: Letter): React.CSSProperties | null => {
    const g = paletteGradientAt(letterSpec, frame, l.wordIdx);
    if (!g) return fillGlyphStyleFor(l);
    const len = Math.max(1, l.wordLen);
    // length-based offsets in px (not %) — Chromium's percentage
    // interpretation here is (area - image) × P/100 which interacts
    // unpredictably with inline-block glyph spans of varying widths
    // and leaves middle glyphs unfilled. Approximate the glyph width
    // as fontSize * 0.55 (Inter average) and pin each glyph's bg to
    // its measured offset directly.
    const glyphW = fontSizePx * 0.55;
    const wordW = len * glyphW;
    const offset = l.wordCharIdx * glyphW;
    // 흐름: 순환 스탑(첫 스탑 재추가)으로 타일 이음매 없이 좌우 이동
    const stops = letterFlowPx !== 0 ? [...g.stops, g.stops[0]] : g.stops;
    return {
      backgroundImage: `linear-gradient(${g.angle ?? 90}deg, ${stops.join(", ")})`,
      backgroundSize: `${wordW.toFixed(2)}px 100%`,
      backgroundRepeat: letterFlowPx !== 0 ? "repeat" : "no-repeat",
      backgroundPositionX: `${(letterFlowPx - offset).toFixed(2)}px`,
      backgroundPositionY: "0",
      paddingBottom: "0.3em",
      marginBottom: "-0.3em",
      paddingTop: "0.12em",
      marginTop: "-0.12em",
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      WebkitTextFillColor: "transparent",
      color: "transparent",
    };
  };

  // -------------------------------------------------------------------------
  // content: structural branch or plain letters
  // -------------------------------------------------------------------------
  let content: React.ReactNode = null;
  let extraTextShadow: string | undefined;

  if (active && frame >= active.startFrame - 0.001) {
    const local = Math.max(0, frame - active.startFrame);
    const props = active.props ?? {};

    if (active.type === "typewriter") {
      const p = props as TypewriterProps;
      const state = typewriterVisible(letters, local, fps, p);
      const { lastVisibleCharIdx, unit, shown } = state;
      const cursor = p.cursor ?? "none";
      const trailN = clamp(p.letterFadeTrail ?? 0, 0, 4);
      const gapSettle = p.gapSettle;
      const revealBlur = p.revealBlur;
      const revealBlurFrom = clamp(revealBlur?.from ?? 8, 0, 30);
      const revealBlurDur = clamp(revealBlur?.duration ?? 6, 1, 30);
      // characters_settle: 글자별 scale/rotate 안착(ease-out). revealBlur 와 같은
      // sinceReveal 기준으로, 각자 duration 만큼 작은 사선 -> 정자체로 settle.
      const revealScale = p.revealScale;
      const revealScaleFrom = clamp(revealScale?.from ?? 0.6, 0.1, 3);
      const revealScaleDur = clamp(revealScale?.duration ?? 6, 1, 40);
      const revealRotate = p.revealRotate;
      const revealRotateFrom = clamp(revealRotate?.from ?? 0, -180, 180);
      const revealRotateDur = clamp(revealRotate?.duration ?? 6, 1, 40);
      // characters_settle: 막 등장한 글자가 제자리보다 왼쪽(from em, 음수=이전
      // 글자와 겹침)에서 시작해 ease-out 으로 0 까지 오른쪽으로 미끄러진다.
      const revealX = p.revealX;
      const revealXFrom = clamp(revealX?.from ?? -0.6, -3, 3); // em
      const revealXDur = clamp(revealX?.duration ?? 7, 1, 40);
      // statement/base44 워드 등장: 각 단어가 제자리보다 y(em) 아래에서 시작해
      // ease-out 으로 떠오르며 안착. revealGap(간격 좁아짐) 과 함께 "쫀득" 등장.
      const revealMove = p.revealMove;
      const revealMoveY = clamp(revealMove?.y ?? 0.2, -3, 3); // em, +면 아래->제자리
      const revealMoveDur = clamp(revealMove?.duration ?? 8, 1, 40);
      // freshTint: 최근 등장 글자를 틴트색 -> 본문색으로 식힘 (AI 인풋 레퍼런스)
      const freshTint = p.freshTint;
      const freshTintFade = clamp(freshTint?.fade ?? 14, 1, 90);
      const isType = (p.mode ?? "type") === "type";
      const reflowMode = p.reflow ?? "off";
      const flowMode = p.flow ?? "none";

      // Shared word / space metrics — used by both the per-letter space
      // shrink (revealGap) and the reflow shift cumulative sum.
      const tw_words = text.split(/\s+/).filter(Boolean);
      const tw_fontFam =
        base.fontFamily ?? brand?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif";
      const tw_fontWt = base.fontWeight ?? 500;
      const tw_spaceW = measureText(" ", fontSizePx, tw_fontFam, tw_fontWt);
      const revealGap = p.revealGap;
      const revealGapFrom = clamp(revealGap?.from ?? 2, 0.5, 8);
      const revealGapDur = clamp(revealGap?.duration ?? 10, 1, 60);
      // preReveal — 공개 전 유닛을 고스트(흐림+반투명)로 유지 (숨김 대신)
      const preReveal = p.preReveal;
      const preRevealOp = clamp01(preReveal?.opacity ?? 0.85);
      const preRevealBlur = clamp(preReveal?.blur ?? revealBlurFrom, 0, 40);

      // Per-letter opacity follows the same easeOut(revealBlur.duration)
      // curve as the blur — that way a unit's effective width grows /
      // shrinks continuously and the visible-mass centroid changes
      // smoothly instead of jumping in one frame.
      const rendered = renderLetters(
        letters,
        frame,
        letterBase,
        letterSpec,
        (l) => {
          if (l.isSpace) {
            // reflow:collapse — 다음 단어가 아직 안 보이면 그 앞 공백도 접는다
            // (안 보이는 단어 + 공백을 레이아웃에서 같이 빼야 보이는 단어끼리
            // 빽빽해진다). biasafe 2막-C: 강조어 등장 전엔 그 자리가 0폭.
            if (reflowMode === "collapse" && isType && unit === "word") {
              const nextT = state.unitSchedule[l.wordIdx + 1];
              if (nextT !== undefined && local < nextT) return { display: "none" };
            }
            // revealGap: the space BEFORE word i+1 sits at (from x spaceW)
            // until that word reveals, then shrinks back to spaceW over
            // `duration` frames. splitText stores the trailing space on
            // the previous word's wordIdx, so space.wordIdx is the index
            // of the word it FOLLOWS.
            if (revealGap && isType && l.wordIdx + 1 < tw_words.length) {
              const nextRevealT = state.unitSchedule[l.wordIdx + 1];
              if (nextRevealT !== undefined) {
                const sinceReveal = local - nextRevealT;
                let factor = revealGapFrom;
                if (sinceReveal >= 0) {
                  const t = EASING.easeOut(
                    clamp01(sinceReveal / revealGapDur),
                  );
                  factor = lerp(revealGapFrom, 1, t);
                }
                if (Math.abs(factor - 1) > 0.001) {
                  return {
                    display: "inline-block",
                    width: `${(tw_spaceW * factor).toFixed(2)}px`,
                  };
                }
              }
            }
            return null;
          }
          const idx = unit === "word" ? l.wordIdx : l.charIdx;
          const revealT = state.unitSchedule[idx];
          if (revealT === undefined) return { opacity: isType ? 0 : 1 };
          const sinceReveal = local - revealT;
          let opacity = 1;
          let blurPx = 0;
          if (isType) {
            // reflow:collapse 면 안 보이는 단어를 레이아웃에서 빼서(display none)
            // 보이는 단어끼리 빽빽하게 모은다. 등장 시 폭이 생기며 뒤가 밀리는
            // 자연 reflow(biasafe 2막-C 강조어 portfolio/manager 삽입).
            if (sinceReveal < 0) {
              if (preReveal)
                return {
                  opacity: preRevealOp,
                  filter: `blur(${preRevealBlur.toFixed(1)}px)`,
                };
              return reflowMode === "collapse"
                ? { display: "none" }
                : { opacity: 0 };
            }
            if (revealBlur) {
              const eT = EASING.easeInOut(clamp01(sinceReveal / revealBlurDur));
              // preReveal 이면 고스트 상태에서 이어서 선명해진다 (0 점프 방지)
              opacity = preReveal ? lerp(preRevealOp, 1, eT) : eT;
              blurPx = lerp(preReveal ? preRevealBlur : revealBlurFrom, 0, eT);
            }
          } else {
            // erase: same envelope, mirrored. Letter holds at opacity 1
            // until its scheduled erase frame, then fades over the same
            // duration with a growing blur tail.
            if (sinceReveal < 0) {
              opacity = 1;
            } else if (revealBlur) {
              const eT = EASING.easeInOut(clamp01(sinceReveal / revealBlurDur));
              opacity = 1 - eT;
              blurPx = lerp(0, revealBlurFrom, eT);
            } else {
              opacity = 0;
            }
            if (opacity <= 0.01) return { opacity: 0 };
          }
          if (trailN > 0 && isType) {
            const recency = shown - 1 - idx;
            opacity *= clamp01((recency + 1) / (trailN + 1));
          }
          const out: React.CSSProperties = { opacity };
          if (blurPx > 0.05) out.filter = `blur(${blurPx.toFixed(2)}px)`;
          if (isType && freshTint && sinceReveal >= 0) {
            const t = clamp01(sinceReveal / freshTintFade);
            if (t < 1) {
              const mixHex6 = (a: string, b: string, tt: number): string | null => {
                const rx = /^#([0-9a-fA-F]{6})$/;
                const ma = rx.exec(a.trim());
                const mb = rx.exec(b.trim());
                if (!ma || !mb) return null;
                const na = parseInt(ma[1], 16);
                const nb = parseInt(mb[1], 16);
                const ch = (sh: number) => Math.round(lerp((na >> sh) & 255, (nb >> sh) & 255, tt));
                return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
              };
              const tinted = mixHex6(freshTint.color ?? "#A78BFA", baseColor, t);
              if (tinted) out.color = tinted;
              else if (t < 0.5) out.color = freshTint.color ?? "#A78BFA"; // hex 아님 — 스냅
            }
          }
          // characters_settle: 막 등장한 글자가 작은 사선(scale<1, rotate!=0)에서
          // ease-out 으로 scale 1 / 0deg 로 안착. inline-block 이라야 글자에
          // transform 이 먹는다(글자 중심 기준 회전/축소).
          if (
            isType &&
            sinceReveal >= 0 &&
            (revealX || revealMove || revealScale || revealRotate)
          ) {
            const tf: string[] = [];
            // translateX/Y 를 맨 앞(제일 바깥)에 둔다: scale 보다 먼저 적용돼야
            // 겹침/상승 양(em)이 축소 전 최종 크기 기준으로 계산된다. em 은 글자
            // font-size 기준이라 폰트 크기가 바뀌어도 비율이 유지된다. reflow(char)
            // 의 그룹 좌측 shiftX 와 방향이 맞물린다(글자 개별 슬라이드 + 그룹 밀림).
            if (revealX) {
              const eX = EASING.easeOut(clamp01(sinceReveal / revealXDur));
              tf.push(`translateX(${lerp(revealXFrom, 0, eX).toFixed(3)}em)`);
            }
            if (revealMove) {
              const eY = EASING.easeOut(clamp01(sinceReveal / revealMoveDur));
              tf.push(`translateY(${lerp(revealMoveY, 0, eY).toFixed(3)}em)`);
            }
            if (revealScale) {
              const eS = EASING.easeOut(clamp01(sinceReveal / revealScaleDur));
              tf.push(`scale(${lerp(revealScaleFrom, 1, eS).toFixed(3)})`);
            }
            if (revealRotate) {
              const eR = EASING.easeOut(clamp01(sinceReveal / revealRotateDur));
              tf.push(`rotate(${lerp(revealRotateFrom, 0, eR).toFixed(2)}deg)`);
            }
            if (tf.length) {
              out.transform = tf.join(" ");
              out.display = "inline-block";
            }
          }
          if (gapSettle && isType && sinceReveal >= 0) {
            const t = ease(sinceReveal, gapSettle.duration, "easeOut");
            const extraEm = lerp(gapSettle.from, 1, t) - 1;
            out.letterSpacing = `${extraEm.toFixed(3)}em`;
          }
          const grad = paletteGradientStyleFor(l);
          if (grad) Object.assign(out, grad);
          return out;
        },
        undefined,
        cursor !== "none" ? lastVisibleCharIdx : undefined,
        cursor !== "none"
          ? cursorCss(cursor as "light" | "dark", fontSizePx, frame)
          : undefined,
        // reveal-linked color: 각 글자의 색을 그 단어 등장 후 로컬 프레임으로
        // 평가 -> 막 등장한 단어는 보라, 안착하면 흰으로 (단어마다 staggered).
        // sweepPerLetter 가 있으면 단어 내 글자 위치(wordCharIdx)만큼 추가로
        // 시프트해서 색 띠가 단어 안을 좌->우로 스쳐가는 sweep 을 만든다.
        letterSpec?.revealLinked
          ? (l) => {
              const idx = unit === "word" ? l.wordIdx : l.charIdx;
              const rt = state.unitSchedule[idx] ?? 0;
              const sweep = (letterSpec.sweepPerLetter ?? 0) * l.wordCharIdx;
              // max(0) 안 함: 음수면 색 띠가 아직 이 글자에 도달 전이라
              // letterColor 가 안착색(그라데이션)으로 처리. 띠가 좌->우로 와서 켜진다.
              return local - rt - sweep;
            }
          : undefined,
        // reveal-linked 그라데이션 re-map: 현재 보이는 글자수 기준으로 frac
        // 재계산. 보이는 텍스트 전체 폭에 좌->우 보라->흰 그라데이션이 깔리고,
        // 단어가 추가될수록 앞 단어가 그라데이션 왼쪽(보라)으로 압축된다.
        letterSpec?.revealLinked
          ? (l) => {
              const visN = lastVisibleCharIdx + 1;
              return visN <= 1 ? 0 : l.charIdx / (visN - 1);
            }
          : undefined,
      );

      // Closed-form reflow: each word's contribution is its own
      // easeOut((local - revealFrame_i) / smoothing) ramp, summed every
      // frame. No event-triggered reset means several in-flight reveals
      // overlap smoothly. Applies to both type and erase (with the
      // matching baseline). delta_i is the visible-width swing of word i
      // — for type it's word + leading space; for erase it's word +
      // trailing space (the space that disappears with it).
      let shiftX = 0;
      // anchor:"left" 면 reflow 시프트 없음 — 고정된 왼쪽 edge 에서 오른쪽으로 자란다(입력창 타이핑).
      if (reflowMode === "smooth" && (p.unit ?? "char") === "word" && base.anchor !== "left") {
        const wordWidths = tw_words.map((w) =>
          measureText(w, fontSizePx, tw_fontFam, tw_fontWt),
        );
        const gapCount = Math.max(0, tw_words.length - 1);
        const totalContentWidth =
          wordWidths.reduce((s, w) => s + w, 0) + tw_spaceW * gapCount;
        const smoothing = clamp(p.reflowSmoothing ?? 12, 1, 60);
        const reflowLead = p.reflowLead ?? 0;
        // Baseline carries the initial extra gap width that revealGap
        // adds (each in-between space starts at from x spaceW); that
        // extra width gets eaten back as each gap_progress ramps to 1.
        const extraGapInitial =
          revealGap && isType
            ? ((revealGapFrom - 1) * tw_spaceW * gapCount) / 2
            : 0;
        let acc =
          (isType ? totalContentWidth / 2 : 0) + extraGapInitial;
        // Word contributions (same for type and erase modulo baseline).
        for (let i = 0; i < tw_words.length; i++) {
          const trailingSpace = i < tw_words.length - 1 ? tw_spaceW : 0;
          const delta = -(wordWidths[i] + trailingSpace) / 2;
          const sinceReveal =
            local - ((state.unitSchedule[i] ?? Infinity) - reflowLead);
          const t = clamp01(sinceReveal / smoothing);
          acc += delta * EASING.easeInOut(t);
        }
        // Gap-shrink contributions: each in-between space (wordIdx i,
        // i in [0, N-2]) collapses when word i+1 reveals.
        if (revealGap && isType) {
          const gapDelta = -((revealGapFrom - 1) * tw_spaceW) / 2;
          for (let i = 0; i < gapCount; i++) {
            const sinceReveal =
              local - (state.unitSchedule[i + 1] ?? Infinity);
            const t = clamp01(sinceReveal / revealGapDur);
            acc += gapDelta * EASING.easeOut(t);
          }
        }
        shiftX += acc;
      } else if (reflowMode === "smooth" && unit === "char" && base.anchor !== "left") {
        // char 단위 reflow (오른쪽 끝 앵커): 텍스트의 우측 edge(최종 단어의
        // 오른쪽 끝)를 고정한 채 새 글자가 붙을수록 블록이 왼쪽으로 자란다.
        // -> 첫 글자는 화면 우측(최종 우측 edge)에서 시작, 타이핑될수록 왼쪽
        //    으로 밀리다가 다 등장하면 정중앙에 안착.
        // shiftX = W - 보이는폭. baseline=W, 각 글자 delta=-width 를 등장 프레임
        // 기준 easeOut 램프로 누적 -> 마지막으로 갈수록 느리게 멈춘다(감속 안착).
        // 렌더가 글자마다 inline-block wrapper 라 라인 폭 = Σ(글자 advance) 로
        // measureText 합과 정확히 일치(커닝 없음) -> 끝에서 acc=0, 완벽 재중앙.
        const smoothing = clamp(p.reflowSmoothing ?? 12, 1, 60);
        const reflowLead = p.reflowLead ?? 0;
        // 각 글자의 폭 + 등장 로컬프레임. 공백은 charIdx=-1(스케줄 없음)이라
        // 바로 뒤 non-space 글자의 등장 프레임에 맞춰 같이 램프한다. 뒤에
        // 글자가 없는 후행 공백은 폭 계산에서 제외(acc 가 0 으로 안 닫힘 방지).
        const chUnits: { w: number; revealT: number }[] = [];
        for (let i = 0; i < letters.length; i++) {
          const l = letters[i];
          if (l.isSpace) {
            let nextCharIdx = -1;
            for (let k = i + 1; k < letters.length; k++) {
              if (!letters[k].isSpace) {
                nextCharIdx = letters[k].charIdx;
                break;
              }
            }
            if (nextCharIdx < 0) continue;
            chUnits.push({
              w: tw_spaceW,
              revealT: state.unitSchedule[nextCharIdx] ?? Infinity,
            });
          } else {
            chUnits.push({
              w: measureText(l.ch, fontSizePx, tw_fontFam, tw_fontWt),
              revealT: state.unitSchedule[l.charIdx] ?? Infinity,
            });
          }
        }
        const totalContentWidth = chUnits.reduce((s, u) => s + u.w, 0);
        // baseline=W = 우측 edge 앵커(중앙앵커는 W/2 였음). 각 글자 delta=-width
        // 전체(중앙앵커는 -w/2). 둘 다 2배가 되며 앵커가 중앙->우측으로 이동.
        let acc = isType ? totalContentWidth : 0;
        for (const u of chUnits) {
          const delta = -u.w;
          const sinceReveal = local - (u.revealT - reflowLead);
          const t = clamp01(sinceReveal / smoothing);
          // easeOut = 감속 안착(느리게 멈춤). 마지막 글자 램프가 tail 을 천천히
          // 닫아 블록이 정중앙에 부드럽게 선다("점차 마지막으로 갈수록 느리게").
          acc += delta * EASING.easeOut(t);
        }
        shiftX += acc;
      }

      // Continuous drift independent of reveals.
      if (flowMode !== "none") {
        const speed = p.flowSpeed ?? 0;
        shiftX += (flowMode === "left" ? -1 : 1) * speed * local;
      }

      content =
        shiftX !== 0 ? (
          <span
            style={{
              display: "inline-block",
              transform: `translateX(${shiftX.toFixed(2)}px)`,
            }}
          >
            {rendered}
          </span>
        ) : (
          rendered
        );
    } else if (active.type === "letter_stagger") {
      const p = props as LetterStaggerProps;
      content = renderLetters(letters, frame, letterBase, letterSpec, (l) => {
        const base = letterStaggerStyle(l, totalChars, local, p, baseColor, totalWords);
        const grad = paletteGradientStyleFor(l);
        if (grad) Object.assign(base, grad);
        return base;
      });
    } else if (active.type === "letter_flicker") {
      const p = props as LetterFlickerProps;
      content = renderLetters(letters, frame, letterBase, letterSpec, (l) => {
        const base = letterFlickerStyle(l, totalChars, local, p);
        const grad = paletteGradientStyleFor(l);
        if (grad) Object.assign(base, grad);
        return base;
      });
    } else if (active.type === "letter_scatter") {
      const p = props as LetterScatterProps;
      content = renderLetters(letters, frame, letterBase, letterSpec, (l) => {
        const base = letterScatterStyle(l, totalChars, local, fps, p, {
          width,
          height,
        });
        const grad = paletteGradientStyleFor(l);
        if (grad) Object.assign(base, grad);
        return base;
      });
    } else if (active.type === "letter_choreography") {
      const p = props as LetterChoreoProps;
      content = renderLetters(
        letters,
        frame,
        letterBase,
        letterSpec,
        (l) => {
          const base = choreoStyle(letterChoreoState(l, local, p));
          const grad = paletteGradientStyleFor(l);
          if (grad) Object.assign(base, grad);
          return base;
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (l) => letterChoreoState(l, local, p).char,
      );
    } else if (active.type === "letter_roll") {
      const p = props as LetterRollProps;
      const fam =
        base.fontFamily ?? brand?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif";
      const wt = base.fontWeight ?? 500;
      // Default charset is the UNIQUE NON-SPACE GLYPHS OF THE FINAL TEXT
      // — the reel cycles through letters that actually appear in the
      // word being revealed (no foreign noise glyphs like "7" appearing
      // in MOTION). Caller can override with an explicit `charset` (e.g.
      // full Latin alphabet, katakana). Fall back to the default Latin
      // charset if the text has fewer than 2 unique glyphs (avoid a
      // degenerate single-char reel).
      const uniqueTextChars = Array.from(
        new Set(text.replace(/\s/g, "")),
      ).join("");
      const charset =
        p.charset ??
        (uniqueTextChars.length >= 2 ? uniqueTextChars : DEFAULT_ROLL_CHARSET);
      const seed = p.seed ?? 23;
      const blurFactor = p.blurFactor ?? 4;
      // Slot width = THIS letter's final-glyph width. We deliberately do
      // NOT pin every reel to the charset's widest glyph (that's the
      // scramble trick) because it gives the line a monospace-spaced
      // look, and slot machines want the natural-text spacing the final
      // word would have if you just typed it. Wider noise glyphs are
      // safely clipped left/right by the reel's outer overflow:hidden
      // and vertical motion + blur make the clipping unreadable — the
      // crop reads as "slot window slit", not "broken character".
      //
      // Slot height = TIGHT painted-pixel bbox of (charset + final text)
      // — canvas measureText's actualBoundingBoxAscent + Descent, NOT
      // fontSizePx (the em box has whitespace above the cap and below
      // the descender). Measuring the union of charset + text means
      // every glyph that could ever appear in a slot is fully covered,
      // even with descender chars in the charset (e.g. lowercase g).
      // Falls back to fontSizePx if measureText isn't ready.
      const heightProbe = charset + text;
      const bbox = measureTextBox(heightProbe, fontSizePx, fam, wt);
      const measuredH = bbox.ascent + bbox.descent;
      const slotHeightPx = measuredH > 0 ? measuredH : fontSizePx;
      content = letters.map((l, i) => {
        if (l.isSpace) {
          return (
            <span key={i} data-word-idx={l.wordIdx} style={{ whiteSpace: "pre" }}>
              {" "}
            </span>
          );
        }
        const state = letterRollState(l, local, p);
        const finalW = measureText(l.ch, fontSizePx, fam, wt);
        // SSR / pre-canvas fallback — same idea as the scramble path. A
        // narrow letter (I, 1) would collapse to 0; floor to a sane minimum.
        const slotW = finalW > 0 ? finalW : fontSizePx * 0.3;
        return (
          <LetterReel
            key={i}
            state={state}
            finalChar={l.ch}
            charset={charset}
            seed={seed}
            charIdx={l.charIdx}
            slotWidthPx={slotW}
            slotHeightPx={slotHeightPx}
            color={letterBase}
            blurFactor={blurFactor}
            wordIdx={l.wordIdx}
          />
        );
      });
    } else if (active.type === "stat_reveal") {
      // 강조 숫자 카운트 + 도달 색물듦/빠짐 + suffix characters-settle 등장.
      // 레이아웃: [prefix+숫자][suffix] inline-flex. 숫자 슬롯은 최댓값 폭으로
      // 고정(자릿수 증가 jitter 방지), 그룹 translateX 로 숫자를 중앙->좌측으로
      // 밀어 suffix 자리를 낸다(easeOutBack = 오버슈트 후 우측 바운스 안착).
      const p = props as StatRevealProps;
      const st = statRevealState(local, p);
      const fam =
        base.fontFamily ?? brand?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif";
      const wt = base.fontWeight ?? 500;
      const suffixScale = clamp(p.suffixScale ?? 0.5, 0.1, 1);
      const suffixFontPx = fontSizePx * suffixScale;
      // suffix 없으면 gap 도 0 -> 숫자만 나올 땐 슬라이드 완전 제거(제자리 바운스만).
      const suffixGapPx = st.suffix.length
        ? clamp(p.suffixGap ?? 0.06, 0, 1) * fontSizePx
        : 0;
      // 숫자만의 고정폭(prefix 제외). "+" 는 이 슬롯 앞에 고정, 숫자는 슬롯
      // 안에서만 카운트 -> 자릿수가 바뀌어도 "+" 가 절대 안 움직인다.
      const digitsReserveW = measureText(st.digitsReserve, fontSizePx, fam, wt);
      // affix(prefix) 위치. "right" 면 숫자 뒤에 붙는다(예 55%). 숫자는 affix
      // 쪽으로 정렬 -> affix 는 고정폭 슬롯 밖이라 자릿수가 변해도 안 밀린다.
      const prefixSide = p.prefixSide === "right" ? "right" : "left";
      const digitsAlign = prefixSide === "right" ? "right" : "left";
      const suffixW = measureText(
        st.suffix.map((s) => s.ch).join(""),
        suffixFontPx,
        fam,
        wt,
      );
      const groupShiftPx = (1 - st.slideEased) * ((suffixW + suffixGapPx) / 2);
      content = (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            whiteSpace: "pre",
            transform: `translateX(${groupShiftPx.toFixed(2)}px)`,
          }}
        >
          <span
            style={{
              display: "inline-block",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "pre",
              transform: `scale(${st.numberScale.toFixed(3)})`,
              transformOrigin: "center center",
            }}
          >
            {prefixSide === "left" ? (
              <span style={{ color: baseColor }}>{st.prefix}</span>
            ) : null}
            <span
              style={{
                display: "inline-block",
                width: `${digitsReserveW.toFixed(2)}px`,
                textAlign: digitsAlign,
                color: st.numberColor,
              }}
            >
              {st.digits}
            </span>
            {prefixSide === "right" ? (
              <span style={{ color: baseColor }}>{st.prefix}</span>
            ) : null}
          </span>
          <span
            style={{
              display: "inline-block",
              fontSize: `${suffixScale}em`,
              marginLeft: `${suffixGapPx.toFixed(2)}px`,
            }}
          >
            {st.suffix.map((s, i) => (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  whiteSpace: "pre",
                  opacity: s.opacity,
                  transform: `scale(${s.scale.toFixed(3)}) rotate(${s.rotateDeg.toFixed(2)}deg)`,
                  transformOrigin: "center center",
                  filter:
                    s.blurEm > 0.002
                      ? `blur(${(s.blurEm * suffixFontPx).toFixed(2)}px)`
                      : undefined,
                }}
              >
                {s.ch}
              </span>
            ))}
          </span>
        </span>
      );
    }
  }

  // plain(애니메이터 없는) 텍스트 + fill 스택 → span 없이 raw text 로 렌더해
  // 블록 레벨 background-clip:text 사용. (자손 span 이 없어야 clip 이 유지됨)
  let blockFillStyle: React.CSSProperties | null = null;
  if (content === null) {
    // gradient mode requires the parent to own the text node so
    // background-clip:text can shape the gradient (inline-block child
    // spans are separate block containers and break the clip).
    if (gradientActive) content = text;
    else if (glyphFillLayers) {
      content = text;
      blockFillStyle = {
        backgroundImage: glyphFillLayers.join(", "),
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
        color: "transparent",
      };
    } else content = renderLetters(letters, frame, letterBase, letterSpec);
  }

  // glow: two-layer (core + halo). glowAuraLayers returns 0, 1, or 2 styles.
  const glowStyles = glowAuraLayers(spec.effects?.glow, frame);

  const textBlockStyle: React.CSSProperties = {
    fontSize: fontSizePx,
    fontWeight: base.fontWeight ?? 500,
    fontFamily:
      base.fontFamily ?? brand?.fontFamily ?? "Inter, Helvetica, Arial, sans-serif",
    letterSpacing: base.letterSpacing ? `${base.letterSpacing}em` : undefined,
    whiteSpace: "nowrap",
    textShadow: extraTextShadow,
    lineHeight: 1.1,
    ...gradientStyle,
  };

  // Glow clones share the text style verbatim. filter: blur() (added by
  // glowAuraLayers) works fine on a background-clip:text element — the
  // rendered gradient glyphs blur into a colored bloom that follows the
  // current color (pink stops -> pink halo, white -> white halo).
  const glowBlockStyle: React.CSSProperties = textBlockStyle;

  return (
    <div
      style={{
        // flow(Auto layout) 아이템이면 frame 이 위치의 주인 — in-flow 로 그린다
        ...(flowItem
          ? { position: "relative" as const, flexShrink: 0 }
          : { position: "absolute" as const, left: `${(kf.x ?? pos.x) * 100}%`, top: `${(kf.y ?? pos.y) * 100}%` }),
        // translate3d(0,0,0) keeps a stable GPU layer for the element's whole
        // life (even when css.transform is identity), and willChange +
        // backfaceVisibility complete the GPU-promotion that stops glyph-edge
        // shimmer during scale/translate. css.transform already emits
        // translate3d/scale3d. Mirrors the ComposedLogo pattern.
        // anchor "left": position 이 왼쪽 끝 — 타이핑이 왼쪽부터 자라난다(입력창 재현).
        transform: `${flowItem ? "" : `translate(${base.anchor === "left" ? "0" : "-50%"}, -50%)`}${base.rotate ? ` rotate(${base.rotate}deg)` : ""}${((base as { extrude?: number }).extrude ?? 0) > 0 ? "" : rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY, perspective: base.perspective })}${inCurveClone ? "" : " translate3d(0, 0, 0)"} ${css.transform}`,
        transformOrigin: css.transformOrigin,
        filter: finalFilter,
        opacity: css.opacity,
        // 소프트 마스크 스윕 (masked_reveal) — 그라디언트 마스크가 글리프를 쓸며 리빌
        maskImage: css.maskImage,
        WebkitMaskImage: css.maskImage,
        willChange: inCurveClone ? undefined : "transform, opacity",
        // 뒷면: 90도 넘게 돌 때만 보이게 (평상시 hidden = 글리프 떨림 방지 콤보 유지)
        backfaceVisibility: backfaceFor(kf.rotateX ?? base.rotateX ?? 0, kf.rotateY ?? base.rotateY ?? 0),
        // 압출: perspective "속성" — perspective() 함수는 preserve-3d 자식 z 를
        // 투영하지 못한다 (실측: 72도 기울기에서 스택 붕괴). 회전은 내부 래퍼로.
        perspective: ((base as { extrude?: number }).extrude ?? 0) > 0 ? (base.perspective ?? 1100) : undefined,
      }}
    >
      {(mbActive || softBlurActive) && (
        <svg
          width="0"
          height="0"
          aria-hidden
          style={{ position: "absolute", overflow: "visible" }}
        >
          <defs>
            {mbActive && (
              <filter
                id={mbFilterId}
                x="-50%"
                y="-50%"
                width="200%"
                height="200%"
                colorInterpolationFilters="sRGB"
              >
                <feGaussianBlur
                  stdDeviation={`${mb.x.toFixed(2)} ${mb.y.toFixed(2)}`}
                />
              </filter>
            )}
            {softBlurActive && (
              <filter
                id={`${mbFilterId}-soft`}
                x="-75%"
                y="-75%"
                width="250%"
                height="250%"
                colorInterpolationFilters="sRGB"
              >
                <feGaussianBlur stdDeviation={textBlurPx.toFixed(2)} />
              </filter>
            )}
          </defs>
        </svg>
      )}
      {!inCurveClone && ((base as { extrude?: number }).extrude ?? 0) > 0 ? (
        glyphFallback ? (
          // 폰트 미지원 글리프(한글 등): CSS 판적층 폴백 — 정면~중간 각도용
          <div style={{ position: "relative", transform: rot3d({ rotateX: kf.rotateX ?? base.rotateX, rotateY: kf.rotateY ?? base.rotateY }, true) || undefined, transformStyle: "preserve-3d" }}>
            <ExtrudeStack depth={(base as { extrude?: number }).extrude ?? 0}>
              <div style={{ ...textBlockStyle, ...(blockFillStyle ?? {}), position: "relative" }}>
                {content}
              </div>
            </ExtrudeStack>
          </div>
        ) : (
        // 압출 텍스트 — 진짜 글리프 지오메트리 (AE C4D 방식, three.js
        // ExtrudeGeometry + 베벨 + 씬 라이트). 레이아웃 기준용 투명 텍스트를
        // in-flow 로 유지하고 그 위에 3D 캔버스를 겹친다.
        <div style={{ position: "relative" }}>
          <div style={{ ...textBlockStyle, ...(blockFillStyle ?? {}), position: "relative", opacity: 0 }} aria-hidden>
            {content}
          </div>
          <Text3DOverlay base={base} kf={kf} fontSizePx={fontSizePx} onUnsupported={() => setGlyphFallback(true)} />
        </div>
        )
      ) : (
      <div style={{ position: "relative" }}>
        {glowMaskCss ? <style>{glowMaskCss}</style> : null}
        {glowStyles.map((g, i) => (
          <div
            key={`glow-${i}`}
            aria-hidden
            className={glowMaskClass ?? undefined}
            style={{ ...glowBlockStyle, ...g }}
          >
            {content}
          </div>
        ))}
        <div style={{ ...textBlockStyle, ...(blockFillStyle ?? {}), position: "relative", zIndex: 1 }}>
          {content}
        </div>
      </div>
      )}
    </div>
  );
};

// 압출 텍스트의 3D 캔버스 오버레이 — 부모(relative, 투명 텍스트가 크기를 잡음)
// 위에 겹치는 absolute 레이어. 캔버스 여유 계산용 폭은 근사(0.6em/자 + 자간).
function Text3DOverlay(props: {
  base: { text?: string; fontWeight?: number; fontSize?: number; color?: string; letterSpacing?: number; rotateX?: number; rotateY?: number; perspective?: number; extrude?: number };
  kf: { rotateX: number | null; rotateY: number | null };
  fontSizePx: number;
  onUnsupported?: () => void;
}) {
  const { base, kf, fontSizePx, onUnsupported } = props;
  const light = React.useContext(LightCtx);
  const text = base.text ?? "";
  const lsPx = (base.letterSpacing ?? 0) * fontSizePx;
  const estW = Math.max(fontSizePx, text.length * fontSizePx * 0.6 + Math.max(0, text.length - 1) * lsPx);
  return (
    <div style={{ position: "absolute", left: "50%", top: "50%", width: 0, height: 0 }}>
      <ExtrudedText3D
        text={text}
        fontWeight={base.fontWeight ?? 600}
        fontSizePx={fontSizePx}
        widthPx={estW}
        heightPx={fontSizePx * 1.25}
        depth={base.extrude ?? 0}
        color={typeof base.color === "string" ? base.color : "#F4F6FB"}
        letterSpacingPx={lsPx}
        perspective={base.perspective}
        rotX={kf.rotateX ?? base.rotateX ?? 0}
        rotY={kf.rotateY ?? base.rotateY ?? 0}
        light={light}
        onUnsupported={onUnsupported}
      />
    </div>
  );
}
