// compose/compose.ts
// 이 파일은 Remotion 컴포넌트가 아니라 순수 스펙 빌더다(useCurrentFrame 없음).
/* eslint-disable @remotion/non-pure-animation */
// LLM 조합 입력 -> 실제 렌더 스펙(TextElementSpec / VideoSpec).
// 검증: structural 은 입력 구조상 택1(단일 객체). exposed 화이트리스트 밖 노브는
// 버리고 경고(= cemented 수치를 LLM 이 못 밀어넣게 막는 핵심). enum/범위 clamp.

import {
  STRUCTURAL_EFFECTS,
  WRAPPER_EFFECTS,
  SCENE_TRANSITIONS,
  CAMERA_MOTIONS,
  type ExposedField,
  type ExposedSchema,
  type StructuralEffect,
} from "./registry";

// compose 출력 타입(순수 JSON 스펙). normalizeSpec 이 먹는 모양과 호환된다 —
// motion 내부 타입을 import 하지 않아 이 계층만 독립 테스트/재사용 가능.
export type ComposedElement = {
  element: "text";
  base: Record<string, unknown>;
  layers: Array<{ type: string; role: string; props: Record<string, unknown> }>;
  effects?: Record<string, unknown>;
  color?: Record<string, unknown>;
  /** 요소 공통 motionPath (AE paste path to position 등가) — 씬 조립 단계에서 병합. */
  motionPath?: Record<string, unknown>;
  keyframes?: Array<Record<string, unknown>>;
};
export type ComposedVideoSpec = {
  fps: number;
  brandDefaults: { background: string; fontFamily: string; colors: string[] };
  scenes: Array<{
    id: string;
    duration: number;
    elements: ComposedElement[];
    background?: Record<string, unknown>;
    transition_out?: string | Record<string, unknown>;
    camera?: Record<string, unknown>;
  }>;
};

export type ComposeInput = {
  structural: { effect: string } & Record<string, unknown>;
  // 퇴장용 structural(현재 typewriter_erase 만 해당, role:"out" 인 것만 허용).
  // structural(등장)과 별개 슬롯이라 둘 다 동시 장착 가능(예: 타이핑으로 등장 후
  // 지워지며 퇴장). 근거: demo-spec.json "discover" 씬 기존 조합.
  structuralOut?: { effect: string } & Record<string, unknown>;
  wrappers?: Array<{ type: string } & Record<string, unknown>>;
  effects?: {
    glow?: { strength?: string; color?: string };
    motionBlur?: boolean | Record<string, unknown>;
  };
  color?: { mode: string; colors?: string[] };
  /** 요소 공통 경로 이동 — exposed: preset/d/radius/orient/offset + loop/speed/travel. */
  motionPath?: Record<string, unknown>;
  surface?: {
    text?: string;
    fontSize?: number;
    fontWeight?: number;
    fontFamily?: string;
    color?: string;
    background?: string;
    position?: { x: number; y: number };
  };
};

export type ComposeResult = { element: ComposedElement; warnings: string[] };

const has = (arr: string[], v: string): boolean => arr.indexOf(v) !== -1;

function validateField(
  key: string,
  field: ExposedField,
  raw: unknown,
  warnings: string[],
): unknown {
  if (raw === undefined) return field.default;
  switch (field.kind) {
    case "enum":
      if (has(field.values, String(raw))) return raw;
      warnings.push(`'${key}': '${String(raw)}' 은 허용 값 아님(${field.values.join("/")}) -> 기본 ${field.default}`);
      return field.default;
    case "number": {
      let n = Number(raw);
      if (!isFinite(n)) {
        warnings.push(`'${key}': 숫자 아님 -> 기본 ${field.default}`);
        return field.default;
      }
      if (field.min != null) n = Math.max(field.min, n);
      if (field.max != null) n = Math.min(field.max, n);
      return n;
    }
    case "string":
    case "color":
      return String(raw);
    case "bool":
      return Boolean(raw);
    case "colorList":
      if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw;
      warnings.push(`'${key}': 색 배열 아님 -> 기본값 사용`);
      return field.default ?? [];
  }
  return undefined;
}

