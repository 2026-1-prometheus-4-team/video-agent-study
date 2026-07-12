// compose/catalog.ts
// LLM용 효과 설명 카탈로그. registry.ts(구조/cemented/exposed)와 분리해서,
// "이 효과가 시각적으로 어떻게 보이는지 / 언제 쓰는지 / 각 노브가 뭘 하는지"를
// 기술적으로 서술한다. buildMenu()가 registry + 이 카탈로그를 합쳐 LLM 메뉴를
// 만든다. 설명은 구체적으로: 모션의 실제 궤적 + 용도(어떤 텍스트에 맞는지).

export type EffectDoc = {
  // 이 효과가 실제로 어떻게 보이는지(모션 궤적) + 언제 쓰는지.
  desc: string;
  // exposed 노브별 설명(enum 값의 의미 포함).
  knobs?: Record<string, string>;
};

export const STRUCTURAL_DOCS: Record<string, EffectDoc> = {
  typewriter: {
    desc: "글자(또는 단어)가 한 개씩 순차로 나타나는 담백한 타이핑. 옵션으로 커서 깜빡임. 코드/터미널/설명문/자막처럼 '읽어나가는' 느낌이 필요할 때. 임팩트는 약함.",
    knobs: {
      unit: "char=글자 하나씩, word=단어 하나씩 타이핑.",
      cursor: "none=커서 없음, light=밝은 커서 깜빡, dark=어두운 커서 깜빡.",
    },
  },
  characters_settle: {
    desc: "각 글자가 이전 글자에 약 2/3 겹친 채(제자리보다 왼쪽) 작게+사선으로+흐릿하게 나타나, 오른쪽으로 미끄러지며 커지고 회전 0으로 또렷해지며 제자리에 안착. 기존 글자들은 왼쪽으로 밀려 중앙정렬 유지. 타이핑보다 '한 글자씩 조립되는' 정교한 프리미엄 느낌. 짧은 제목/워드마크/1~2단어 헤드라인에 최적.",
  },
  word_gap_settle: {
    desc: "단어들이 넓게 벌어진 간격에서 흐릿하게(+살짝 아래) 나타나, 간격이 좁아지며 또렷하게 위로 떠올라 안착하는 '쫀득한' 등장. 여러 단어 문장/태그라인에 적합. 문장 전체가 리듬감 있게 조여지며 완성되는 느낌.",
  },
  flicker: {
    desc: "문장 대부분이 처음엔 안 보이고, 글자들이 화면 여기저기서 랜덤하게 깜빡(꺼짐/반투명/켜짐)인다. 한곳에 뭉치지 않고 흩어져 깜빡이며, 시간이 갈수록 켜진 글자가 늘어 마지막에 전부 켜지며 완성. 글리치/디지털/신호 잡히는 느낌. 브랜드명·강조 단어의 임팩트 등장.",
  },
  letters_whoosh: {
    desc: "글자들이 화면 밖 아래(또는 위)에서 빠르게 수루룩 솟아오르며(끝에 살짝 오버슈트 바운스) 왼쪽부터 순차 등장. 경쾌하고 속도감 있는 등장. 짧은 단어/제목, 리스트 항목 등.",
    knobs: {
      direction: "up=아래에서 위로 솟아오름, down=위에서 아래로 내려옴.",
    },
  },
  letter_roll: {
    desc: "슬롯머신 릴처럼 각 글자가 세로로 촤르륵 굴러가다 최종 글자에 감속하며 딱 멈춤. 인접 글자는 서로 반대방향으로 굴러 '한 대의 기계'처럼 읽힘. 숫자/코드/역동적 워드마크에 강함.",
    knobs: {
      mode: "stagger=릴이 왼쪽부터 하나씩 멈춤(슬롯/룰렛, 스냅 임팩트), together=전부 같은 순간 천천히 감속해 멈춤(느긋한 breather).",
    },
  },
  letter_scatter: {
    desc: "글자들이 흩어진 위치에서 회전하며 제자리로 빨려들어 조립되거나(in), 제자리에서 사방으로 흩어지며 사라짐(out). 등장/퇴장 임팩트, 파편이 모여 단어가 되는 연출.",
    knobs: {
      mode: "in=흩어진 상태에서 제자리로 조립, out=제자리에서 흩어져 소멸.",
    },
  },
  stat_reveal: {
    desc: "강조 숫자가 카운트업하며 안착하는 통계/수치 전용 효과. suffixMode=reveal이면 라벨(ATMs 등)이 글자별로 튀어나오며 숫자가 왼쪽으로 슬라이드하는 '쇼케이스'(+55 ATMs 같은 핵심 지표), static이면 단위(%,kW)가 붙은 채 숫자가 목표값에 닿는 순간 통 튀는 착지 바운스(98%, 4.2 kW 같은 평범 카운터). 도달 순간 landColor로 물들었다 빠지는 색 강조 가능.",
    knobs: {
      prefix: "숫자에 붙는 고정 문자(+, $, % 등). 카운팅 안 됨.",
      prefixSide: "left=숫자 앞(+55), right=숫자 뒤(55%).",
      suffix: "숫자 뒤 라벨/단위(ATMs, kW, %). suffixMode로 등장 방식 결정.",
      suffixMode: "reveal=라벨이 글자별로 등장하며 숫자 왼쪽 슬라이드(쇼케이스), static=단위가 그냥 붙어있고 슬라이드 없이 착지 바운스만(평범 카운터).",
      from: "카운트 시작 값(보통 0).",
      to: "카운트 목표 값(강조할 숫자).",
      baseColor: "숫자 기본 색.",
      landColor: "목표값 도달 순간 물드는 색(빨강 등). 이후 baseColor로 서서히 빠짐. baseColor와 같게 주면 색 강조 off.",
    },
  },
  words_up: {
    desc: "단어 단위로 화면 아래에서 흐릿하게 떠올라 왼쪽부터 순차로 또렷해지며 안착(오버슈트 없이 깔끔). 여러 단어 문장/헤드라인에 담백하고 안정적인 등장. characters_settle보다 조립감은 약하고 문장 전체가 위로 정돈되는 느낌.",
  },
  words_down: {
    desc: "words_up과 같되 단어들이 화면 위에서 아래로 흐릿하게 내려와 안착. 상단에서 쏟아지듯 들어오는 헤드라인/자막에.",
  },
  apple_text: {
    desc: "단어들이 강한 블러(거의 안 보임)에서 초점이 맞으며 또렷해지는 애플 키노트식 등장. 단어별로 순차로 선명해진다. 프리미엄/제품 발표 톤. glow(soft)와 함께 쓰면 라이팅까지 붙어 '무대 조명 아래 등장' 느낌. 짧은 제품명/슬로건에 최적.",
  },
  typewriter_erase: {
    desc: "이미 보이는 문장이 글자(또는 단어) 단위로 지워지며 사라짐. typewriter(등장)의 반대 동작 — structuralOut 슬롯 전용이라 같은 요소에 typewriter(등장)+typewriter_erase(퇴장)를 동시에 쓸 수 있다(예: 타이핑으로 나타났다 지워지고 다음 문장으로). 자막/코드/타이핑 대화 톤의 씬 전환에.",
    knobs: {
      eraseFrom: "left=왼쪽부터 지움(커서가 뒤로 가는 느낌), right=오른쪽부터 지움, edges=양끝에서 동시에 지움(가운데로 좁혀짐).",
    },
  },
};

