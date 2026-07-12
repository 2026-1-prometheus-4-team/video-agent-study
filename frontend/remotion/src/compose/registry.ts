// compose/registry.ts
// 효과 레지스트리 — EFFECT_CONTRACTS.md 를 코드로 옮긴 것.
// named 효과마다 { cemented(고정 수치) + exposed(LLM 지정 가능) } 을 정의한다.
// compose() 가 exposed 값을 검증해서 cemented 위에 병합해 실제 layer props 를 만든다.
//
// 원칙: 세부 수치/곡선/타이밍 = cemented(LLM 불가). affix/범위/모드/방향/색 등
// 상황별 시각차만 = exposed. 숫자 튜닝은 LLM 이 못 박는다.
//
// 이 모듈은 motion 내부 타입에 의존하지 않는다(순수 JSON 스펙 데이터). 그래서
// compose 계층만 따로 테스트/재사용 가능하다.

// exposed 노브 하나의 스키마. compose 가 이걸로 검증(enum/clamp)한다.
export type ExposedField =
  | { kind: "string"; default?: string }
  | { kind: "color"; default?: string }
  | { kind: "bool"; default?: boolean }
  | { kind: "number"; default?: number; min?: number; max?: number }
  | { kind: "enum"; values: string[]; default: string }
  // 색 배열(예: text_collapse_fill 의 stops). gradient/palette 의 colors[] 와 같은 성격.
  | { kind: "colorList"; default?: string[] };

export type ExposedSchema = Record<string, ExposedField>;

// structural named 효과 정의.
export type StructuralEffect = {
  atom: string; // layer type (ComposedText 가 아는 structural 타입)
  role?: string; // 기본 "in"
  // 항상 고정으로 들어가는 atom props.
  cemented: Record<string, unknown>;
  // LLM 이 지정 가능한 노브(화이트리스트 + 검증 스키마). atom prop 으로 그대로 매핑.
  exposed: ExposedSchema;
  // exposed enum 하나가 cemented 세트를 통째로 바꾸는 경우(예: whoosh 방향,
  // roll 모드, scatter in/out). variantKey 가 그 exposed 키.
  variantKey?: string;
  variants?: Record<string, Record<string, unknown>>;
  // base(텍스트 스타일) 기본값. surface 에서 덮어씀.
  base?: Record<string, unknown>;
};

const r = <T extends Record<string, StructuralEffect>>(x: T): T => x;