function validateExposed(
  schema: ExposedSchema,
  input: Record<string, unknown>,
  scope: string,
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(schema)) {
    out[k] = validateField(k, schema[k], input[k], warnings);
  }
  // 화이트리스트 밖 노브 = cemented 침범 시도. 버리고 경고.
  for (const k of Object.keys(input)) {
    if (k === "effect" || k === "type") continue;
    if (!(k in schema)) warnings.push(`${scope}: 노출 아닌 노브 '${k}' 무시(프리셋 고정값 사용)`);
  }
  return out;
}

type Layer = { type: string; role: string; props: Record<string, unknown> };

// expectRole 로 structural(등장, "in") 과 structuralOut(퇴장, "out") 슬롯을
// 서로 못 섞게 막는다 — LLM 이 퇴장 전용 효과(typewriter_erase)를 등장 슬롯에
// 넣거나 그 반대로 넣는 실수를 여기서 바로 에러로 잡는다.
function resolveStructuralEntry(
  s: { effect: string } & Record<string, unknown>,
  warnings: string[],
  expectRole: "in" | "out",
): { layer: Layer; base: Record<string, unknown> } {
  const def: StructuralEffect | undefined =
    STRUCTURAL_EFFECTS[s.effect as keyof typeof STRUCTURAL_EFFECTS];
  if (!def) {
    const names = Object.keys(STRUCTURAL_EFFECTS).join(", ");
    throw new Error(`알 수 없는 structural 효과 '${s.effect}'. 가능: ${names}`);
  }
  const role = def.role ?? "in";
  if (role !== expectRole) {
    const slot = expectRole === "in" ? "structural" : "structuralOut";
    throw new Error(
      `structural 효과 '${s.effect}' 은 role:"${role}" 라 ${slot} 슬롯에 못 씀.`,
    );
  }
  const exposed = validateExposed(def.exposed, s, `structural(${s.effect})`, warnings);
  const props: Record<string, unknown> = { ...def.cemented };
  if (def.variantKey) {
    const sel = String(exposed[def.variantKey]);
    const variant = def.variants?.[sel];
    if (variant) Object.assign(props, variant);
  }
  for (const k of Object.keys(exposed)) {
    if (k !== def.variantKey) props[k] = exposed[k];
  }
  return {
    layer: { type: def.atom, role, props },
    base: def.base ?? {},
  };
}

function resolveStructural(
  s: { effect: string } & Record<string, unknown>,
  warnings: string[],
): { layer: Layer; base: Record<string, unknown> } {
  return resolveStructuralEntry(s, warnings, "in");
}

function resolveStructuralOut(
  s: { effect: string } & Record<string, unknown>,
  warnings: string[],
): { layer: Layer; base: Record<string, unknown> } {
  return resolveStructuralEntry(s, warnings, "out");
}

// wrapper 는 compound 일 수 있어(예: fly_out = scale+move 동시) 배열을 낸다.
// 알 수 없는 타입이면 null(호출부가 flatMap 으로 걸러 빈 배열 취급).
function resolveWrapper(
  w: { type: string } & Record<string, unknown>,
  warnings: string[],
): Layer[] | null {
  const def = WRAPPER_EFFECTS[w.type];
  if (!def) {
    warnings.push(`알 수 없는 wrapper '${w.type}' 무시. 가능: ${Object.keys(WRAPPER_EFFECTS).join(", ")}`);
    return null;
  }
  const exposed = def.exposed
    ? validateExposed(def.exposed, w, `wrapper(${w.type})`, warnings)
    : {};
  const variantOverride: Record<string, unknown> = {};
  if (def.variantKey) {
    const sel = String(exposed[def.variantKey]);
    const variant = def.variants?.[sel];
    if (variant) Object.assign(variantOverride, variant);
  }
  const extraExposed: Record<string, unknown> = {};
  for (const k of Object.keys(exposed)) {
    if (k !== def.variantKey) extraExposed[k] = exposed[k];
  }

  if (def.parts && def.parts.length > 0) {
    // variant/exposed 값은 part 마다 동일하게 병합된다. 무관한 키(예: fly_out
    // dir variant 의 toX)는 그 atom 이 안 쓰면 그냥 버려진다 — 의도된 동작.
    return def.parts.map((part) => ({
      type: part.atom,
      role: part.role ?? def.role ?? "in",
      props: { ...part.cemented, ...variantOverride, ...extraExposed },
    }));
  }

  const props: Record<string, unknown> = { ...def.cemented, ...variantOverride, ...extraExposed };
  return [{ type: def.atom, role: def.role ?? "in", props }];
}

