// presets/transition/zoom_cut.ts
// Camera-dolly zoom transition. ONE scene, ends with hard_cut.
//
// The front word (fromText) scales up with easeInBoost — already moving
// on frame 1 (slope 0.4 at t=0) and accelerating to slope 1.6 by t=1.
// No fade, no decelerating tail; its strokes simply exit the viewport
// as scale grows.
//
// Optional second element: emergeText. When set, the back word pin-
// emerges from a literal `emergeStartPx`-sized dot at viewport centre,
// starting at `emergeAt` fraction of the scene, scaling easeOut to its
// natural size. ComposedText hides it (returns null) until the delayed
// scale wrapper fires, so it doesn't pre-flash at scale 1.
//
// EMERGE-style compositions: place a follow-up scene with the SAME
// background color. The viewport at scene-end is filled with the front
// word's negative interior (= bg color), so the hard cut is invisible
// and the next scene reads as continuous.
//
// CUT-style compositions: place a follow-up scene with a DIFFERENT
// background color (e.g. white). The cut is visible as a flash; the
// follow-up scene handles its own entry animation.
//
// Emerge is NOT a separate preset — it's just zoom_cut with emergeText
// set. Two patterns, one preset, one set of zoom params shared.

import type { SceneSpec } from "../../motion/SceneRenderer";
import type { TextElementSpec } from "../../motion/ComposedText";
import {
  clampFontWeight,
  type CommonKnobs,
  type PresetCtx,
} from "../shared/types";
import { clamp, clamp01 } from "../../motion/core/easing";

export type ZoomCutKnobs = CommonKnobs & {
  fromText: string;
  baseColor?: string;
  // Zoom velocity in *scale units per second*. The terminal scale is
  // derived as 1 + zoomSpeed * durationSec, so the same zoomSpeed value
  // produces the same visual "feel" regardless of duration — duration
  // only controls how long the zoom runs, not how aggressive it is.
  // Default 100/s: a 1.0s scene grows to ~101x, a 0.5s scene to ~51x.
  zoomSpeed?: number;
  duration?: number;         // ZOOM duration in seconds. default 1.0
  // Seconds the front word holds at rest (scale 1) BEFORE the zoom begins,
  // so the viewer can read it. default 0.6. The scene's total length is
  // hold + zoom (+ emerge dwell when emergeText is set).
  hold?: number;
  focal?: { x: number; y: number }; // 0..1, default 0.5/0.5

  // Optional emerge text overlay.
  emergeText?: string | null;
  emergeAt?: number;         // 0..1 fraction of the ZOOM phase. default 0.55
  emergeStartPx?: number;    // first-frame bbox pixel size. default 1
};

const DEFAULT_ZOOM_SPEED = 100;
const DEFAULT_DURATION_SEC = 0.9;
const DEFAULT_HOLD_SEC = 0.3; // 죽은 시간 줄임 — 짧게 읽고 바로 빨려듦
const DEFAULT_EMERGE_AT = 0.55;
const DEFAULT_EMERGE_START_PX = 1;
// Terminal scale. 글자 선명도 위해 "큰 폰트로 렌더 후 scale<=1로 축소" 방식을 쓰므로
// (업스케일 픽셀 깨짐 방지) 최종 폰트는 fontSize*zoomScale 로 렌더된다. 따라서
// zoomScale 이 너무 크면 폰트가 비현실적으로 커지니 ~12 로 캡. 12배면 "단어 속으로
// 들어가는" 다이브가 이미 충분히 나오고 컷이 걸린다. 200배는 픽셀 지옥의 원인이었음.
const ZOOM_SCALE_MIN = 2;
const ZOOM_SCALE_MAX = 12;
// Emerge timing: grow from the dot over GROW frames, then DWELL at full
// size so the back word is actually readable before the cut (the old code
// finished growing exactly at scene-end, leaving zero hold).
const EMERGE_GROW_FRAMES = 10;
const EMERGE_DWELL_FRAMES = 16;

