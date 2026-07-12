// compose/menu.ts
// buildMenu(): registry(구조 + exposed 스키마)와 catalog(기술 설명)을 합쳐
// LLM 이 읽을 "효과 메뉴판"을 만든다. 이 JSON 을 LLM 시스템 프롬프트/툴 스키마에
// 넣으면 LLM 이 어떤 효과가 있고 각 노브가 뭘 하는지 알고 조합을 뱉는다.

import {
  STRUCTURAL_EFFECTS,
  WRAPPER_EFFECTS,
  SCENE_TRANSITIONS,
  CAMERA_MOTIONS,
  type ExposedSchema,
} from "./registry";
import {
  STRUCTURAL_DOCS,
  WRAPPER_DOCS,
  SCENE_TRANSITION_DOCS,
  CAMERA_DOCS,
  COMPOSE_GUIDE,
  COLOR_DOCS,
  SPEC_NAME_MAP,
} from "./catalog";

export type MenuKnob = {
  name: string;
  type: "string" | "color" | "bool" | "number" | "enum" | "colorList";
  values?: string[];
  range?: [number | null, number | null];
  default?: unknown;
  desc: string;
};

function knobDocs(
  schema: ExposedSchema,
  docs?: Record<string, string>,
): MenuKnob[] {
  return Object.keys(schema).map((name) => {
    const f = schema[name];
    const knob: MenuKnob = { name, type: f.kind, desc: docs?.[name] ?? "" };
    if (f.kind === "enum") {
      knob.values = f.values;
      knob.default = f.default;
    } else {
      if (f.default !== undefined) knob.default = f.default;
      if (f.kind === "number" && (f.min != null || f.max != null)) {
        knob.range = [f.min ?? null, f.max ?? null];
      }
    }
    return knob;
  });
}

export function buildMenu() {
  const structural = Object.keys(STRUCTURAL_EFFECTS).map((name) => ({
    effect: name,
    desc: STRUCTURAL_DOCS[name]?.desc ?? "",
    knobs: knobDocs(
      STRUCTURAL_EFFECTS[name as keyof typeof STRUCTURAL_EFFECTS].exposed,
      STRUCTURAL_DOCS[name]?.knobs,
    ),
  }));

  const wrappers = Object.keys(WRAPPER_EFFECTS).map((name) => {
    const def = WRAPPER_EFFECTS[name];
    return {
      type: name,
      desc: WRAPPER_DOCS[name]?.desc ?? "",
      knobs: def.exposed ? knobDocs(def.exposed, WRAPPER_DOCS[name]?.knobs) : [],
    };
  });

  // B축: 씬 전체 전환 + 카메라. wrappers(A축, 요소 하나만 퇴장)와 별개 —
  // 씬의 transitionOut/camera 필드로 넣는다(둘 다 element 가 아니라 scene 소속).
  const sceneTransitions = Object.keys(SCENE_TRANSITIONS).map((name) => {
    const def = SCENE_TRANSITIONS[name];
    return {
      type: name,
      desc: SCENE_TRANSITION_DOCS[name]?.desc ?? "",
      knobs: def.exposed ? knobDocs(def.exposed, SCENE_TRANSITION_DOCS[name]?.knobs) : [],
    };
  });

  const camera = Object.keys(CAMERA_MOTIONS).map((name) => {
    const def = CAMERA_MOTIONS[name];
    return {
      type: name,
      desc: CAMERA_DOCS[name]?.desc ?? "",
      knobs: def.exposed ? knobDocs(def.exposed, CAMERA_DOCS[name]?.knobs) : [],
    };
  });

  const effects = [
    {
      type: "glow",
      desc: "요소 주변에 빛 번짐(bloom). 라이팅/프리미엄 강조. structural 위에 얹는다.",
      knobs: [
        { name: "strength", type: "enum" as const, values: ["soft", "strong"], default: "soft", desc: "soft=은은한 후광, strong=강한 블룸." },
        { name: "color", type: "color" as const, desc: "글로우 색. 'auto'면 텍스트 색을 따라감." },
      ],
    },
  ];

  const surface = [
    { name: "text", type: "string", desc: "요소에 표시할 텍스트(stat_reveal 은 무시, from/to/prefix 로 숫자 구성)." },
    { name: "fontSize", type: "number", desc: "화면 폭 대비 vw. 제목 6~13, 자막 2~3." },
    { name: "fontWeight", type: "number", desc: "폰트 굵기 200~700(굵을수록 큰 값)." },
    { name: "color", type: "color", desc: "텍스트 단색. 그라디언트/팔레트는 아래 color 블록으로." },
    { name: "position", type: "object", desc: "{x,y} 0~1 화면 비율 위치(기본 중앙 0.5,0.5)." },
  ];

  const color = {
    desc: COLOR_DOCS.desc,
    knobs: [
      { name: "mode", type: "enum" as const, values: ["solid", "gradient", "palette"], default: "solid", desc: COLOR_DOCS.knobs.mode },
      { name: "colors", type: "string" as const, desc: COLOR_DOCS.knobs.colors },
    ],
  };

  return {
    guide: COMPOSE_GUIDE,
    structural,
    wrappers,
    sceneTransitions,
    camera,
    effects,
    color,
    surface,
    scene: {
      desc: "scenes[] 로 여러 화면. 각 씬 { duration(초), background?, transitionOut?, camera?, elements[] }. transitionOut: 'hard_cut'|'fade'|{type: sceneTransitions 중 하나, ...노브} — 씬 전체가 다음 씬으로 어떻게 넘어가는지(A축 wrappers 와 독립, 요소가 뭘 하든 상관없이 화면 전체가 전환). camera: {type: camera 중 하나} — 씬 내내 렌즈가 어떻게 움직이는지(숫자 노브 없음, 종류만 선택). element 는 단일 요소 { structural, structuralOut?, surface, wrappers?, effects?, color? } 또는 그룹 { group:[요소들], motion:[wrapper들] }.",
    },
    // 문서(scene24_motion_engine_spec.md) 표기 대조용. 런타임엔 안 쓰임.
    specNameMap: SPEC_NAME_MAP,
  };
}