const GLOW_STRENGTH: Record<string, { radius: number; timeline: unknown[] }> = {
  soft: { radius: 40, timeline: [{ intensity: 1.0, hold: 2, transition: 6 }, { intensity: 0.3, hold: 50 }] },
  strong: { radius: 56, timeline: [{ intensity: 1.2, hold: 2, transition: 5 }, { intensity: 0.4, hold: 50 }] },
};

function resolveEffects(
  fx: ComposeInput["effects"],
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!fx) return undefined;
  const out: Record<string, unknown> = {};
  if (fx.glow) {
    const strength = fx.glow.strength === "strong" ? "strong" : "soft";
    if (fx.glow.strength && strength !== fx.glow.strength) {
      warnings.push(`glow.strength '${fx.glow.strength}' -> soft/strong 만 가능`);
    }
    out.glow = { enabled: true, color: fx.glow.color ?? "auto", ...GLOW_STRENGTH[strength] };
  }
  if (fx.motionBlur) out.motionBlur = { enabled: true };
  return Object.keys(out).length ? out : undefined;
}

function resolveColor(
  c: ComposeInput["color"],
): Record<string, unknown> | undefined {
  if (!c || c.mode === "solid") return undefined; // solid 은 base.color 로 처리
  const stops = c.colors ?? ["#FFFFFF"];
  if (c.mode === "gradient") {
    return { timeline: [{ fill: { type: "gradient", stops }, hold: 120 }] };
  }
  if (c.mode === "palette") {
    return { timeline: [{ fill: { type: "palette", values: stops, unit: "word" }, hold: 120 }] };
  }
  return undefined;
}

export function compose(input: ComposeInput): ComposeResult {
  const warnings: string[] = [];
  const { layer, base: effectBase } = resolveStructural(input.structural, warnings);
  const outLayer = input.structuralOut
    ? resolveStructuralOut(input.structuralOut, warnings).layer
    : null;
  // flatMap 대신 reduce: tsconfig lib이 es2015 라 Array.flatMap 타입이 없다
  // (런타임엔 있지만 타입 체크가 못 잡음 -> 그냥 안 씀).
  const wrappers: Layer[] = [];
  for (const w of input.wrappers ?? []) {
    const rs = resolveWrapper(w, warnings);
    if (rs) wrappers.push(...rs);
  }
  const effects = resolveEffects(input.effects, warnings);
  const color = resolveColor(input.color);
  const s = input.surface ?? {};

  const base: Record<string, unknown> = {
    text: s.text ?? "TEXT",
    fontSize: s.fontSize ?? 6,
    color: s.color ?? "#FFFFFF",
    ...effectBase,
    ...(s.fontWeight != null ? { fontWeight: s.fontWeight } : {}),
    ...(s.fontFamily ? { fontFamily: s.fontFamily } : {}),
    ...(s.position ? { position: s.position } : {}),
  };

  const element: ComposedElement = {
    element: "text",
    base,
    layers: [layer, ...(outLayer ? [outLayer] : []), ...wrappers],
    ...(effects ? { effects } : {}),
    ...(color ? { color } : {}),
  };

  return { element, warnings };
}

// motionPath exposed 필터 — preset/d/radius/orient/offset 만 통과. 타이밍은
// cemented: travel -> v05 키프레임 쌍(f0:0 -> f48:1 easeInOut), loop 속도는
// speed enum -> durationF {slow:360, normal:240, fast:144}.
function sanitizeMotionPath(
  raw: unknown,
  warnings: string[],
): { motionPath?: Record<string, unknown>; keyframes?: Array<Record<string, unknown>> } | null {
  if (!raw || typeof raw !== "object") return null;
  const L = raw as Record<string, unknown>;
  const mp: Record<string, unknown> = {};
  for (const k of ["preset", "d", "radius", "orient", "offset"]) {
    if (L[k] !== undefined) mp[k] = L[k];
  }
  const speed = typeof L.speed === "string" ? L.speed : undefined;
  let keyframes: Array<Record<string, unknown>> | undefined;
  if (L.loop) {
    mp.loop = { durationF: speed === "slow" ? 360 : speed === "fast" ? 144 : 240 };
  } else if (L.travel) {
    keyframes = [
      { frame: 0, progress: 0 },
      { frame: 48, progress: 1, easing: "easeInOut" },
    ];
  }
  for (const k of Object.keys(L)) {
    if (!has(["preset", "d", "radius", "orient", "offset", "loop", "travel", "speed"], k)) {
      warnings.push(`motionPath: '${k}' 는 cemented/미지원 노브 — 무시함`);
    }
  }
  return { motionPath: mp, ...(keyframes ? { keyframes } : {}) };
}