export const WRAPPER_DOCS: Record<string, EffectDoc> = {
  fade: { desc: "요소 전체가 투명→불투명으로 페이드 인. 어떤 structural 위에도 얹어 부드러운 등장." },
  blur: { desc: "요소 전체가 흐릿→또렷으로 블러 인. 초점 맞춰지는 느낌." },
  scale: {
    desc: "요소 전체 크기 애니(등장 시 커지며 안착). feel로 바운스 성격 선택.",
    knobs: {
      feel: "pop=톡 튀어 빠르게 안착, bounce=통통 스프링(여러 번 튐), settle=오버슈트 없이 부드럽게 확대 안착.",
    },
  },
  move: {
    desc: "요소 전체가 한 방향에서 제자리로 슬라이드 등장.",
    knobs: {
      dir: "up=아래서 위로, down=위서 아래로, left=오른쪽서 왼쪽으로, right=왼쪽서 오른쪽으로.",
    },
  },
  flip: {
    desc: "요소 전체가 3D Y축으로 회전(rotateY)하며 정면으로 안착. 카드가 뒤집혀 앞면이 보이는 느낌. 짧은 단어/워드마크의 임팩트 등장. 문서상 '최고 퀄' 기법으로 분류.",
    knobs: {
      feel: "half=측면(-90도)에서 정면으로 반바퀴, full=뒷면(-180도)에서 한바퀴 돌아 안착, bounce=반바퀴 회전에 착지 오버슈트(살짝 튐).",
    },
  },
  shrink_into_place: {
    desc: "요소가 크게(약 2.5배) 나타나 원래 문장 자리 크기로 수축하며 안착. 한 단어를 크게 강조했다 문맥으로 되돌리는 '히어로 워드' 연출. 문장 중 특정 단어 강조에.",
  },
  shrink_out: {
    desc: "요소가 제자리에서 빠르게 쪼그라들며 사라짐(scale 1->0.4, easeIn). 짧고 담백한 훅 퇴장 — 다음 컷으로 바로 넘어갈 때. 근거: punch 프리셋 실측값.",
  },
  fly_out: {
    desc: "요소가 빠르게 쪼그라들며(scale 1->0.2) 동시에 좌/우로 튕겨나가듯 이동(move ±0.4)하며 퇴장. hero_zoom 급 강한 임팩트 종료. 원본은 effects.motionBlur(방향성 블러)를 항상 같이 걸어 '가로로 번지는' 속도감을 낸다 — fly_out 은 wrapper 단독이라 그 스트리크가 자동으로 안 붙는다. 원본 느낌을 원하면 같은 요소에 effects:{motionBlur:{enabled:true}} 를 별도로 켜야 한다.",
    knobs: {
      dir: "right=오른쪽으로 튕겨나감, left=왼쪽으로 튕겨나감.",
    },
  },
};

