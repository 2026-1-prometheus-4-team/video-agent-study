// structural/letterStagger.tsx
// Per-letter stagger engine. Channels (opacity / blur / y / hue) lerp
// independently with shared stagger order + per-letter duration/easing.

import React from "react";
import {
  clamp,
  clamp01,
  ease,
  lerp,
  resolveEasing,
} from "../core/easing";
import { seededRandom } from "../core/random";
import { mixHex } from "../color/engine";
import type { Letter } from "./splitText";

export type LetterStaggerProps = {
  mode?: "in" | "out";
  // "char" (default) staggers per glyph. "word" gives every glyph in a word
  // the same delay so each word rises/reveals as one block (words_up/down).
  unit?: "char" | "word";
  order?: "ltr" | "rtl" | "center_out" | "edges_in" | "random";
  seed?: number;
  staggerTotal?: number;
  // named 또는 "cubic(...)" 커스텀 (에디터 커스텀 cubic() 지원)
  staggerEasing?: string;
  perLetter?: {
    duration?: number;
    easing?: string; // named 또는 "cubic(...)" (에디터 커스텀 cubic() 지원)
    channels?: {
      opacity?: { from: number; to: number };
      blur?: { from: number; to: number };
      y?: { from: number; to: number }; // em
      hue?: { from: string; to: string | "base" };
    };
  };
  // TEXT_MOTION_SPEC 2.2 — letterSpacing settle after each letter is in.
  gapSettle?: { from: number; duration: number };
};

function orderRank(
  order: string,
  charIdx: number,
  total: number,
  seed: number,
): number {
  if (order === "rtl") return total - 1 - charIdx;
  if (order === "center_out") {
    const mid = (total - 1) / 2;
    return Math.abs(charIdx - mid) * 2;
  }
  if (order === "edges_in") {
    const mid = (total - 1) / 2;
    return (mid - Math.abs(charIdx - mid)) * 2;
  }
  if (order === "random") {
    const rand = seededRandom(seed + charIdx * 31);
    return rand() * total;
  }
  return charIdx; // ltr
}

export function letterStaggerStyle(
  l: Letter,
  totalChars: number,
  localFrame: number,
  p: LetterStaggerProps,
  baseColor: string,
  totalWords?: number,
): React.CSSProperties {
  const mode = p.mode ?? "in";
  const staggerTotal = clamp(p.staggerTotal ?? 18, 1, 120);
  // 에디터 커스텀 cubic() 지원 — 기본값(easeInOut)은 기존과 동일
  const staggerEase = resolveEasing(p.staggerEasing, "easeInOut");
  // unit "word": rank by wordIdx over the word count so every glyph in a word
  // shares one delay and the word moves as a block. Falls back to per-glyph.
  const useWord = p.unit === "word" && typeof totalWords === "number";
  const rankIdx = useWord ? l.wordIdx : l.charIdx;
  const rankTotal = useWord ? (totalWords as number) : totalChars;
  const rank = orderRank(p.order ?? "ltr", rankIdx, rankTotal, p.seed ?? 3);
  const norm = rankTotal <= 1 ? 0 : rank / (rankTotal - 1);
  const delay = staggerTotal * staggerEase(clamp01(norm));

  const dur = clamp(p.perLetter?.duration ?? 10, 1, 60);
  const t = ease(localFrame - delay, dur, p.perLetter?.easing ?? "easeOutBack");
  const v = mode === "out" ? 1 - t : t;

  const ch = p.perLetter?.channels ?? {
    opacity: { from: 0, to: 1 },
  };
  const style: React.CSSProperties = {};
  if (ch.opacity) style.opacity = lerp(ch.opacity.from, ch.opacity.to, v);
  const filters: string[] = [];
  if (ch.blur) {
    filters.push(`blur(${lerp(ch.blur.from, ch.blur.to, v).toFixed(2)}px)`);
  }
  if (filters.length) style.filter = filters.join(" ");
  if (ch.y) {
    style.transform = `translateY(${lerp(ch.y.from, ch.y.to, v).toFixed(3)}em)`;
  }
  if (ch.hue) {
    const target = ch.hue.to === "base" ? baseColor : ch.hue.to;
    style.color = mixHex(ch.hue.from, target, v);
  }
  // gapSettle: each letter's letterSpacing relaxes from `from` -> 1 over
  // gapSettle.duration frames, starting at the moment that letter finishes
  // its perLetter ramp (delay + dur).
  if (p.gapSettle) {
    const sinceReveal = localFrame - delay - dur;
    if (sinceReveal >= 0) {
      const gs = ease(sinceReveal, clamp(p.gapSettle.duration, 1, 60), "easeOut");
      const extraEm = lerp(p.gapSettle.from, 1, gs) - 1;
      style.letterSpacing = `${extraEm.toFixed(3)}em`;
    } else {
      const extraEm = p.gapSettle.from - 1;
      style.letterSpacing = `${extraEm.toFixed(3)}em`;
    }
  }
  return style;
}

export function intrinsicDuration(
  rawProps: Record<string, unknown>,
  _ctx: { fps: number; unitCount: number },
): number {
  const p = rawProps as LetterStaggerProps & { duration?: number };
  if (typeof p.duration === "number") return Math.max(1, p.duration);
  const staggerTotal = Math.max(1, Math.min(120, p.staggerTotal ?? 18));
  const perLetterDuration = Math.max(1, Math.min(60, p.perLetter?.duration ?? 10));
  return staggerTotal + perLetterDuration;
}

export const name = "letter_stagger";
export const labPreset = {
  role: "in" as const,
  props: {
    mode: "in",
    order: "ltr",
    staggerTotal: 18,
    staggerEasing: "easeInOut",
    perLetter: {
      duration: 10,
      easing: "easeOutBack",
      channels: {
        opacity: { from: 0, to: 1 },
        blur: { from: 8, to: 0 },
        y: { from: 0.3, to: 0 },
      },
    },
  } as Record<string, unknown>,
};