// 렌더 가능한 전체 VideoSpec 으로 감싼다(스튜디오/렌더 테스트용).
export function composeVideo(
  input: ComposeInput,
  opts?: { id?: string; duration?: number; fps?: number; background?: string },
): { spec: ComposedVideoSpec; warnings: string[] } {
  const { element, warnings } = compose(input);
  const spec: ComposedVideoSpec = {
    fps: opts?.fps ?? 24,
    brandDefaults: {
      background: input.surface?.background ?? opts?.background ?? "#0D0B10",
      fontFamily: "General Sans",
      colors: ["#FFFFFF"],
    },
    scenes: [
      {
        id: opts?.id ?? "compose",
        duration: opts?.duration ?? 3,
        elements: [element],
      },
    ],
  };
  return { spec, warnings };
}

// ---------------------------------------------------------------------------
// 씬 레벨 조합 (광고 한 편). LLM 이 뱉는 최상위 입력.
//   scenes[] -> 각 씬 elements[] -> 요소(ComposeInput) 또는 group(자식 묶음).
// 요소별로 compose() 재사용, 그룹은 자식 compose + 그룹 wrapper(motion) 결합.
// ---------------------------------------------------------------------------

// 여러 요소를 하나로 묶는 그룹. motion(scale/move 등)이 자식 전부에 함께 걸린다.
/** A4 프롬프트 입력창 — 새 엔진 요소가 아니라 조합 레시피: frame(입력창 스타일)
 *  + text(typewriter, cemented 14cps) + shape(전송 버튼, 타이핑 끝나는 프레임에
 *  pop). 타이밍 결합은 compose 가 글자 수로 계산한다 (AE 에서 손으로 맞추는 것을
 *  코드가 대신). */
export type AdPromptInput = {
  input: {
    text: string;
    placeholder?: string;
    /** 전송 버튼 표시 (기본 true). */
    button?: boolean;
    /** 버튼/포커스 링 색 (기본 브랜드 1색). */
    accent?: string;
    position?: { x: number; y: number };
    width?: number; // 캔버스 폭 % (기본 44)
  };
};

export type AdGroup = {
  group: ComposeInput[];
  motion?: Array<{ type: string } & Record<string, unknown>>;
  /** B2 경로 배치 — exposed 화이트리스트만 통과(타이밍 cemented). */
  layout?: Record<string, unknown>;
};
// 브랜드 로고 element 패스스루. base(kind/size/accentColor/position) + 자체
// 등장/퇴장 램프(fadeIn/scaleIn/fadeOut/slideOut)를 그대로 넘긴다. compose 는
// motion 타입에 의존하지 않으므로 느슨한 shape 로 둔다(렌더 시 ComposedLogo 검증).
export type AdLogo = { logo: Record<string, unknown> };
// 이미지 element 패스스루(A2). base(src/width/height/position 등) + decompose 를
// 넘긴다. decompose 는 exposed 노브(mode/cols/rows/rects/entry)만 화이트리스트로
// 통과 — stagger/travel/bounce 곡선 같은 cemented 실측값(v06)을 LLM 이 못 밀어넣게
// 여기서 걸러낸다(로고와 달리 숫자 노브가 있어 느슨 통과가 아님).
export type AdImage = { image: Record<string, unknown> };
export type AdSceneElement = ComposeInput | AdGroup | AdLogo | AdImage;
// B축(씬 전체 전환/카메라). element 에 안 걸리고 씬 전체에 걸린다 — A축(요소
// exit, ComposeInput.wrappers 의 shrink_out/fly_out 등)과 독립 스택이라 동시
// 사용 가능. "hard_cut"/"fade" 는 그대로 문자열, 나머지는 SCENE_TRANSITIONS
// registry 키를 type 으로 하는 객체.
export type AdSceneTransition =
  | "hard_cut"
  | "fade"
  | ({ type: string } & Record<string, unknown>);