// ---------------------------------------------------------------------------
// B축 — 씬(스크린 전체) 전환 + 카메라. element 에 안 걸리고 sceneWrap 전체에
// 걸린다(A축 wrapper/structuralOut 과 독립 스택, 동시 사용 가능).
// ---------------------------------------------------------------------------
export const SCENE_TRANSITION_DOCS: Record<string, EffectDoc> = {
  slide_push: {
    desc: "나가는 씬 전체가 화면 밖으로 밀려나며 다음 씬이 드러남. 모멘텀 컷(디졸브 아님) — 대시보드/UI 캡처처럼 화면 자체가 이동하는 느낌의 제품 데모에 잘 맞는다.",
    knobs: { direction: "밀려나가는 방향(left/right/up/down). down 이 요즘 흔한 '뚝 떨어지는' 드롭컷." },
  },
  zoom_punch: {
    desc: "나가는 씬이 줌하며 페이드. feel=dive_in 이면 화면 속으로 파고들듯 확대되며 사라짐(강한 전진감), zoom_out 이면 화면이 멀어지듯 축소되며 사라짐(여운/축소 컷).",
    knobs: { feel: "dive_in=확대하며 파고들어 컷, zoom_out=축소하며 멀어져 컷." },
  },
  wipe_collapse: {
    desc: "엣지가 한쪽에서 닫히듯 나가는 씬을 가려 다음 씬을 드러냄. 컷을 리빌 동작 뒤에 숨기는 방식이라 하드컷보다 정돈된 인상.",
    knobs: { direction: "닫히는 엣지의 진행 방향(left/right/up/down)." },
  },
  light_sweep: {
    desc: "밝은 빛줄기가 화면을 스윕하고 그 아래서 컷이 일어남. 고에너지 컷을 luminance flash 로 가리는 방식 — 강렬한 브랜드 컬러 전환에.",
    knobs: { color: "스윕 빛줄기 색(브랜드 컬러 추천)." },
  },
  text_collapse_fill: {
    desc: "화면의 텍스트가 수평으로 짓눌리며(가로로 스미어) 블러 낀 얇은 띠가 된 뒤, 그 자리서 컬러 바가 화면 전체로 채워 넘어감. 텍스트 중심 브랜드 씬의 시그니처 전환.",
    knobs: { stops: "채워지는 바의 그라디언트 색(브랜드 컬러 2개 이상 권장)." },
  },
};