export function zoomCut(knobs: ZoomCutKnobs, ctx: PresetCtx): SceneSpec {
  const fps = 24;
  const fontSize = knobs.fontSize ?? 12;
  const fontWeight = clampFontWeight(knobs.fontWeight, 700);
  const color = knobs.baseColor ?? "#FFFFFF";
  const focal = knobs.focal ?? { x: 0.5, y: 0.5 };
  const brandFont = knobs.fontFamily ?? ctx.brand.fontFamily;
  const zoomSec = knobs.duration ?? DEFAULT_DURATION_SEC;
  const zoomFrames = Math.max(6, Math.round(zoomSec * fps));
  const holdFrames = Math.max(0, Math.round((knobs.hold ?? DEFAULT_HOLD_SEC) * fps));
  // Internal: terminal scale derived from zoomSpeed. zoomSpeed is the
  // *speed* knob (scale per second). Clamped to a sane range so a wild
  // value doesn't break the rasteriser.
  const zoomSpeed = Math.max(0, knobs.zoomSpeed ?? DEFAULT_ZOOM_SPEED);
  const zoomScale = clamp(
    1 + zoomSpeed * zoomSec,
    ZOOM_SCALE_MIN,
    ZOOM_SCALE_MAX,
  );

  const baseStyle = {
    fontSize,
    fontWeight,
    color,
    position: focal,
    ...(brandFont ? { fontFamily: brandFont } : {}),
  };
  // 선명도: 글자를 작게 렌더하고 위로 키우면(scale>1) 래스터가 업스케일돼 픽셀이
  // 깨진다. 대신 *최종 큰 크기*(fontSize*zoomScale)로 렌더하고 scale 을 1/zoomScale
  // -> 1 로 *축소만* 한다(scale<=1 은 항상 선명). 끝 프레임(scale=1)이 화면을
  // 채우는 네이티브 큰 렌더 = 선명.
  const fromStyle = { ...baseStyle, fontSize: fontSize * zoomScale };

  // Front word: ONE scale layer spanning hold + zoom. dwellFrac keeps it
  // at scale 1 (readable) for the hold, then easeInBoost zooms it to
  // zoomScale. Single layer (no delayed sibling) guarantees the glyphs
  // render from frame 0 — the earlier delay approach left the hold blank.
  // A fade over the zoom tail dissolves the word as it flies past so it
  // doesn't end as a screen-filling blob that occludes the emerge text.
  const fromSpan = holdFrames + zoomFrames;
  const fromEl: TextElementSpec = {
    element: "text",
    id: "from",
    base: { text: knobs.fromText, ...fromStyle },
    layers: [
      {
        type: "scale",
        role: "in",
        props: {
          // 큰 네이티브 렌더를 1/zoomScale(읽기 크기)에서 1(화면 채움)까지 *축소만*.
          from: 1 / zoomScale,
          to: 1,
          duration: fromSpan,
          dwellFrac: fromSpan > 0 ? holdFrames / fromSpan : 0,
          easing: "easeInBoost",
          origin: { x: 0.5, y: 0.5 },
        },
      },
      {
        type: "fade",
        role: "in",
        props: {
          mode: "out",
          duration: Math.max(4, Math.round(zoomFrames * 0.5)),
          delay: holdFrames + Math.round(zoomFrames * 0.5),
          easing: "easeIn",
        },
      },
    ],
  };

  const elements: TextElementSpec[] = [fromEl];
  // Scene length grows if the emerge dwell needs more room than hold+zoom.
  let totalFrames = holdFrames + zoomFrames;

  // Optional emerge text. Only rendered when emergeText is a non-empty string.
  const emergeText =
    typeof knobs.emergeText === "string" ? knobs.emergeText : "";
  if (emergeText) {
    const emergeAt = clamp01(knobs.emergeAt ?? DEFAULT_EMERGE_AT);
    // Emerge starts partway through the zoom (fraction of the zoom phase,
    // offset past the hold), grows over GROW frames, then DWELLS so it's
    // readable. The scene is extended if that dwell runs past hold+zoom.
    const handoffFrame = holdFrames + Math.round(emergeAt * zoomFrames);
    const emergeEnd = handoffFrame + EMERGE_GROW_FRAMES + EMERGE_DWELL_FRAMES;
    totalFrames = Math.max(totalFrames, emergeEnd);
    // Glyph-width approximation matches the 0.55 factor used elsewhere
    // (followCaretPan, paletteGradientStyleFor). The scale wrapper turns
    // referenceVw + startPx into a `from` value resolved against the
    // actual canvas width at render time.
    const referenceVw = fontSize * Math.max(1, emergeText.length) * 0.55;
    const startPx = Math.max(
      0.5,
      knobs.emergeStartPx ?? DEFAULT_EMERGE_START_PX,
    );
    elements.push({
      element: "text",
      id: "emerge",
      base: { text: emergeText, ...baseStyle },
      layers: [
        {
          type: "scale",
          role: "in",
          props: {
            startPx,
            referenceVw,
            to: 1,
            duration: EMERGE_GROW_FRAMES,
            easing: "easeOut",
            origin: { x: 0.5, y: 0.5 },
            delay: handoffFrame,
          },
        },
      ],
    });
  }

  return {
    duration: totalFrames / fps,
    transition_out: "hard_cut",
    elements,
  };
}