export type AdSceneCamera = { type: string } & Record<string, unknown>;

export type AdScene = {
  id?: string;
  duration?: number; // 초
  background?: string; // 단색 배경
  backgroundGradient?: string; // CSS 그라디언트(예: linear-gradient(...)). color 위/대신.
  backgroundFadeIn?: number; // 이 프레임 수 동안 배경 페이드 인(이전 씬 배경 위로 크로스). 시네마틱 전환.
  transitionOut?: AdSceneTransition;
  camera?: AdSceneCamera;
  elements: AdSceneElement[];
};
export type AdInput = {
  fps?: number;
  fontFamily?: string;
  background?: string; // 전 씬 공통 배경(씬별 background 로 덮어쓰기 가능)
  scenes: AdScene[];
};

function isGroup(el: AdSceneElement): el is AdGroup {
  return Array.isArray((el as AdGroup).group);
}

function isLogo(el: AdSceneElement): el is AdLogo {
  const l = (el as AdLogo).logo;
  return typeof l === "object" && l !== null && !Array.isArray(l);
}

function isInput(el: unknown): el is AdPromptInput {
  return typeof el === "object" && el != null && "input" in (el as Record<string, unknown>);
}

function isImage(el: AdSceneElement): el is AdImage {
  const m = (el as AdImage).image;
  return typeof m === "object" && m !== null && !Array.isArray(m);
}

// decompose exposed 화이트리스트 — cemented(stagger/travel/delay 등)는 버리고 경고.
const DECOMPOSE_EXPOSED = new Set(["mode", "cols", "rows", "rects", "entry"]);
function sanitizeDecompose(
  d: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (typeof d !== "object" || d === null || Array.isArray(d)) return undefined;
  const rec = d as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(rec)) {
    if (DECOMPOSE_EXPOSED.has(k)) out[k] = rec[k];
    else warnings.push(`image.decompose: '${k}' 는 cemented 노브 — 무시함`);
  }
  return out;
}

// 씬 배경을 SceneRenderer 가 읽는 shape 로. 그라디언트/페이드 지원.
function resolveBackground(
  sc: AdScene,
): { background: Record<string, unknown> } | Record<string, never> {
  if (!sc.backgroundGradient && !sc.background) return {};
  const bg: Record<string, unknown> = {};
  if (sc.background) bg.color = sc.background;
  if (sc.backgroundGradient) bg.gradient = sc.backgroundGradient;
  if (sc.backgroundFadeIn != null) {
    bg.fadeInFrame = 0;
    bg.fadeDuration = sc.backgroundFadeIn;
  }
  return { background: bg };
}

// B축: transitionOut. "hard_cut"/"fade" 는 그대로 통과, 나머지는
// SCENE_TRANSITIONS 화이트리스트로 검증 후 SceneRenderer 가 읽는
// { type, ...cemented/exposed } 로 조립. 모르는 타입/형식이면 hard_cut 로
// 안전 폴백(경고 남김) — 씬 전환 하나 잘못됐다고 전체 광고가 깨지면 안 된다.
function resolveTransitionOut(
  t: AdScene["transitionOut"],
  warnings: string[],
): string | Record<string, unknown> | undefined {
  if (t === undefined) return undefined;
  if (t === "hard_cut" || t === "fade") return t;
  if (typeof t !== "object" || t === null || typeof t.type !== "string") {
    warnings.push(`transitionOut 형식 이상 -> hard_cut 사용`);
    return "hard_cut";
  }
  const def = SCENE_TRANSITIONS[t.type];
  if (!def) {
    warnings.push(
      `알 수 없는 transitionOut '${t.type}' -> hard_cut. 가능: hard_cut, fade, ${Object.keys(SCENE_TRANSITIONS).join(", ")}`,
    );
    return "hard_cut";
  }
  const exposed = def.exposed
    ? validateExposed(def.exposed, t, `transitionOut(${t.type})`, warnings)
    : {};
  const props: Record<string, unknown> = { ...def.cemented };
  if (def.variantKey) {
    const sel = String(exposed[def.variantKey]);
    const variant = def.variants?.[sel];
    if (variant) Object.assign(props, variant);
  }
  for (const k of Object.keys(exposed)) {
    if (k !== def.variantKey) props[k] = exposed[k];
  }
  return { type: def.type, ...props };
}