export const CAMERA_DOCS: Record<string, EffectDoc> = {
  push_in: {
    desc: "씬 내내 서서히 줌인(렌즈가 다가가는 느낌). 정적인 씬에 은은한 긴장감/집중을 더할 때. 숫자는 고정(fromScale 1 -> toScale 1.4) — 켜고 끄기만 고른다.",
  },
  follow_caret: {
    desc: "타이핑 중인 캐럿을 화면이 자동으로 따라 팬. 긴 문장이 타이핑되며 화면 밖으로 나가지 않게 잡아준다. 파라미터 없음(자동).",
  },
};

// 조합 규칙/구조를 LLM에게 설명하는 문구. buildMenu가 메뉴 상단에 넣는다.
export const COMPOSE_GUIDE = [
  "광고는 scenes(화면들) 배열. 각 씬은 duration(초)과 elements(요소들)를 가진다.",
  "각 element는 structural 효과 1개(위 목록 택1) + 텍스트/폰트/색/위치(position 0~1) + wrappers(여러 개 스택) + glow.",
  "structural은 글자를 그리는 리빌이라 요소당 딱 1개. wrappers(scale/move/fade/blur)와 glow는 그 위에 여러 개 겹칠 수 있다.",
  "structuralOut은 structural과 별개 슬롯(퇴장 전용, 현재 typewriter_erase만). 같은 요소에 structural(등장)+structuralOut(퇴장)을 동시에 쓸 수 있다(타이핑으로 등장 후 지워지며 퇴장 같은 조합).",
  "여러 element를 group으로 묶으면 그룹 단위 모션(scale/move)이 자식 전부에 함께 걸린다(피그마 프레임처럼).",
  "group에 layout:{preset:'circle'|'arc'|'wave', orient:'upright'|'tangent', loop:true, speed:'slow'|'normal'|'fast', radius}를 주면 자식들이 경로 위에 등간격 배치되어 흐른다. circle+upright = 대관람차(궤도는 돌되 카드는 수평 유지), wave+tangent = 물결을 따라 헤엄치듯 이동. 타이밍 수치는 고정이라 speed enum만 고른다. swing:true(감쇠 진자 살랑임)는 사용자가 명시적으로 흔들림을 요구할 때만 — 기본은 절대 켜지 않는다(둥둥 떠다니는 idle 모션은 저품질로 간주). layout:{type:'orbit', radius, tilt, loop:true, speed}는 3D 수평 궤도 — 카드들이 앞에선 크게, 뒤로 돌면 작아지며 뒤로 지나가는 회전 쇼케이스(로고 월/제품 캐러셀).",
  "{input:{text, button, accent, position, width}} 는 프롬프트 입력창 연출(AI 제품 데모 필수) — 입력박스가 떠오르고 텍스트가 사람 타이핑 리듬으로 쳐진 뒤 전송 버튼이 정확히 타이핑 끝나는 프레임에 pop. 타이핑 속도/버튼 타이밍은 cemented(글자 수로 자동 계산).",
  "어떤 요소든(텍스트/이미지/도형/그룹) motionPath:{preset:'arc'|'wave'|'circle'|d, orient:'tangent'|'none', travel:true 또는 loop:true+speed}를 붙이면 그 요소가 경로(선)를 따라 이동한다(AE 의 paste path to position 등가). travel=한 번 이동(2초 고정), loop=무한 순환. orient tangent 는 경로 방향으로 자동 회전(Auto-Orient).",
  "이미지 요소는 {image:{src, width, height, position, decompose?}} 로 넣는다. decompose 는 정적 UI 스크린샷을 조각으로 잘라 아래에서 순차 bounce 조립하는 효과(SaaS 제품 데모의 핵심) — 노브는 mode('grid'|'masks'), cols/rows(grid 분할), rects(masks 모드 fraction 사각형들), entry('bottom'|'top'|'left'|'right', 조각이 날아오는 방향)만. 타이밍/탄성 수치는 실측 고정이라 지정 불가.",
  "A축(요소 퇴장)과 B축(씬 전체 전환)은 완전히 다른 레이어다. A축은 wrappers에 shrink_out/fly_out 같은 role:out 효과를 넣는 것(요소 하나만 사라짐). B축은 씬의 transitionOut/camera 필드로, 화면 전체가 한 덩어리로 전환된다(요소가 뭘 하든 상관없음). 둘은 동시에 걸 수 있다 — 요소가 shrink_out 하면서 씬 자체도 slide_push 하는 식.",
  "씬의 transitionOut: 'hard_cut'(기본, 즉시 컷) | 'fade' | {type: 아래 sceneTransitions 목록 중 하나, ...노브}. 씬의 camera: {type: 아래 camera 목록 중 하나}(카메라는 숫자 노브 없음, 종류만 선택).",
  "숫자 등 세부 타이밍/곡선 수치는 프리셋에 고정돼 있어 지정 불가. 효과 이름 + 아래 노출 노브 + 텍스트/색/위치만 정한다.",
].join(" ");

