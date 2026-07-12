// schema.ts
// 인스펙터가 소비하는 노브 카탈로그. 엔진 레지스트리(WRAPPER_EFFECTS/
// STRUCTURAL_EFFECTS/SCENE_TRANSITIONS/CAMERA_MOTIONS)에서 exposed 노브를 자동
// 생성하고, 실측 cemented 수치(연구 문서 engine-schema.md 근거)를 손으로 얹는다.
// exposed = cemented:false (자유 편집), 나머지 = cemented:true (락 표시, 편집은 가능).

import {
  WRAPPER_EFFECTS,
  STRUCTURAL_EFFECTS,
  CAMERA_MOTIONS,
  type ExposedField,
  type ExposedSchema,
} from "@engine/compose/registry";

export type KnobKind =
  | "number"
  | "color"
  | "enum"
  | "bool"
  | "string"
  | "colorList"
  | "easing";

export type Knob = {
  key: string;
  label: string;
  kind: KnobKind;
  path: string; // layer.props 또는 element 기준 점 경로
  cemented: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: "frames" | "vw" | "em" | "fraction" | "deg" | "px" | "x" | "s";
  values?: { value: string; label: string }[];
  default?: unknown;
  description?: string;
};

export type EffectSchema = {
  name: string;
  title: string;
  description: string;
  role: "in" | "out" | "hold";
  atom: string;
  /** 이 효과를 새로 추가할 때 layer.props 초기값 (cemented + variant 기본 + exposed 기본) */
  defaultProps: () => Record<string, unknown>;
  knobs: Knob[];
};

// ExposedField -> Knob
function exposedKnob(key: string, f: ExposedField, pathPrefix = "props"): Knob {
  const path = `${pathPrefix}.${key}`;
  const base = { key, label: key, path, cemented: false } as const;
  switch (f.kind) {
    case "number":
      return { ...base, kind: "number", min: f.min, max: f.max, step: f.min != null && f.max != null && f.max - f.min <= 2 ? 0.01 : 1, default: f.default };
    case "color":
      return { ...base, kind: "color", default: f.default };
    case "bool":
      return { ...base, kind: "bool", default: f.default };
    case "string":
      return { ...base, kind: "string", default: f.default };
    case "colorList":
      return { ...base, kind: "colorList", default: f.default };
    case "enum":
      return {
        ...base,
        kind: "enum",
        values: f.values.map((v) => ({ value: v, label: v })),
        default: f.default,
      };
  }
}

function exposedKnobs(schema: ExposedSchema | undefined): Knob[] {
  if (!schema) return [];
  return Object.entries(schema).map(([k, f]) => exposedKnob(k, f));
}

// 손으로 얹는 cemented 노브 (효과 이름 -> Knob[]). 실측 수치 편집용(락 표시).
// 근거: engine-schema.md + registry.ts cemented 값.
function num(key: string, label: string, path: string, min: number, max: number, step: number, unit?: Knob["unit"]): Knob {
  return { key, label, path, kind: "number", cemented: true, min, max, step, unit };
}
function easing(key: string, label: string, path: string): Knob {
  return { key, label, path, kind: "easing", cemented: true };
}
// exposed(자유 편집) 빌더 — cemented:false
function easingX(key: string, label: string, path: string): Knob {
  return { key, label, path, kind: "easing", cemented: false };
}
function enumX(key: string, label: string, path: string, values: string[], def?: string): Knob {
  return { key, label, path, kind: "enum", cemented: false, values: values.map((v) => ({ value: v, label: v })), default: def ?? values[0] };
}
function numX(key: string, label: string, path: string, min: number, max: number, step: number, unit?: Knob["unit"]): Knob {
  return { key, label, path, kind: "number", cemented: false, min, max, step, unit };
}
function colorX(key: string, label: string, path: string): Knob {
  return { key, label, path, kind: "color", cemented: false };
}
function strX(key: string, label: string, path: string): Knob {
  return { key, label, path, kind: "string", cemented: false };
}

