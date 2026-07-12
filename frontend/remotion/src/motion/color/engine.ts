// color/engine.ts
// Color timeline engine. All interpolation happens in OKLab so that
// transitions stay vivid (no muddy gray midpoints like naive RGB lerp).
// LOGIC layer: interpolation space, stop sampling and timeline math are
// hardcoded. The LLM only supplies timeline values.
//
// Two rendering paths:
//   - solid / palette  -> letterColor()  : one flat color per letter
//   - gradient         -> wordGradientAt(): a continuous CSS gradient across
//                         the whole word (so color flows within each letter)

import { clamp01, lerp } from "../core/easing";

export type GradientFill = { type: "gradient"; stops: string[]; angle?: number };

export type PaletteValue = string | GradientFill | null;

export type Fill =
  | { type: "solid"; value: string }
  | GradientFill
  | { type: "palette"; values: PaletteValue[]; unit?: "char" | "word" };

export type ColorEntry = {
  fill: Fill;
  hold?: number; // frames to stay on this fill
  transition?: number; // frames to blend into the NEXT fill
};

export type ColorSpec = {
  timeline: ColorEntry[];
  loop?: boolean;
  letterOffsetFrames?: number; // solid/palette only: per-letter clock shift
  flowSpeed?: number; // gradient only: px/frame the gradient band travels
  // reveal-linked: 색 timeline 을 scene 프레임이 아니라 각 단어/글자의
  // "등장 후 로컬 프레임" 기준으로 평가한다. 막 등장한 단어는 timeline 0
  // (예: 보라), 안착하면 transition 따라 흰으로. typewriter 의 단어 등장
  // 스케줄과 연동돼 단어마다 색 전환이 staggered 로 일어난다.
  revealLinked?: boolean;
  // reveal-linked sweep: 단어 내 글자별 시프트(프레임). 색 띠가 단어
  // 글자를 좌->우로 스쳐가는 효과. letterOffsetFrames 가 charIdx(문장
  // 전체) 기준이라 단어를 넘어가면 offset 이 누적돼 깨지는 것과 달리,
  // 단어 내 위치(wordCharIdx) 기준이라 단어 등장마다 그 단어 안에서
  // 독립적으로 sweep 한다. (ComposedText 의 frameForLetter 가 적용)
  sweepPerLetter?: number;
};

// ---------------------------------------------------------------------------
// sRGB <-> OKLab
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
type Lab = [number, number, number];

function hexToRgb(hex: string): RGB {
  // 방어: undefined/빈 값/비문자열이 들어오면 크래시 대신 검정 폴백.
  // (색 하나가 없어도 씬 전체가 ErrorBoundary 로 멈추지 않게. 근원은 letterColor 에서 막지만
  //  엔진이 나쁜 입력에 크래시하지 않는 게 원칙 — CLAUDE.md pitfalls 참고.)
  if (typeof hex !== "string" || hex.length === 0) return [0, 0, 0];
  const s = hex.trim();
  // "rgb(r, g, b)" 문자열도 파싱한다. fillColorAt 이 gradient 를 보간하면
  // mixHex -> rgbToCss 로 "rgb(...)" 를 반환하는데, letterColor 가 transition
  // 중(t>0) 그 문자열을 다시 mixHex 에 넣는 경로가 있다. 여기서 파싱에
  // 실패하면 [1,1,1](흰색)로 폴백돼 글자가 순백으로 깜빡인다.
  if (s.startsWith("rgb")) {
    const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    return [1, 1, 1];
  }
  let h = s.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const toSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function rgbToOklab([r, g, b]: RGB): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, A, B]: Lab): RGB {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
  const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
  const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [
    clamp01(toSrgb(lr)),
    clamp01(toSrgb(lg)),
    clamp01(toSrgb(lb)),
  ];
}

function rgbToCss([r, g, b]: RGB): string {
  const f = (v: number) => Math.round(v * 255);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

export function mixHex(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const la = rgbToOklab(hexToRgb(a));
  const lb = rgbToOklab(hexToRgb(b));
  return rgbToCss(
    oklabToRgb([
      lerp(la[0], lb[0], t),
      lerp(la[1], lb[1], t),
      lerp(la[2], lb[2], t),
    ]),
  );
}

function mixHexSrgb(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToCss([lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)]);
}

type Lch = [number, number, number];