export const STRUCTURAL_EFFECTS = r({
  // 1) 기본 타이핑
  typewriter: {
    atom: "typewriter",
    cemented: { mode: "type", charsPerSecond: 14, cadence: "human", seed: 7 },
    exposed: {
      unit: { kind: "enum", values: ["char", "word"], default: "char" },
      cursor: { kind: "enum", values: ["none", "light", "dark"], default: "none" },
    },
  },

  // 2) characters_settle — 겹쳤다 슬라이드+회전+블러로 안착 (우측앵커 reflow)
  characters_settle: {
    atom: "typewriter",
    cemented: {
      unit: "char",
      mode: "type",
      charsPerSecond: 20,
      cursor: "none",
      cadence: "uniform",
      reflow: "smooth",
      reflowSmoothing: 7,
      revealBlur: { from: 3, duration: 5 },
      revealScale: { from: 0.55, duration: 7 },
      revealRotate: { from: 12, duration: 7 },
      revealX: { from: -0.6, duration: 7 },
    },
    exposed: {},
  },

  // 3) word_gap_settle — 단어 간격 벌어졌다 좁아지며 쫀득 등장(base44 statement)
  word_gap_settle: {
    atom: "typewriter",
    cemented: {
      unit: "word",
      cursor: "none",
      firstGap: 9,
      wordGap: 3,
      lastGap: 15,
      revealGap: { from: 1.8, duration: 10, easing: "easeOut" },
      revealMove: { y: 0.18, duration: 10 },
      revealBlur: { from: 6, duration: 8 },
      reflow: "smooth",
      reflowSmoothing: 12,
      reflowLead: 5,
    },
    exposed: {},
  },

  // 4) flicker — 여기저기 깜빡이며 하나씩 안착
  flicker: {
    atom: "letter_flicker",
    cemented: {
      unit: "char",
      seed: 7,
      revealFrames: 40,
      flickerHold: 1,
      litProbStart: 0.15,
      litProbEnd: 0.92,
      partialChance: 0.35,
      partialOpacity: 0.4,
      settleStartFrac: 0.3,
    },
    exposed: {},
  },

  // 5) letters_whoosh — 알파벳 단위 빠른 수루룩 (위/아래)
  letters_whoosh: {
    atom: "letter_stagger",
    cemented: { unit: "char", order: "ltr", staggerTotal: 8, staggerEasing: "linear" },
    exposed: {
      direction: { kind: "enum", values: ["up", "down"], default: "up" },
    },
    variantKey: "direction",
    variants: {
      up: {
        perLetter: {
          duration: 10,
          easing: "easeOutBack",
          channels: { opacity: { from: 0, to: 1 }, y: { from: 0.9, to: 0 }, blur: { from: 6, to: 0 } },
        },
      },
      down: {
        perLetter: {
          duration: 10,
          easing: "easeOutBack",
          channels: { opacity: { from: 0, to: 1 }, y: { from: -0.9, to: 0 }, blur: { from: 6, to: 0 } },
        },
      },
    },
  },

  // 6) letter_roll — 슬롯머신 릴 (하나씩 멈춤 / 같이 멈춤)
  letter_roll: {
    atom: "letter_roll",
    cemented: { firstDir: 1, blurFactor: 4, seed: 23 },
    exposed: {
      mode: { kind: "enum", values: ["stagger", "together"], default: "stagger" },
    },
    variantKey: "mode",
    variants: {
      stagger: { settleMode: "stagger", stagger: 2, duration: 28, rollSpeed: 1.8, freeFrac: 0.55 },
      together: { settleMode: "together", duration: 96, freeFrac: 0 },
    },
    base: { fontWeight: 800, letterSpacing: -0.02 },
  },

  // 7) letter_scatter — 흩어졌다 조립 / 제자리서 흩어져 소멸
  letter_scatter: {
    atom: "letter_scatter",
    cemented: { seed: 7, verticalBias: 0.6 },
    exposed: {
      mode: { kind: "enum", values: ["in", "out"], default: "in" },
    },
    variantKey: "mode",
    variants: {
      in: { mode: "in", spread: 0.35, stagger: 1.5, rotation: 25, duration: 18, easing: "easeOutQuart" },
      out: { mode: "out", spread: 0.4, rotation: 30, preHold: 10, duration: 16, scatterHold: 4, fadeFrames: 12 },
    },
    base: { fontWeight: 700 },
  },

  // stat_reveal — 강조 숫자 카운트 + 도달 색 + 좌측 슬라이드 + suffix 등장
  stat_reveal: {
    atom: "stat_reveal",
    cemented: {
      countDuration: 55,
      countEasing: "linear",
      colorDrainDur: 14,
      scaleFrom: 1.06,
      settleFrac: 0.7,
      landBounce: 0.12,
      suffixScale: 0.5,
      suffixGap: 0.06,
      suffixDelay: 0,
      suffixStagger: 1,
      suffixSettleDur: 5,
      suffixScaleFrom: 0.55,
      suffixRotateFrom: 12,
      suffixBlurFrom: 0.12,
      slideDelay: 0,
      slideDuration: 10,
      slideEasing: "easeOutBack",
    },
    exposed: {
      prefix: { kind: "string", default: "+" },
      suffix: { kind: "string", default: "" },
      from: { kind: "number", default: 0, min: 0, max: 1000000 },
      to: { kind: "number", default: 100, min: 0, max: 1000000 },
      prefixSide: { kind: "enum", values: ["left", "right"], default: "left" },
      suffixMode: { kind: "enum", values: ["reveal", "static"], default: "reveal" },
      baseColor: { kind: "color", default: "#111111" },
      landColor: { kind: "color", default: "#E23B3B" },
    },
    base: { fontWeight: 500 },
  },

  // 9) words_up — 단어 단위로 아래에서 블러 풀리며 순차 등장 (문서: words_up)
  // 근거: specs/text-motion/words-test.json (letter_stagger word, 실측 튜닝값)
  words_up: {
    atom: "letter_stagger",
    cemented: {
      unit: "word",
      order: "ltr",
      staggerTotal: 12,
      staggerEasing: "linear",
      perLetter: {
        duration: 10,
        easing: "easeOutExpo",
        channels: {
          opacity: { from: 0, to: 1 },
          blur: { from: 14, to: 0 },
          y: { from: 0.6, to: 0 },
        },
      },
    },
    exposed: {},
  },

  // 10) words_down — 단어 단위로 위에서 블러 풀리며 순차 등장 (문서: words_down)
  words_down: {
    atom: "letter_stagger",
    cemented: {
      unit: "word",
      order: "ltr",
      staggerTotal: 12,
      staggerEasing: "linear",
      perLetter: {
        duration: 10,
        easing: "easeOutExpo",
        channels: {
          opacity: { from: 0, to: 1 },
          blur: { from: 14, to: 0 },
          y: { from: -0.6, to: 0 },
        },
      },
    },
    exposed: {},
  },

  // 11) apple_text — 강블러에서 선명해지며 단어별 등장(애플 키노트). glow 와 궁합.
  // 근거: specs/text-motion/apple-text-test.json (blur 26~28 -> 0, easeOut)
  apple_text: {
    atom: "letter_stagger",
    cemented: {
      unit: "word",
      order: "ltr",
      staggerTotal: 14,
      staggerEasing: "linear",
      perLetter: {
        duration: 13,
        easing: "easeOut",
        channels: {
          opacity: { from: 0, to: 1 },
          blur: { from: 26, to: 0 },
          y: { from: 0.14, to: 0 },
        },
      },
    },
    exposed: {},
  },

  // typewriter_erase — 타이핑 반대: 이미 보이는 문장을 글자(또는 단어) 단위로
  // 소거. role "out" 이라 STRUCTURAL_EFFECTS 안에서 유일하게 퇴장용. compose 의
  // structuralOut 슬롯 전용(structural 은 등장 1개, structuralOut 은 퇴장 1개 —
  // 서로 다른 슬롯이라 한 요소에 typewriter(in, type) + typewriter_erase(out)
  // 동시 장착 가능. 근거: demo-spec.json "discover" 씬에서 이미 실사용 중인
  // 조합(type 14cps 로 등장 -> erase 16cps left 로 퇴장) — 새 값 아니라 기존
  // 프로덕션 패턴을 registry 로 승격한 것.
  typewriter_erase: {
    atom: "typewriter",
    role: "out",
    cemented: { unit: "char", mode: "erase", charsPerSecond: 16 },
    exposed: {
      eraseFrom: { kind: "enum", values: ["left", "right", "edges"], default: "left" },
    },
  },
});