const CEMENTED: Record<string, Knob[]> = {
  typewriter: [num("cps", "Speed (char/s)", "props.charsPerSecond", 2, 60, 1)],
  characters_settle: [
    num("cps", "Speed (char/s)", "props.charsPerSecond", 2, 60, 1),
    num("blurFrom", "Blur from", "props.revealBlur.from", 0, 20, 0.5, "px"),
    num("scaleFrom", "Scale from", "props.revealScale.from", 0.1, 1, 0.05, "x"),
    num("rotFrom", "Rotate from", "props.revealRotate.from", -45, 45, 1, "deg"),
  ],
  word_gap_settle: [
    num("firstGap", "First gap", "props.firstGap", 1, 30, 1, "frames"),
    num("wordGap", "Word gap", "props.wordGap", 1, 20, 1, "frames"),
    num("lastGap", "Last gap", "props.lastGap", 1, 30, 1, "frames"),
    num("blurFrom", "Blur from", "props.revealBlur.from", 0, 20, 0.5, "px"),
  ],
  flicker: [
    num("revealFrames", "Reveal duration", "props.revealFrames", 8, 120, 1, "frames"),
    num("litStart", "Lit start", "props.litProbStart", 0, 1, 0.01),
    num("litEnd", "Lit end", "props.litProbEnd", 0, 1, 0.01),
  ],
  letters_whoosh: [
    num("stagger", "Stagger", "props.staggerTotal", 1, 40, 1, "frames"),
    num("dur", "Letter duration", "props.perLetter.duration", 4, 40, 1, "frames"),
    easing("ease", "Easing", "props.perLetter.easing"),
  ],
  letter_roll: [num("blurFactor", "Blur factor", "props.blurFactor", 0, 10, 0.5)],
  letter_scatter: [num("verticalBias", "Vertical bias", "props.verticalBias", 0, 1, 0.05)],
  stat_reveal: [
    num("countDur", "Count duration", "props.countDuration", 10, 120, 1, "frames"),
    easing("countEase", "Count easing", "props.countEasing"),
    num("landBounce", "Land bounce", "props.landBounce", 0, 0.5, 0.01),
    num("suffixScale", "Suffix scale", "props.suffixScale", 0.2, 1, 0.05, "x"),
    easing("slideEase", "Slide easing", "props.slideEasing"),
  ],
  words_up: [
    num("stagger", "Stagger", "props.staggerTotal", 1, 40, 1, "frames"),
    num("dur", "Word duration", "props.perLetter.duration", 4, 40, 1, "frames"),
    num("blurFrom", "Blur from", "props.perLetter.channels.blur.from", 0, 30, 1, "px"),
    easing("ease", "Easing", "props.perLetter.easing"),
  ],
  words_down: [
    num("stagger", "Stagger", "props.staggerTotal", 1, 40, 1, "frames"),
    num("dur", "Word duration", "props.perLetter.duration", 4, 40, 1, "frames"),
    num("blurFrom", "Blur from", "props.perLetter.channels.blur.from", 0, 30, 1, "px"),
    easing("ease", "Easing", "props.perLetter.easing"),
  ],
  apple_text: [
    num("stagger", "Stagger", "props.staggerTotal", 1, 40, 1, "frames"),
    num("dur", "Word duration", "props.perLetter.duration", 4, 40, 1, "frames"),
    num("blurFrom", "Blur from", "props.perLetter.channels.blur.from", 0, 40, 1, "px"),
    easing("ease", "Easing", "props.perLetter.easing"),
  ],
  typewriter_erase: [num("cps", "Speed (char/s)", "props.charsPerSecond", 2, 60, 1)],
  // wrappers
  fade: [num("dur", "Duration", "props.duration", 2, 40, 1, "frames")],
  blur: [
    num("from", "Blur from", "props.from", 0, 40, 1, "px"),
    num("to", "Blur to", "props.to", 0, 40, 1, "px"),
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  scale: [
    num("from", "Scale from", "props.from", 0, 3, 0.01, "x"),
    num("to", "Scale to", "props.to", 0, 3, 0.01, "x"),
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  move: [
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  flip: [
    num("fromDeg", "Angle from", "props.fromDeg", -360, 360, 5, "deg"),
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  shrink_into_place: [
    num("fromScale", "Scale from", "props.fromScale", 1, 5, 0.1, "x"),
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  shrink_out: [
    num("from", "Scale from", "props.from", 0, 2, 0.05, "x"),
    num("to", "Scale to", "props.to", 0, 2, 0.05, "x"),
    num("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
  ],
  fly_out: [num("dur", "Duration", "props.duration", 2, 40, 1, "frames")],
  mask_wipe: [
    num("dur", "Duration", "props.duration", 4, 60, 1, "frames"),
    num("feather", "Feather", "props.feather", 0.05, 1, 0.05),
    easing("ease", "Easing", "props.easing"),
  ],
};

// registry entry -> defaultProps (cemented + 첫 variant + exposed 기본)
function buildDefaultProps(entry: {
  cemented: Record<string, unknown>;
  exposed?: ExposedSchema;
  variantKey?: string;
  variants?: Record<string, Record<string, unknown>>;
}): Record<string, unknown> {
  const props: Record<string, unknown> = structuredClone(entry.cemented ?? {});
  // 첫 variant 병합
  if (entry.variantKey && entry.variants) {
    const firstVariant = Object.keys(entry.variants)[0];
    Object.assign(props, entry.variants[firstVariant] ?? {});
    props[entry.variantKey] =
      (entry.exposed?.[entry.variantKey] as { default?: string } | undefined)?.default ??
      firstVariant;
  }
  // exposed 기본값
  for (const [k, f] of Object.entries(entry.exposed ?? {})) {
    if (k === entry.variantKey) continue;
    if ("default" in f && f.default !== undefined) props[k] = f.default;
  }
  return props;
}

const STRUCTURAL_TITLES: Record<string, string> = {
  typewriter: "Typewriter",
  characters_settle: "Characters Settle",
  word_gap_settle: "Word Gap Settle",
  flicker: "Flicker In",
  letters_whoosh: "Letters Whoosh",
  letter_roll: "Slot Machine Roll",
  letter_scatter: "Scatter Assemble",
  stat_reveal: "Count Up",
  words_up: "Words Up",
  words_down: "Words Down",
  apple_text: "Apple Keynote",
  typewriter_erase: "Typewriter Erase (Out)",
};
const WRAPPER_TITLES: Record<string, string> = {
  fade: "Fade",
  blur: "Blur",
  scale: "Scale",
  move: "Move",
  flip: "3D Flip",
  shrink_into_place: "Shrink Into Place",
  shrink_out: "Shrink Out",
  fly_out: "Fly Out",
  masked_reveal: "Masked Reveal (sweep + slide)",
  wiggle: "Wiggle (organic idle)",
};

function buildEffectSchema(
  name: string,
  entry: {
    atom: string;
    role?: string;
    cemented: Record<string, unknown>;
    exposed?: ExposedSchema;
    variantKey?: string;
    variants?: Record<string, Record<string, unknown>>;
  },
  titles: Record<string, string>,
): EffectSchema {
  const role = (entry.role ?? "in") as "in" | "out" | "hold";
  return {
    name,
    title: titles[name] ?? name,
    description: "",
    role,
    atom: entry.atom,
    defaultProps: () => buildDefaultProps(entry),
    knobs: [...exposedKnobs(entry.exposed), ...(CEMENTED[name] ?? [])],
  };
}

// named 효과 -> 실제 저장할 MotionLayer[] (atom 기준, compound 는 parts 로 펼침).
// 엔진은 layer.type = atom 만 렌더하므로 named 이름은 저장하지 않는다.
export function buildLayersForEffect(
  name: string,
): { type: string; role: string; props: Record<string, unknown> }[] {
  const structural = STRUCTURAL_EFFECTS[name as keyof typeof STRUCTURAL_EFFECTS] as
    | { atom: string; role?: string; cemented: Record<string, unknown>; exposed?: ExposedSchema; variantKey?: string; variants?: Record<string, Record<string, unknown>> }
    | undefined;
  const wrapper = WRAPPER_EFFECTS[name];
  const entry = structural ?? wrapper;
  if (!entry) return [];
  const role = entry.role ?? "in";
  const wEntry = wrapper as (typeof WRAPPER_EFFECTS)[string] | undefined;
  if (wEntry?.parts) {
    // compound (fly_out): 각 part 를 별도 레이어로. variant 를 각 part props 에 병합.
    const variantProps =
      wEntry.variantKey && wEntry.variants
        ? wEntry.variants[Object.keys(wEntry.variants)[0]]
        : {};
    return wEntry.parts.map((p) => ({
      type: p.atom,
      role: p.role ?? role,
      props: { ...structuredClone(p.cemented), ...variantProps },
    }));
  }
  return [
    {
      type: entry.atom,
      role,
      props: buildDefaultProps(entry),
    },
  ];
}

// atom -> 대표 named 효과 이름 (유일 매핑일 때만). 표시용.
const ATOM_TO_NAME: Record<string, string> = {
  letter_flicker: "flicker",
  letter_roll: "letter_roll",
  letter_scatter: "letter_scatter",
  stat_reveal: "stat_reveal",
  shrink_into_place: "shrink_into_place",
  fade: "fade",
  blur: "blur",
  flip: "flip",
  wiggle: "wiggle",
};
/** 레이어 추가/교체 메뉴에서 숨길 효과 — 범용 텍스트 효과가 아니라 Insert
 *  프리셋(예: Stat counter)으로만 노출. 기존 레이어 편집/스왑 대상엔 영향 없음. */
export const MENU_HIDDEN_EFFECTS = new Set(["stat_reveal"]);

export function displayNameForLayer(type: string, role: string): string {
  const named = ATOM_TO_NAME[type];
  const title = named
    ? STRUCTURAL_TITLES[named] ?? WRAPPER_TITLES[named]
    : undefined;
  if (title) return title;
  // atom 이 여러 named 에 매핑되는 경우(typewriter/letter_stagger/scale/move)는 atom + role
  const roleTag = role === "out" ? " (Out)" : "";
  return `${type}${roleTag}`;
}

export const STRUCTURAL_SCHEMA: Record<string, EffectSchema> = Object.fromEntries(
  Object.entries(STRUCTURAL_EFFECTS).map(([name, entry]) => [
    name,
    buildEffectSchema(name, entry, STRUCTURAL_TITLES),
  ]),
);

export const WRAPPER_SCHEMA: Record<string, EffectSchema> = Object.fromEntries(
  Object.entries(WRAPPER_EFFECTS).map(([name, entry]) => [
    name,
    buildEffectSchema(name, entry, WRAPPER_TITLES),
  ]),
);

// 효과 이름으로 스키마 찾기 (레이어 렌더용)
export function schemaForLayer(type: string): EffectSchema | null {
  return STRUCTURAL_SCHEMA[type] ?? WRAPPER_SCHEMA[type] ?? null;
}

// atom 별 편집 surface 전체 (exposed + cemented). 레이어는 { type: atomName }
// 으로 저장되고 atom->named 는 1:N 이라(typewriter<-type/settle/erase 등), 레이어
// 에서 named 효과를 역추적할 수 없다. 그래서 "atom 이 실제로 읽는 prop 전체"를
// 편집 surface 로 삼는다 — atom 이 엔진이 읽는 실체이므로 이게 가장 정확하다.
// exposed(자유 편집) 는 항상 노출, cemented(락) 는 레이어에 값이 있을 때만 노출
// (LayerKnobs 가 필터) — 평범한 typewriter 에 characters_settle 의 reveal 노브가
// 안 뜨게. (근거: editor-prop-audit — atomFallbackKnobs 만 렌더돼 exposed 노브
// 전체가 unreachable 이던 치명적 갭 수정)
const ATOM_KNOBS: Record<string, Knob[]> = {
  typewriter: [
    enumX("unit", "Unit", "props.unit", ["char", "word"], "char"),
    enumX("cursor", "Cursor", "props.cursor", ["none", "light", "dark"], "none"),
    enumX("cadence", "Cadence", "props.cadence", ["uniform", "human"], "uniform"),
    enumX("eraseFrom", "Erase direction", "props.eraseFrom", ["left", "right", "edges"], "left"),
    num("cps", "Speed (char/s)", "props.charsPerSecond", 2, 60, 1),
    num("firstGap", "First gap", "props.firstGap", 1, 30, 1, "frames"),
    num("wordGap", "Word gap", "props.wordGap", 1, 20, 1, "frames"),
    num("lastGap", "Last gap", "props.lastGap", 1, 30, 1, "frames"),
    num("blurFrom", "Reveal blur", "props.revealBlur.from", 0, 20, 0.5, "px"),
    num("scaleFrom", "Reveal scale", "props.revealScale.from", 0.1, 1, 0.05, "x"),
    num("rotFrom", "Reveal rotate", "props.revealRotate.from", -45, 45, 1, "deg"),
    num("xFrom", "Reveal X", "props.revealX.from", -1, 1, 0.05, "em"),
  ],
  letter_stagger: [
    enumX("unit", "Unit", "props.unit", ["char", "word"], "char"),
    enumX("order", "Order", "props.order", ["ltr", "rtl"], "ltr"),
    num("stagger", "Stagger", "props.staggerTotal", 1, 40, 1, "frames"),
    num("dur", "Letter duration", "props.perLetter.duration", 4, 40, 1, "frames"),
    easing("ease", "Easing", "props.perLetter.easing"),
    num("yFrom", "Y from", "props.perLetter.channels.y.from", -2, 2, 0.05, "em"),
    num("blurFrom", "Blur from", "props.perLetter.channels.blur.from", 0, 40, 1, "px"),
    num("scaleFrom", "Scale from", "props.perLetter.channels.scale.from", 0, 2, 0.05, "x"),
  ],
  letter_flicker: [
    num("revealFrames", "Reveal duration", "props.revealFrames", 8, 120, 1, "frames"),
    num("litStart", "Lit start", "props.litProbStart", 0, 1, 0.01),
    num("litEnd", "Lit end", "props.litProbEnd", 0, 1, 0.01),
    num("partialChance", "Partial lit chance", "props.partialChance", 0, 1, 0.01),
    num("settleStart", "Settle start", "props.settleStartFrac", 0, 1, 0.01),
  ],
  letter_roll: [
    enumX("settleMode", "Settle mode", "props.settleMode", ["stagger", "together"], "stagger"),
    num("blurFactor", "Blur factor", "props.blurFactor", 0, 10, 0.5),
    num("stagger", "Stagger", "props.stagger", 0, 10, 0.5, "frames"),
    num("dur", "Duration", "props.duration", 8, 120, 1, "frames"),
    num("rollSpeed", "Roll speed", "props.rollSpeed", 0.2, 5, 0.1),
    num("freeFrac", "Free fraction", "props.freeFrac", 0, 1, 0.05),
  ],
  letter_scatter: [
    enumX("mode", "Mode", "props.mode", ["in", "out"], "in"),
    num("spread", "Spread", "props.spread", 0, 1, 0.02),
    num("rotation", "Rotate", "props.rotation", 0, 90, 1, "deg"),
    num("dur", "Duration", "props.duration", 6, 60, 1, "frames"),
    easing("ease", "Easing", "props.easing"),
    num("stagger", "Stagger", "props.stagger", 0, 10, 0.5, "frames"),
    num("verticalBias", "Vertical bias", "props.verticalBias", 0, 1, 0.05),
  ],
  stat_reveal: [
    strX("prefix", "Prefix", "props.prefix"),
    strX("suffix", "Suffix", "props.suffix"),
    numX("from", "From value", "props.from", 0, 1000000, 1),
    numX("to", "To value", "props.to", 0, 1000000, 1),
    enumX("prefixSide", "Prefix side", "props.prefixSide", ["left", "right"], "left"),
    enumX("suffixMode", "Suffix mode", "props.suffixMode", ["reveal", "static"], "reveal"),
    colorX("baseColor", "Base color", "props.baseColor"),
    colorX("landColor", "Land color", "props.landColor"),
    num("countDur", "Count duration", "props.countDuration", 10, 120, 1, "frames"),
    easing("countEase", "Count easing", "props.countEasing"),
    num("landBounce", "Land bounce", "props.landBounce", 0, 0.5, 0.01),
    num("suffixScale", "Suffix scale", "props.suffixScale", 0.2, 1, 0.05, "x"),
    easing("slideEase", "Slide easing", "props.slideEasing"),
  ],
  // wrappers — 사용자가 직접 얹는 원시 래퍼. 실측 baseline 이 아니라 그냥
  // 레이어 자체 파라미터이므로 전부 exposed(자유 편집). "Locked" 로 묶지 않는다.
  scale: [
    numX("from", "Scale from", "props.from", 0, 3, 0.01, "x"),
    numX("to", "Scale to", "props.to", 0, 3, 0.01, "x"),
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easingX("ease", "Easing", "props.easing"),
    numX("dwell", "Dwell fraction", "props.dwellFrac", 0, 1, 0.05),
    numX("originX", "Pivot X", "props.origin.x", 0, 1, 0.01, "fraction"),
    numX("originY", "Pivot Y", "props.origin.y", 0, 1, 0.01, "fraction"),
  ],
  move: [
    numX("fromX", "X from", "props.fromX", -0.5, 0.5, 0.01, "fraction"),
    numX("toX", "X to", "props.toX", -0.5, 0.5, 0.01, "fraction"),
    numX("fromY", "Y from", "props.fromY", -0.5, 0.5, 0.01, "fraction"),
    numX("toY", "Y to", "props.toY", -0.5, 0.5, 0.01, "fraction"),
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easingX("ease", "Easing", "props.easing"),
  ],
  blur: [
    numX("from", "Blur from", "props.from", 0, 40, 1, "px"),
    numX("to", "Blur to", "props.to", 0, 40, 1, "px"),
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easingX("ease", "Easing", "props.easing"),
  ],
  wiggle: [
    numX("freq", "Frequency", "props.freq", 0.2, 8, 0.1, "x"),
    numX("posAmp", "Position", "props.posAmp", 0, 0.15, 0.005),
    numX("rotAmp", "Rotation", "props.rotAmp", 0, 45, 0.5, "deg"),
    numX("scaleAmp", "Scale", "props.scaleAmp", 0, 0.3, 0.01),
    numX("seed", "Seed", "props.seed", 1, 999, 1),
  ],
  fade: [
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    numX("blur", "Blur tail", "props.blur", 0, 12, 0.5, "px"),
    easingX("ease", "Easing", "props.easing"),
  ],
  flip: [
    numX("fromDeg", "Angle from", "props.fromDeg", -360, 360, 5, "deg"),
    numX("toDeg", "Angle to", "props.toDeg", -360, 360, 5, "deg"),
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easingX("ease", "Easing", "props.easing"),
  ],
  shrink_into_place: [
    numX("fromScale", "Scale from", "props.fromScale", 1.5, 4, 0.1, "x"),
    numX("fromX", "X from", "props.fromX", -0.3, 0.3, 0.01, "fraction"),
    numX("fromY", "Y from", "props.fromY", -0.3, 0.3, 0.01, "fraction"),
    numX("dur", "Duration", "props.duration", 2, 40, 1, "frames"),
    easingX("ease", "Easing", "props.easing"),
  ],
};

// 하위호환 이름 유지(LayerStack 이 import). atom 의 전체 편집 surface 반환.
export function atomFallbackKnobs(atom: string): Knob[] {
  return ATOM_KNOBS[atom] ?? [];
}

// ---- effects (glow / motionBlur) ----
// 근거: editor-prop-audit — radius(가장 큰 미스)/breath 추가, intensity 0..1 로 정정.
export const GLOW_KNOBS: Knob[] = [
  { key: "color", label: "Color", kind: "color", path: "color", cemented: false },
  numX("intensity", "Intensity", "intensity", 0, 1, 0.05),
  numX("radius", "Radius", "radius", 4, 120, 1, "px"),
  { key: "breath", label: "Breathe (pulse)", kind: "bool", path: "breath", cemented: false },
  numX("wordIdx", "Word index", "wordIdx", 0, 20, 1),
];
export const MOTIONBLUR_KNOBS: Knob[] = [
  num("amount", "Amount", "amount", 0, 1.5, 0.05),
  num("maxBlur", "Max blur", "maxBlur", 4, 200, 1, "px"),
];

// ---- 씬 전환 / 카메라 ----
// 근거: editor-prop-audit — 전환 필드는 transition_out 에 flat 저장되므로 노브
// 경로는 "props." 접두 없이 bare key 여야 한다(이전엔 props.direction 이라 no-op).
// text_collapse_fill 은 frames 가 아니라 collapseFrames/fillFrames 를 읽는다.
const dirEnum = (): Knob => enumX("direction", "Direction", "direction", ["left", "right", "up", "down"], "left");
const framesKnob = (def: number): Knob => ({ ...num("frames", "Duration", "frames", 4, 30, 1, "frames"), default: def });

export const SCENE_TRANSITION_SCHEMA: Record<string, { title: string; knobs: Knob[]; defaultProps: () => Record<string, unknown> }> = {
  slide_push: {
    title: "slide_push",
    knobs: [dirEnum(), framesKnob(12)],
    defaultProps: () => ({ type: "slide_push", direction: "left", frames: 12 }),
  },
  zoom_punch: {
    title: "zoom_punch",
    // feel 은 compose 개념(toScale 로 매핑) — 엔진은 toScale 을 직접 읽으므로 toScale 노출.
    knobs: [numX("toScale", "Zoom scale", "toScale", 0.3, 2, 0.05, "x"), framesKnob(10)],
    defaultProps: () => ({ type: "zoom_punch", toScale: 1.5, frames: 10 }),
  },
  wipe_collapse: {
    title: "wipe_collapse",
    knobs: [dirEnum(), framesKnob(14)],
    defaultProps: () => ({ type: "wipe_collapse", direction: "left", frames: 14 }),
  },
  light_sweep: {
    title: "light_sweep",
    knobs: [colorX("color", "Color", "color"), num("angle", "Angle", "angle", 0, 360, 5, "deg"), framesKnob(12)],
    defaultProps: () => ({ type: "light_sweep", color: "#FFFFFF", angle: 110, frames: 12 }),
  },
  // text_collapse_fill: UI 제거 (사용자 요청) — 구 스펙 렌더는 엔진 경로 유지
};

export const CAMERA_SCHEMA: Record<string, { title: string; knobs: Knob[]; defaultProps: () => Record<string, unknown> }> =
  Object.fromEntries(
    Object.entries(CAMERA_MOTIONS).map(([name, entry]) => [
      name,
      {
        title: name,
        knobs: [
          num("fromScale", "Scale from", "fromScale", 0.5, 5, 0.05, "x"),
          num("toScale", "Scale to", "toScale", 0.5, 5, 0.05, "x"),
          easing("easing", "Easing", "easing"),
        ].filter(() => name === "push_in"),
        defaultProps: () => ({ type: entry.type, ...structuredClone(entry.cemented) }),
      },
    ]),
  );

// 문서/씬 상수
export const FONT_OPTIONS = [
  { value: "General Sans", label: "General Sans" },
  { value: "Syne", label: "Syne" },
  { value: "Familjen Grotesk", label: "Familjen Grotesk" },
  { value: "Geist", label: "Geist" },
  { value: "Inter", label: "Inter" },
];
export const WEIGHT_OPTIONS = [200, 300, 400, 500, 600, 700, 800].map((w) => ({
  value: String(w),
  label: String(w),
}));