function labToLch([L, A, B]: Lab): Lch {
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

function lchToLab([L, C, H]: Lch): Lab {
  const h = (H * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

// OKLCh lerp for palette-gradient stop transitions. Unlike sRGB or OKLab,
// this keeps chroma through opposite-hue transitions such as orange -> cyan,
// avoiding the beige neutral stop that reads as a flicker under glow.
function mixHexOklch(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const la = labToLch(rgbToOklab(hexToRgb(a)));
  const lb = labToLch(rgbToOklab(hexToRgb(b)));
  let dh = ((lb[2] - la[2] + 540) % 360) - 180;
  if (Math.abs(dh) === 180) dh = 180;
  return rgbToCss(
    oklabToRgb(
      lchToLab([
        lerp(la[0], lb[0], t),
        lerp(la[1], lb[1], t),
        la[2] + dh * t,
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Fill sampling: any fill type -> concrete color for one letter
// ---------------------------------------------------------------------------

function sampleGradient(stops: string[], frac: number): string {
  if (stops.length === 0) return "#FFFFFF";
  if (stops.length === 1) return stops[0];
  const pos = clamp01(frac) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  return mixHex(stops[i], stops[i + 1], pos - i);
}

export function sampleGradientSrgb(stops: string[], frac: number): string {
  if (stops.length === 0) return "#FFFFFF";
  if (stops.length === 1) return stops[0];
  const pos = clamp01(frac) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  return mixHexSrgb(stops[i], stops[i + 1], pos - i);
}

export function fillColorAt(
  fill: Fill,
  letterFrac: number,
  wordFrac: number,
  charIdx: number,
  wordIdx: number,
  baseColor: string,
): string {
  if (fill.type === "solid") return fill.value;
  if (fill.type === "gradient") return sampleGradient(fill.stops, letterFrac);
  const idx = (fill.unit ?? "word") === "word" ? wordIdx : charIdx;
  const v = fill.values[idx];
  if (v == null) return baseColor;
  if (typeof v === "string") return v;
  // gradient value inside a palette: unfold the whole gradient across
  // the matching word's characters (wordFrac), not the whole sentence.
  return sampleGradient(v.stops, wordFrac);
}

// A single representative color for a fill (used when blending a gradient
// against a solid/palette stop). For palette values that are themselves
// gradients we use the first stop.
function colorOf(f: Fill): string {
  if (f.type === "solid") return f.value;
  if (f.type === "gradient") return f.stops[0] ?? "#FFFFFF";
  for (const v of f.values) {
    if (typeof v === "string") return v;
    if (v && v.type === "gradient") return v.stops[0] ?? "#FFFFFF";
  }
  return "#FFFFFF";
}

// ---------------------------------------------------------------------------
// Timeline location: frame -> (entryA, entryB, blend t)
// ---------------------------------------------------------------------------

function timelineTotal(timeline: ColorEntry[]): number {
  return timeline.reduce(
    (sum, e) => sum + (e.hold ?? 0) + (e.transition ?? 0),
    0,
  );
}

function locate(
  timeline: ColorEntry[],
  frame: number,
  loop: boolean,
): { a: Fill; b: Fill; t: number } {
  const total = timelineTotal(timeline);
  if (timeline.length === 0) {
    return { a: { type: "solid", value: "#FFFFFF" }, b: { type: "solid", value: "#FFFFFF" }, t: 0 };
  }
  let f = frame;
  if (loop && total > 0) {
    f = ((frame % total) + total) % total;
  }
  let cursor = 0;
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    const hold = e.hold ?? 0;
    const trans = e.transition ?? 0;
    if (f < cursor + hold || (hold === 0 && trans === 0 && i === timeline.length - 1)) {
      return { a: e.fill, b: e.fill, t: 0 };
    }
    cursor += hold;
    if (trans > 0 && f < cursor + trans) {
      const next = timeline[(i + 1) % timeline.length] ?? e;
      // Endpoint-inclusive t. Dividing by `trans` makes the last frame of
      // the cross-fade sit at (trans-1)/trans (= 7/8 for trans=8), so the
      // wrap into the next entry's hold lands one whole step away from
      // where the blend left off — a visible 1-frame color jump. Mapping
      // to (trans-1) instead pins the final transition frame to t=1 so it
      // matches the next hold exactly.
      const denom = Math.max(1, trans - 1);
      return { a: e.fill, b: next.fill, t: (f - cursor) / denom };
    }
    cursor += trans;
  }
  const last = timeline[timeline.length - 1];
  return { a: last.fill, b: last.fill, t: 0 };
}

/**
 * Resolve the color of a single letter at a given scene frame.
 * letterOffsetFrames shifts each letter's clock backwards by index,
 * which produces the "color wave travelling through letters" effect.
 * Used for solid and palette fills only.
 */
export function letterColor(
  spec: ColorSpec | undefined,
  frame: number,
  letterFrac: number,
  wordFrac: number,
  charIdx: number,
  wordIdx: number,
  baseColor: string,
): string {
  if (!spec || spec.timeline.length === 0) return baseColor;
  // reveal-linked sweep: 음수 프레임 = 색 띠(sweep)가 아직 이 글자에
  // 도달 전. timeline 의 "첫" fill(등장 색)로 시작한다. 원본은 단어가
  // 등장하는 순간 전체가 보라로 켜졌다가(등장 색) 보라 띠가 좌->우로
  // 지나가며 각 글자가 마지막(안착) 그라데이션으로 가라앉기 때문이다.
  // 흰색으로 시작하면 안 된다 — 그러면 띠가 흰색을 밀어내는 것처럼 보인다.
  if (frame < 0) {
    const first = spec.timeline[0];
    return fillColorAt(first.fill, letterFrac, wordFrac, charIdx, wordIdx, baseColor);
  }
  const offset = (spec.letterOffsetFrames ?? 0) * charIdx;
  const { a, b, t } = locate(spec.timeline, Math.max(0, frame - offset), spec.loop ?? false);
  const ca = fillColorAt(a, letterFrac, wordFrac, charIdx, wordIdx, baseColor) || baseColor;
  // t<=0(홀드) 이거나 b 가 없으면(타임라인 끝) 블렌드 없이 ca. 방어: cb 가 유효할 때만 mix.
  if (t <= 0 || b == null) return ca;
  const cb = fillColorAt(b, letterFrac, wordFrac, charIdx, wordIdx, baseColor);
  if (typeof cb !== "string" || cb.length === 0) return ca;
  return mixHex(ca, cb, t);
}

/**
 * If, at this frame, the active palette fill has a gradient value at
 * the given wordIdx (and we're inside a hold, not blending between two
 * entries), return that gradient. The caller can then draw the word
 * with background-clip:text so the gradient unfolds continuously
 * across the glyphs instead of one solid color per letter.
 *
 * Returns null whenever the cell is solid, null, or the timeline is in
 * a transition — for transitions we fall back to per-letter sampling
 * so the color stays well-defined.
 */
export function paletteGradientAt(
  spec: ColorSpec | undefined,
  frame: number,
  wordIdx: number,
): GradientFill | null {
  if (!spec || spec.timeline.length === 0) return null;
  const { a, b, t } = locate(spec.timeline, frame, spec.loop ?? false);
  if (a.type !== "palette") return null;
  if ((a.unit ?? "word") !== "word") return null;
  const va = a.values[wordIdx];
  if (!va || typeof va !== "object" || va.type !== "gradient") return null;
  // Hold (or self-loop) — return the gradient as-is.
  if (t <= 0 || a === b) return va;
  // Transition — blend the two gradients' stop arrays so the
  // background-clip:text path stays alive (otherwise we'd drop back to
  // per-letter sampling and the glyphs would flash apart).
  if (b.type !== "palette" || (b.unit ?? "word") !== "word") return va;
  const vb = b.values[wordIdx];
  if (!vb || typeof vb !== "object" || vb.type !== "gradient") return va;
  return { type: "gradient", stops: mixStops(va, vb, t), angle: va.angle };
}

// ---------------------------------------------------------------------------
// Gradient path: a continuous gradient across the whole word
// ---------------------------------------------------------------------------

export type WordGradient = {
  stops: string[]; // timeline-interpolated stops
  angle: number; // degrees
  flow: number; // px offset for backgroundPositionX (the travelling band)
};

// Blend two fills' stop arrays. Solids/palettes are promoted to a single
// stop so any fill can blend with a gradient without breaking.
function mixStops(a: Fill, b: Fill, t: number): string[] {
  const sa = a.type === "gradient" ? a.stops : [colorOf(a)];
  const sb = b.type === "gradient" ? b.stops : [colorOf(b)];
  const n = Math.max(sa.length, sb.length, 2);
  const pick = (s: string[], i: number) =>
    s[Math.round((i / (n - 1)) * (s.length - 1))] ?? s[s.length - 1];
  return Array.from({ length: n }, (_, i) =>
    mixHexOklch(pick(sa, i), pick(sb, i), t),
  );
}

/**
 * Resolve a whole-word gradient at a given frame.
 * Returns null when neither side of the current timeline blend is a gradient
 * (in that case the caller should fall back to the per-letter letterColor path).
 */
export function wordGradientAt(
  spec: ColorSpec | undefined,
  frame: number,
): WordGradient | null {
  if (!spec || spec.timeline.length === 0) return null;
  const { a, b, t } = locate(spec.timeline, frame, spec.loop ?? false);
  if (a.type !== "gradient" && b.type !== "gradient") return null;
  const angle =
    (a.type === "gradient" ? a.angle : undefined) ??
    (b.type === "gradient" ? b.angle : undefined) ??
    90;
  return {
    stops: mixStops(a, b, t),
    angle,
    flow: frame * (spec.flowSpeed ?? 0),
  };
}