// 색(L4) 설명. surface.color 는 단색. 그라디언트/팔레트는 color:{mode,colors[]} 로.
export const COLOR_DOCS = {
  desc: "텍스트 색 채움. 기본은 surface.color 단색. color:{mode, colors[]} 로 그라디언트/팔레트 지정 가능.",
  knobs: {
    mode: "solid=단색(surface.color 사용), gradient=colors[]가 이어지는 연속 그라디언트(단어/글자 걸쳐 흐름), palette=단어마다 colors[]를 순환 배정(단어별 색 구분/정보 hierarchy).",
    colors: "gradient/palette 에서 쓸 색 배열(hex). gradient 는 2개 이상, palette 는 단어 수만큼 순환.",
  },
};

// 문서명 정렬 — scene24_motion_engine_spec.md 표기 <-> 우리 효과 이름 매핑.
// (우리 이름을 canonical 로 두고, 문서 볼 때 대조용. 하드 리네임은 안 함:
//  기존 스펙/registry 키 깨짐 방지 + stat_reveal 등은 문서보다 기능이 넓음.)
export const SPEC_NAME_MAP: Record<string, string> = {
  typewriter: "typewriter",
  characters_settle: "scale_rotation_snap (문서: 확대+회전 안착) / characters_down 계열",
  word_gap_settle: "scale_words + sequential_build (자간 수렴 + 단어 순차)",
  flicker: "flicker",
  letters_whoosh: "words_up 의 글자(char) 단위 판",
  letter_roll: "롤링(문서 6절 그룹 효과의 텍스트판)",
  letter_scatter: "characters_snap (scatter-assemble)",
  stat_reveal: "number_count (기능 확장판: prefix/suffix/착지/색)",
  words_up: "words_up",
  words_down: "words_down",
  apple_text: "apple_text",
  "flip (wrapper)": "flip_text (3D rotateY)",
  "shrink_into_place (wrapper)": "scale_words 계열 히어로 수축",
  "typewriter_erase (structuralOut)": "문서에 대응 항목 없음(우리 쪽 신규 — demo-spec.json 기존 실사용 패턴을 registry 로 승격)",
  "shrink_out (wrapper)": "문서 1.4 표준 퇴장(fade+shrink+소폭 업슬라이드) 중 shrink 부분만 분리한 축소판. punch 실측값.",
  "fly_out (wrapper)": "문서에 직접 대응 항목 없음 — hero_zoom 실측값(scale+move 동시 out) 승격.",
  "slide_push (scene transition)": "slide_through 계열이나 단순화판. 문서는 다음 씬이 반대편에서 겹쳐 진입하는 전체 크로스이나, 우리 구현은 나가는 씬의 EXIT 변형만(하드컷으로 이어짐, 겹침 없음).",
  "zoom_punch (scene transition)": "zoom_focus_cut 과는 다른 정체 — 문서 기법 특유의 홀드+pan+정렬 착시(3개 조건)는 미구현. 단순 scale+fade 다이브/줌아웃일 뿐.",
  "wipe_collapse (scene transition)": "expand_reveal 의 역방향 개념(엣지가 닫히며 리빌)에 가깝지만 정확한 대응은 아님.",
  "light_sweep (scene transition)": "specular_strobe 와 결이 비슷하나 반복 스트로브 없이 1회성 스윕.",
  "text_collapse_fill (scene transition)": "TEXT_MOTION_SPEC 5.2 자체 규격. 문서 2절 트랜지션 목록엔 대응 항목 없음.",
};
