// structural/splitText.tsx
// Shared text-splitting + per-letter renderer that every structural atom
// (typewriter / letterStagger / pathIn / marqueeRows) builds on top of.

import React from "react";
import { letterColor, type ColorSpec } from "../color/engine";

export type Letter = {
  ch: string;
  charIdx: number; // index among non-space characters
  wordIdx: number;
  frac: number; // 0..1 position across the WHOLE sentence (non-space chars)
  wordFrac: number; // 0..1 position INSIDE this letter's word
  wordCharIdx: number; // 0-based index of this letter inside its word
  wordLen: number; // total non-space char count of this letter's word
  isSpace: boolean;
};

export function splitText(text: string): Letter[] {
  const out: Letter[] = [];
  let wordIdx = 0;
  let charIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isSpace = ch === " ";
    out.push({
      ch,
      charIdx: isSpace ? -1 : charIdx,
      wordIdx,
      frac: 0,
      wordFrac: 0,
      wordCharIdx: 0,
      wordLen: 0,
      isSpace,
    });
    if (isSpace) {
      wordIdx++;
    } else {
      charIdx++;
    }
  }
  // Sentence-wide frac.
  const n = Math.max(1, charIdx - 1);
  for (const l of out) {
    if (!l.isSpace) l.frac = l.charIdx / n;
  }
  // Per-word frac: each word's letters span 0..1 by themselves, so a
  // gradient sampled by wordFrac unfolds the whole gradient across just
  // that word.
  const wordLen: number[] = [];
  for (const l of out) {
    if (l.isSpace) continue;
    wordLen[l.wordIdx] = (wordLen[l.wordIdx] ?? 0) + 1;
  }
  const wordSeen: number[] = [];
  for (const l of out) {
    if (l.isSpace) continue;
    const seen = wordSeen[l.wordIdx] ?? 0;
    const total = wordLen[l.wordIdx] ?? 1;
    l.wordCharIdx = seen;
    l.wordLen = total;
    l.wordFrac = total <= 1 ? 0 : seen / (total - 1);
    wordSeen[l.wordIdx] = seen + 1;
  }
  return out;
}

export function unitCount(text: string, unit: "char" | "word"): number {
  if (unit === "word") return text.split(/\s+/).filter(Boolean).length;
  return text.replace(/\s/g, "").length;
}

// 요소 단위 3D 커브(curve3d) — ComposedText 가 렌더 시작 시 글자별 곡면 스타일 함수를
// 세팅하면 renderLetters 가 각 글자 outer span 에 merge 한다. renderLetters 는
// ComposedText body 안에서 동기 호출되므로 모듈 변수로 안전(렌더마다 재설정).
let _letterCurve: ((l: Letter) => React.CSSProperties | null) | null = null;
export function setLetterCurve(fn: typeof _letterCurve): void {
  _letterCurve = fn;
}