export type StructuralEffectName = keyof typeof STRUCTURAL_EFFECTS;

// ---------------------------------------------------------------------------
// L2 Wrapper — 스택(on/off). feel/dir 만 exposed, 수치는 cemented.
// ---------------------------------------------------------------------------
export type WrapperEffect = {
  atom: string;
  role?: string;
  cemented: Record<string, unknown>;
  exposed?: ExposedSchema;
  variantKey?: string;
  variants?: Record<string, Record<string, unknown>>;
  // compound: 한 named effect 가 atom 여러 개를 동시에 건다(예: fly_out = scale+move
  // 동시 out). 있으면 atom/cemented 는 무시되고 parts 전체가 layer 로 펼쳐진다.
  // exposed/variants 는 각 part 의 props 에 동일하게 병합된다(무관한 키는 해당
  // atom 이 그냥 무시함 — 예: dir variant 의 toX 는 scale part 엔 안 쓰이고 버려짐).
  parts?: Array<{ atom: string; role?: string; cemented: Record<string, unknown> }>;
};

export const WRAPPER_EFFECTS: Record<string, WrapperEffect> = {
  fade: { atom: "fade", cemented: { duration: 8 } },
  blur: { atom: "blur", cemented: { from: 10, to: 0, duration: 10, easing: "easeOut" } },
  scale: {
    atom: "scale",
    cemented: {},
    exposed: { feel: { kind: "enum", values: ["pop", "bounce", "settle"], default: "settle" } },
    variantKey: "feel",
    variants: {
      pop: { from: 0.85, to: 1, duration: 14, easing: "easeOutBack" },
      bounce: { from: 0.86, to: 1, duration: 18, easing: "springOut" },
      settle: { from: 0.9, to: 1, duration: 12, easing: "easeOutExpo" },
    },
  },
  move: {
    atom: "move",
    cemented: {},
    exposed: { dir: { kind: "enum", values: ["up", "down", "left", "right"], default: "up" } },
    variantKey: "dir",
    variants: {
      up: { fromY: 0.15, toY: 0, duration: 14, easing: "easeOutExpo" },
      down: { fromY: -0.15, toY: 0, duration: 14, easing: "easeOutExpo" },
      left: { fromX: 0.15, toX: 0, duration: 14, easing: "easeOutExpo" },
      right: { fromX: -0.15, toX: 0, duration: 14, easing: "easeOutExpo" },
    },
  },
  // flip — 3D Y축 플립(rotateY)으로 정면 안착. 문서 flip_text("최고 퀄 기법").
  // 근거: specs/text-motion/flip-test.json (fromDeg -90/-180, dur 18/22)
  flip: {
    atom: "flip",
    cemented: { toDeg: 0 },
    exposed: { feel: { kind: "enum", values: ["half", "full", "bounce"], default: "half" } },
    variantKey: "feel",
    variants: {
      half: { fromDeg: -90, duration: 18, easing: "easeInOut" },
      full: { fromDeg: -180, duration: 22, easing: "easeInOut" },
      bounce: { fromDeg: -90, duration: 18, easing: "easeOutBack" },
    },
  },

  // shrink_into_place — 히어로 단어가 크게 나타나 문장 자리로 수축 안착.
  // 근거: wrappers/shrinkIntoPlace.ts (TEXT_MOTION_SPEC 1.5, fromScale 2.5)
  shrink_into_place: {
    atom: "shrink_into_place",
    cemented: { fromScale: 2.5, fromX: 0, fromY: 0, duration: 16, easing: "easeOutExpo" },
  },
  // mask 는 아톰 미구현이라 미노출(로드맵).

  // --- A축: 요소 exit(퇴장) wrapper. role "out" — punch/hero_zoom 프리셋에
  // 박제돼 있던 실측값을 재사용 가능한 named effect 로 승격(2026-07-07 감사).
  // shrink_out — 요소가 제자리에서 빠르게 쪼그라들며 사라짐. 컷 직전 "훅" 느낌.
  // 근거: presets/hook/punch.ts scale-out(from 1.0, to 0.4, 8f, easeIn).
  shrink_out: {
    atom: "scale",
    role: "out",
    cemented: { from: 1.0, to: 0.4, duration: 8, easing: "easeIn" },
  },
  // wiggle — 유기적 미세 흔들림(위치/회전/스케일). 요소별 seed 로 "비슷한데
  // 다 다른" 무빙. role hold(등장~퇴장 사이 지속).
  wiggle: {
    atom: "wiggle",
    role: "hold",
    cemented: { freq: 2, posAmp: 0.015, rotAmp: 0, scaleAmp: 0, seed: 1 },
  },
  // masked_reveal — 소프트 그라디언트 마스크가 왼->오로 쓸리며 드러나는 동시에
  // 단어가 오른쪽에서 왼쪽으로 미끄러져 들어오는 히어로 타이틀 리빌 (레퍼런스:
  // SaaS 프로모 "Build" 오프닝 실측 — 마스크 front 와 슬라이드가 함께 움직임).
  // AE 등가: Linear Wipe(고 feather) + Position 키프레임.
  masked_reveal: {
    atom: "mask_wipe", // 대표 atom(참고용) — parts 전체가 펼쳐진다
    cemented: { duration: 24, feather: 0.35 },
    parts: [
      { atom: "mask_wipe", cemented: { duration: 24, feather: 0.35, easing: "easeOut" } },
      { atom: "move", cemented: { fromX: 0.055, toX: 0, duration: 30, easing: "easeOutExpo" } },
    ],
  },
  // fly_out — 빠르게 쪼그라들며 좌/우로 튕겨나가듯 퇴장(scale+move 동시).
  // 근거: presets/hero/hero_zoom.ts scale-out(1.0->0.2, 18f, easeIn) +
  // move-out(±0.4, 8f, easeIn). 방향만 노출, 나머지 실측값 고정.
  // 주의: 원본 hero_zoom 은 effects.motionBlur(amount 0.6, maxBlur 50) 를 항상
  // 같이 걸어서 "가로로 번지는" 속도감이 난다 — fly_out 은 wrapper 단독이라
  // 그 스트리크가 없다. 원본 느낌 그대로 재현하려면 element.effects.motionBlur
  // 를 별도로 켜야 한다(자동으로 안 딸려옴, wrapper 와 effects 는 독립 스택).
  fly_out: {
    atom: "scale", // 대표 atom(참고용). 실제로는 parts 전체가 펼쳐짐.
    role: "out",
    cemented: {},
    exposed: { dir: { kind: "enum", values: ["left", "right"], default: "right" } },
    variantKey: "dir",
    variants: {
      right: { toX: 0.4 },
      left: { toX: -0.4 },
    },
    parts: [
      { atom: "scale", cemented: { from: 1.0, to: 0.2, duration: 18, easing: "easeIn" } },
      { atom: "move", cemented: { fromX: 0, toX: 0.4, duration: 8, easing: "easeIn" } },
    ],
  },
};