// B축: camera. 숫자 노브 없음(CAMERA_MOTIONS 가 전부 cemented) — "어떤 카메라"
// 만 고른다. 모르는 타입이면 카메라 없음으로 폴백(경고).
function resolveCamera(
  c: AdScene["camera"],
  warnings: string[],
): Record<string, unknown> | undefined {
  if (c === undefined) return undefined;
  if (typeof c !== "object" || c === null || typeof c.type !== "string") {
    warnings.push(`camera 형식 이상 -> 카메라 없음`);
    return undefined;
  }
  const def = CAMERA_MOTIONS[c.type];
  if (!def) {
    warnings.push(
      `알 수 없는 camera '${c.type}' -> 카메라 없음. 가능: ${Object.keys(CAMERA_MOTIONS).join(", ")}`,
    );
    return undefined;
  }
  const exposed = def.exposed
    ? validateExposed(def.exposed, c, `camera(${c.type})`, warnings)
    : {};
  return { type: def.type, ...def.cemented, ...exposed };
}

export function composeAd(input: AdInput): {
  spec: ComposedVideoSpec;
  warnings: string[];
} {
  const warnings: string[] = [];
  const scenes = (input.scenes ?? []).map((sc, si) => {
    const elements = (sc.elements ?? []).map((el) => {
      if (isGroup(el)) {
        const children = el.group.map((child) => {
          const r = compose(child);
          for (const w of r.warnings) warnings.push(w);
          return r.element;
        });
        const layers: Layer[] = [];
        for (const w of el.motion ?? []) {
          const rs = resolveWrapper(w, warnings);
          if (rs) layers.push(...rs);
        }
        // layout(B2) — exposed 노브만 통과. progress 타이밍은 cemented(v05 48f) +
        // loop 속도는 enum(speed) -> durationF 매핑으로만 (숫자 직접 주입 금지).
        let layout: Record<string, unknown> | undefined;
        let travelKeyframes: Array<Record<string, unknown>> | undefined;
        const rawLayout = (el as AdGroup).layout;
        if (rawLayout && typeof rawLayout === "object") {
          const L = rawLayout as Record<string, unknown>;
          const isOrbit = L.type === "orbit";
          layout = { type: isOrbit ? "orbit" : "path" };
          const allowed = isOrbit
            ? ["radius", "tilt"]
            : ["preset", "d", "radius", "distribute", "orient", "swing"];
          for (const k of allowed) {
            if (L[k] !== undefined) layout[k] = L[k];
          }
          const speed = typeof L.speed === "string" ? L.speed : undefined;
          if (L.loop) {
            const durationF = speed === "slow" ? 360 : speed === "fast" ? 144 : 240;
            layout.progress = { loop: true, durationF };
          } else if (L.travel) {
            // v05 cemented: Path Progress 키프레임 2초 + Easy Ease — 정식 keyframes
            // 채널로 emit (에디터에서 키/이징을 그대로 이어서 편집 가능).
            travelKeyframes = [
              { frame: 0, progress: 0 },
              { frame: 48, progress: 1, easing: "easeInOut" },
            ];
          }
          for (const k of Object.keys(L)) {
            if (!has(["type", "preset", "d", "radius", "tilt", "distribute", "orient", "swing", "loop", "travel", "speed"], k)) {
              warnings.push(`group.layout: '${k}' 는 cemented/미지원 노브 — 무시함`);
            }
          }
        }
        return { element: "group" as const, layers, children, ...(layout ? { layout } : {}), ...(travelKeyframes ? { keyframes: travelKeyframes } : {}) };
      }
      if (isLogo(el)) {
        // 로고는 검증 없이 통과(브랜드 애셋). ComposedLogo 가 base.kind 검증.
        return { element: "logo" as const, ...el.logo };
      }
      if (isInput(el)) {
        const inp = (el as AdPromptInput).input;
        const W = Math.min(70, Math.max(24, inp.width ?? 44));
        const pos = inp.position ?? { x: 0.5, y: 0.5 };
        const accent = inp.accent ?? "#7C4DFF";
        const text = inp.text ?? "";
        // cemented: typewriter 14cps (registry) + 시작 딜레이 6f + 버튼 pop 여유 4f
        const typeFrames = Math.ceil((text.length / 14) * 24);
        const btnStart = 6 + typeFrames + 4;
        const H = 7.4; // 입력창 높이 (캔버스 %) — 1줄 프롬프트 관례
        const btn = inp.button !== false;
        // 폰트 자동 축소 — 텍스트가 버튼 전까지의 폭(박스의 ~76%)에 들어가게.
        // 글자폭 근사 0.52em (Inter 계열 소문자 평균, 관찰 기반).
        const availVw = W * 0.76;
        const fontSize = Math.min(2.1, Math.max(1.2, availVw / (0.52 * Math.max(8, text.length))));
        return {
          element: "group" as const,
          id: "prompt-input",
          layers: [],
          children: [
            {
              element: "frame",
              id: "input-box",
              base: {
                width: W,
                height: H,
                position: pos,
                fill: { type: "solid", color: "#15181E", visible: true },
                radius: 16,
                stroke: accent,
                strokeWidth: 1.5,
                clipsContent: false,
              },
              layers: [
                { type: "fade", role: "in", props: { duration: 8 } },
                { type: "scale", role: "in", props: { duration: 10, from: 0.96, easing: "easeOut" } },
              ],
              children: [],
            },
            {
              element: "text",
              id: "input-text",
              base: {
                text,
                fontSize,
                color: "#F4F6FB",
                textAlign: "left",
                position: { x: pos.x - (W / 100) * 0.44, y: pos.y },
                anchor: "left",
              },
              layers: [
                { type: "typewriter", role: "in", props: { mode: "type", charsPerSecond: 14, cadence: "human", seed: 7, cursor: "light", startDelay: 6 } },
              ],
            },
            ...(btn
              ? [
                  {
                    element: "shape",
                    id: "send-btn",
                    base: {
                      kind: "ellipse",
                      width: 2.6,
                      height: 4.6,
                      fill: accent,
                      position: { x: pos.x + (W / 100) * 0.42, y: pos.y },
                    },
                    timing: { start: btnStart },
                    layers: [{ type: "scale", role: "in", props: { duration: 8, from: 0.2, feel: "pop" } }],
                  },
                ]
              : []),
          ],
        };
      }
      if (isImage(el)) {
        // 이미지 패스스루 + decompose exposed 필터. ComposedImage 가 base.src 검증.
        const { decompose, ...rest } = el.image;
        const deco = sanitizeDecompose(decompose, warnings);
        return {
          element: "image" as const,
          ...rest,
          ...(deco && Object.keys(deco).length > 0 ? { decompose: deco } : {}),
        };
      }
      const r = compose(el);
      for (const w of r.warnings) warnings.push(w);
      return r.element;
    }).map((built, ei) => {
      // motionPath — 모든 요소 타입 공통 패스스루(단일 인터셉트 지점).
      const raw = (sc.elements[ei] as { motionPath?: unknown }).motionPath;
      const mp = sanitizeMotionPath(raw, warnings);
      if (!mp) return built;
      return { ...built, ...(mp.motionPath ? { motionPath: mp.motionPath } : {}), ...(mp.keyframes ? { keyframes: mp.keyframes } : {}) };
    });
    const transitionOut = resolveTransitionOut(sc.transitionOut, warnings);
    const camera = resolveCamera(sc.camera, warnings);
    return {
      id: sc.id ?? `scene-${si + 1}`,
      duration: sc.duration ?? 3,
      elements,
      ...resolveBackground(sc),
      ...(transitionOut !== undefined ? { transition_out: transitionOut } : {}),
      ...(camera !== undefined ? { camera } : {}),
    };
  });

  const spec = {
    fps: input.fps ?? 24,
    brandDefaults: {
      background: input.background ?? "#0D0B10",
      fontFamily: input.fontFamily ?? "General Sans",
      colors: ["#FFFFFF"],
    },
    scenes,
  } as unknown as ComposedVideoSpec;
  return { spec, warnings };
}