// Shared letter renderer. perLetter returns extra style for each glyph.
export function renderLetters(
  letters: Letter[],
  frame: number,
  baseColor: string,
  colorSpec: ColorSpec | undefined,
  perLetter?: (l: Letter) => React.CSSProperties | null,
  overrideColor?: string,
  cursorAfterCharIdx?: number,
  cursorStyle?: React.CSSProperties,
  // reveal-linked color: 글자마다 색 평가 프레임을 따로 준다(단어 등장 후
  // 로컬 프레임). 없으면 모든 글자가 공통 `frame` 으로 평가된다.
  frameForLetter?: (l: Letter) => number,
  // reveal-linked color: 글자마다 그라데이션 위치(frac)를 따로 준다. 없으면
  // 문장 전체 기준 l.frac. 원본은 "현재 보이는 텍스트 폭"에 그라데이션을
  // re-map 하므로 보이는 글자수 기준으로 frac 을 재계산해 넘긴다.
  fracForLetter?: (l: Letter) => number,
  // 글자 변신: 원래 문자(l.ch) 대신 표시할 문자를 준다(E->10, E->A 등).
  // letter_choreography 의 char keyframe 용. 없거나 undefined 면 원래 글자.
  charForLetter?: (l: Letter) => string | undefined,
): React.ReactNode {
  return letters.map((l, i) => {
    const curveExtra = _letterCurve ? _letterCurve(l) : null;
    if (l.isSpace) {
      const extra = perLetter ? perLetter(l) : null;
      return (
        <span
          key={i}
          data-word-idx={l.wordIdx}
          style={{ whiteSpace: "pre", ...extra, ...curveExtra }}
        >
          {" "}
        </span>
      );
    }
    const colorFrame = frameForLetter ? frameForLetter(l) : frame;
    const letterFrac = fracForLetter ? fracForLetter(l) : l.frac;
    const color =
      overrideColor ??
      letterColor(colorSpec, colorFrame, letterFrac, l.wordFrac, l.charIdx, l.wordIdx, baseColor);
    const extra = perLetter ? perLetter(l) : null;
    const showCursor = cursorAfterCharIdx === l.charIdx;
    // data-word-idx on the outer wrapper lets a scoped CSS rule (used by
    // the glow clone path) hide letters that aren't the highlight word
    // while preserving layout. visibility:hidden keeps the box but removes
    // the pixels, so the blurred halo only covers the highlight word.
    const displayCh = charForLetter?.(l) ?? l.ch;
    // 글자 변신(E->1 등)이 가능한 렌더(letter_choreography)에서는, 변신 글자의
    // 폭이 달라지며 inline flow 가 reflow 돼 옆 글자들이 자글자글 떨린다.
    // 원래 글자(l.ch)를 투명 spacer 로 깔아 칸 폭(layout)을 고정하고, 표시 글자는
    // 그 위에 absolute 로 가운데 올린다. 폭 불변 -> reflow 0 -> 떨림 없음.
    // (transform 모션/opacity 는 표시 글자에만. spacer 는 폭만 기여.)
    if (charForLetter) {
      const op =
        extra && typeof (extra as React.CSSProperties).opacity === "number"
          ? ((extra as React.CSSProperties).opacity as number)
          : 1;
      // 완전히 사라진 글자는 칸(폭)까지 없앤다(display:none) -> 남은 글자가
      // reflow 로 그 빈자리를 메우며 당겨진다(biasafe 의 "글자 사라지면 뒤가
      // 당겨짐"). 변신 중(opacity 1)인 글자는 spacer 유지 -> 자글자글 방지.
      if (op <= 0.01) {
        return <span key={i} data-word-idx={l.wordIdx} style={{ display: "none" }} />;
      }
      return (
        <span
          key={i}
          data-word-idx={l.wordIdx}
          style={{ position: "relative", display: "inline-block", ...curveExtra }}
        >
          <span aria-hidden style={{ display: "inline-block", visibility: "hidden" }}>
            {l.ch}
          </span>
          <span
            style={{
              color,
              position: "absolute",
              left: 0,
              top: 0,
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              lineHeight: 1,
              ...extra,
            }}
          >
            {displayCh}
          </span>
          {showCursor && cursorStyle ? <span style={cursorStyle} /> : null}
        </span>
      );
    }
    return (
      <span
        key={i}
        data-word-idx={l.wordIdx}
        style={{ position: "relative", display: "inline-block", ...curveExtra }}
      >
        <span style={{ color, display: "inline-block", ...extra }}>{displayCh}</span>
        {showCursor && cursorStyle ? (
          <span style={cursorStyle} />
        ) : null}
      </span>
    );
  });
}

// Canvas measureText wrapper. Returns 0 when DOM is unavailable; otherwise
// the rendered width of `text` in the given font. Used by typewriter reflow
// to compute the centered slide between word reveals.
let measureCanvas: HTMLCanvasElement | null = null;
function ensureMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas.getContext("2d");
}
export function measureText(
  text: string,
  fontPx: number,
  fontFamily: string,
  fontWeight: number,
): number {
  const ctx = ensureMeasureCtx();
  if (!ctx) return 0;
  ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
  return ctx.measureText(text).width;
}

// Width + tight vertical bounds (cap height + descender depth) of the
// given text in the given font. The vertical bounds come from canvas
// TextMetrics.actualBoundingBoxAscent/Descent — the actual painted-pixel
// bbox, not the em box. Use this when you need a slot that fits the
// rendered glyphs WITHOUT the leading whitespace fontSize gives you.
// Falls back to 0.75/0.2 × fontPx when actualBoundingBox* is unavailable
// (older measureText impls or SSR).
export function measureTextBox(
  text: string,
  fontPx: number,
  fontFamily: string,
  fontWeight: number,
): { width: number; ascent: number; descent: number } {
  const ctx = ensureMeasureCtx();
  if (!ctx) return { width: 0, ascent: 0, descent: 0 };
  ctx.font = `${fontWeight} ${fontPx}px ${fontFamily}`;
  const m = ctx.measureText(text);
  return {
    width: m.width,
    ascent: m.actualBoundingBoxAscent ?? fontPx * 0.75,
    descent: m.actualBoundingBoxDescent ?? fontPx * 0.2,
  };
}

// Blinking caret used by typewriter when cursor != "none".
export function cursorCss(
  cursor: "light" | "dark",
  fontSizePx: number,
  frame: number,
): React.CSSProperties {
  const blinkOn = Math.floor(frame / 12) % 2 === 0;
  return {
    position: "absolute",
    right: -Math.max(2, fontSizePx * 0.08),
    top: "10%",
    height: "80%",
    width: Math.max(2, fontSizePx * 0.045),
    background: cursor === "dark" ? "#000000" : "#FFFFFF",
    opacity: blinkOn ? 1 : 0,
  };
}