export type WrapperName = keyof typeof WRAPPER_EFFECTS;

// ---------------------------------------------------------------------------
// B축 — 씬(스크린 전체) 전환 + 카메라. element 에 안 걸림: SceneRenderer 가
// sceneWrap 통째로 변형하거나(transition_out) 씬 내내 렌즈를 움직인다(camera).
// A축(요소 exit)과 완전히 독립된 스택이라 동시에 걸 수 있다.
// 근거: motion/effects/transitions.ts 의 실측 주석(base44_analysis.md,
// premium_motion_factors.md) — 여기 cemented 는 그 파일에 이미 있던 값을
// 그대로 가져온 것(2026-07-07 감사, 만들어놓고 compose 에 미노출 상태였음).
// ---------------------------------------------------------------------------
export type SceneTransitionEffect = {
  type: string; // SceneRenderer.SceneSpec["transition_out"] 의 discriminant 와 동일
  cemented: Record<string, unknown>;
  exposed?: ExposedSchema;
  variantKey?: string;
  variants?: Record<string, Record<string, unknown>>;
};

export const SCENE_TRANSITIONS: Record<string, SceneTransitionEffect> = {
  // slide_push — 나가는 씬이 화면 밖으로 밀려남(모멘텀 컷, 디졸브 아님).
  // 근거: base44 대시보드 push 실측 ~250px/s.
  slide_push: {
    type: "slide_push",
    cemented: { frames: 12 },
    exposed: {
      direction: { kind: "enum", values: ["left", "right", "up", "down"], default: "left" },
    },
  },
  // zoom_punch — 줌하며 페이드. feel 로 "파고들며 컷"(다이브인) vs
  // "멀어지며 컷"(줌아웃) 선택. 근거: base44 zoom 1.0->1.5 (~0.3s).
  zoom_punch: {
    type: "zoom_punch",
    cemented: { frames: 10 },
    exposed: {
      feel: { kind: "enum", values: ["dive_in", "zoom_out"], default: "dive_in" },
    },
    variantKey: "feel",
    variants: {
      dive_in: { toScale: 1.5 },
      zoom_out: { toScale: 0.6 },
    },
  },
  // wipe_collapse — 엣지가 닫히며 다음 씬이 드러남(컷 숨기는 리빌).
  wipe_collapse: {
    type: "wipe_collapse",
    cemented: { frames: 14 },
    exposed: {
      direction: { kind: "enum", values: ["left", "right", "up", "down"], default: "left" },
    },
  },
  // light_sweep — 빛줄기가 스윕하며 그 아래로 컷이 숨음(고에너지 컷 은폐).
  // 근거: premium_motion_factors.md factor 5.
  light_sweep: {
    type: "light_sweep",
    cemented: { frames: 12, angle: 110 },
    exposed: {
      color: { kind: "color", default: "#FFFFFF" },
    },
  },
  // text_collapse_fill — 텍스트가 수평으로 짓눌리며(scaleY 1->0.06, scaleX
  // 1->1.3) 블러 스미어된 뒤, 그 자리서 바가 자라 화면을 가득 채움.
  // 근거: TEXT_MOTION_SPEC 5.2.
  text_collapse_fill: {
    type: "text_collapse_fill",
    cemented: { collapseFrames: 12, fillFrames: 12 },
    exposed: {
      stops: { kind: "colorList", default: ["#FFFFFF"] },
    },
  },
};
export type SceneTransitionName = keyof typeof SCENE_TRANSITIONS;

export type CameraMotion = {
  type: string; // SceneRenderer.CameraSpec["type"] 와 동일
  cemented: Record<string, unknown>;
  exposed?: ExposedSchema;
};

// 카메라는 숫자 노브를 아예 안 연다 — "어떤 카메라를 쓸지"만 LLM 이 고른다.
// fromScale/toScale/easing 은 실측 근거 없는 임의값이 될 위험이 커서 cemented.
export const CAMERA_MOTIONS: Record<string, CameraMotion> = {
  // push_in — 씬 내내 서서히 줌인. 근거: demo-spec.json "think" 씬 실사용값.
  push_in: {
    type: "push_in",
    cemented: { fromScale: 1, toScale: 1.4, easing: "linear" },
    exposed: {},
  },
  // follow_caret — 타이핑 캐럿을 따라 화면이 자동 팬. 파라미터 없음(자동 추종).
  follow_caret: {
    type: "follow_caret",
    cemented: {},
    exposed: {},
  },
};
export type CameraMotionName = keyof typeof CAMERA_MOTIONS;
