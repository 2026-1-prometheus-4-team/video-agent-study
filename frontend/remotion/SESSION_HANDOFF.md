# Scene24 모션 엔진 — 세션 핸드오프

이 문서를 새 세션 첫 메시지로 붙여넣으면 이어서 작업 가능하다. 새 세션은 이 프로젝트 폴더만 안다.

---

## 0. 프로젝트 & 목표

- **Scene24**: 텍스트 모션 광고를 자동 생성하는 SaaS. Remotion(React 영상 프레임워크) 기반.
- **작업 폴더**: `labs/remotion` (모션 엔진 개발). `labs/docs`(설계 문서), `AdOps`(레퍼런스 영상 분석)는 별개.
- **최종 목표**: LLM이 효과를 "조합"해서 광고 영상을 뽑게 하기. 사용자가 문장 하나 던지면 → LLM이 효과 골라 배치 → 실제 영상.
- **핵심 원칙**: 세부 모션 수치(duration/easing/scale/타이밍)는 실측 튜닝값으로 코드에 고정(cemented). LLM은 "무엇을 켜고 뭘 넣을지"만(효과 이름 + 상황 노브 + 텍스트/색/위치). **LLM이 숫자를 못 박게 한다.**

---

## 1. 먼저 읽을 문서 (순서대로)

1. `labs/remotion/EFFECT_CONTRACTS.md` — 효과 계약서. 뭐가 있고 각 효과의 EXPOSED(LLM 지정 가능) vs CEMENTED(고정) 정리. **제일 먼저 읽어라.**
2. `labs/docs/scene24_motion_engine_spec.md` — 전체 렌더 스택 [0]~[6] 비전(오디오/트랜지션/카메라/3D/프레임그룹/텍스트). 섹션 6 = 프레임 그룹.
3. `labs/remotion/CLAUDE.md` — remotion 개발 지침/pitfalls(색·렌더 버그 디버깅 룩업).
4. `labs/remotion/src/compose/` — LLM 조합 시스템(아래 3장 참고).
5. `labs/remotion/src/compose/llm-menu.json` — 자동 생성된 LLM 메뉴판(효과 목록 + 설명 + 노브). LLM에 줄 것.

---

## 2. 아키텍처 — 렌더 계층 (현재)

```
[element 타입]  text / logo / group  (SceneRenderer.tsx)

한 text 요소 안 렌더 계층 (ComposedText.tsx):
  L1 Structural   (택1)   글자 그리는 리빌(등장). 한 시점 하나만.
  L1' StructuralOut (택1) 글자를 지우는 리빌(퇴장). structural 과 별개 슬롯 —
                          같은 요소에 등장+퇴장 동시 장착 가능. 현재 typewriter_erase 하나뿐.
  L2 Wrapper   (스택)   요소 전체 채널. registry 노출: fade/blur/scale/move/flip/
                        shrink_into_place(전부 role:in) + shrink_out/fly_out(role:out) —
                        (mask 는 아톰 미구현=로드맵)
  L3 Effects   (스택)   glow, motionBlur
  L4 Color     (택1)    solid / gradient / palette (color:{mode,colors[]})

[2] 프레임 그룹  element:"group" + children + layers(그룹 모션). 자식 전부에 그룹 transform.

씬(scene) 레벨 — 요소에 안 걸림, 화면 전체:
  transition_out   씬 전체가 다음 씬으로 어떻게 넘어가는지(sceneWrap 변형/오버레이).
  camera           씬 내내 렌즈가 어떻게 움직이는지(push_in/follow_caret).
```

**중요: 위 L2 wrapper(요소 exit)와 씬의 transition_out/camera 는 서로 다른 축이다.**
자세한 규정은 **2-3장** 참고 — 이번 세션에 정리/구현한 핵심 내용이라 새 세션은
꼭 읽어라.

**L1 Structural 효과 12개** (아톰 위에 named 설정, 11개 등장용 + 1개 퇴장용):

| 효과 | 아톰 | 한 줄 | 문서(spec) 대응 |
|---|---|---|---|
| typewriter | typewriter | 담백한 한 글자씩 타이핑 | typewriter |
| characters_settle | typewriter | 글자가 겹쳐 나타나 슬라이드+회전+블러로 조립 안착 | scale_rotation_snap 계열 |
| word_gap_settle | typewriter | 단어 간격 벌어졌다 좁아지며 쫀득 등장 | scale_words + sequential_build |
| flicker | letter_flicker | 글자 여기저기 랜덤 깜빡이며 점점 다 켜짐 | flicker |
| letters_whoosh | letter_stagger | 아래/위에서 빠르게 수루룩 솟음(글자 단위) | words_up 의 char 판 |
| letter_roll | letter_roll | 슬롯머신 릴, 굴러 감속 안착 | 롤링 |
| letter_scatter | letter_scatter | 흩어졌다 조립(in)/흩어져 소멸(out) | characters_snap |
| stat_reveal | stat_reveal | 숫자 카운트업 + 라벨 등장/착지 바운스 (통계 전용) | number_count(확장판) |
| words_up | letter_stagger | 단어 단위로 아래서 블러 풀리며 순차 등장 | words_up |
| words_down | letter_stagger | 단어 단위로 위서 블러 풀리며 순차 등장 | words_down |
| apple_text | letter_stagger | 강블러에서 선명해지며 단어별 등장(키노트) | apple_text |
| typewriter_erase | typewriter | (퇴장, role:out) 이미 보이는 문장을 글자/단어 단위로 지움. structuralOut 슬롯 전용 | 문서 대응 없음(demo-spec.json 기존 패턴 승격) |

- **Wrapper(registry 노출 8개)**: 등장(role:in) fade / blur / scale(feel) / move(dir) / **flip**(feel: half/full/bounce, 3D rotateY=문서 flip_text) / **shrink_into_place**(히어로 수축). 퇴장(role:out, 2026-07-07 신설) **shrink_out**(제자리서 빠르게 쪼그라듦, punch 실측값) / **fly_out**(쪼그라들며 좌우로 튕겨나감, hero_zoom 실측값 — scale+move 동시 거는 compound wrapper, `WrapperEffect.parts` 로 구현).
- **Color**: solid / gradient / palette. `color:{mode, colors[]}`. palette=단어별 색(문서의 단어별 그라디언트/강조), gradient=연속.
- `letter_choreography` 아톰은 남아있지만 bespoke(biasafe s1c 전용)라 LLM 메뉴엔 없음.
- 이름 매핑은 `catalog.ts` `SPEC_NAME_MAP` + `llm-menu.json.specNameMap` 에 박아둠(문서 대조용, 하드 리네임 안 함).
- **제거된 것(효과)**: number_counter(→stat_reveal로 통합), path_in, marquee_rows.

---

## 2-3. 트랜지션 규정 (A축 / B축) — 2026-07-07 신설, 반드시 읽을 것

"트랜지션"이라는 말이 뭉뚱그려 쓰이는데, 코드상 완전히 다른 두 개의 독립
레이어다. 헷갈리지 말고 이 구분으로 생각할 것.

### A축 — 요소 exit (한 요소가 사라지는 법)

- **범위**: 요소 하나. `TextElementSpec.layers` 배열에 `role:"out"` 레이어를
  넣는 것. wrapper(scale/move 등) 든 structural(typewriter erase) 든 다 여기.
- **등록 위치**: `registry.ts` `WRAPPER_EFFECTS`(shrink_out, fly_out) +
  `STRUCTURAL_EFFECTS`(typewriter_erase, `structuralOut` 슬롯 전용).
- **compose 입력**: `ComposeInput.wrappers`(배열에 `{type:"shrink_out"}` 등
  추가) + `ComposeInput.structuralOut`(등장용 `structural` 과 별개 필드).
- **타이밍 규칙**: `resolveTimings`(`core/timing.ts`)가 role:"out" 레이어를
  `total - 그 레이어의 duration` 에 앵커링한다. 즉 요소마다 exit 효과의 모양/
  길이는 다르게 줄 수 있지만(fit:"fixed" 인 보통 경우) **끝나는 시점은 씬
  종료 프레임에 다 같이 수렴한다** — 시작 시점만 effect 길이만큼 차이 남.
- **여러 요소를 한 덩어리로 동시에 퇴장시키고 싶으면**: `element:"group"`
  으로 묶고 그룹 자체의 `layers`(compose 에선 `AdGroup.motion`)에
  role:"out" 넣는다. FrameGroup 이 이미 그룹 전체에 하나의 transform 을
  걸게 돼 있어서(2절 프레임그룹 기능 재사용) 새 코드 없이 된다.
- **현재 등록된 것**: `shrink_out`(scale 1→0.4, punch 실측값), `fly_out`
  (scale 1→0.2 + move ±0.4 동시, hero_zoom 실측값 — 원본은
  `effects.motionBlur` 를 항상 같이 걸어 가로로 번지는 속도감을 내는데,
  fly_out 은 wrapper 단독이라 그 스트리크가 자동으로 안 붙는다. 원본
  느낌을 원하면 `effects:{motionBlur:{enabled:true}}` 를 요소에 별도로
  켜야 함), `typewriter_erase`(type 등장 후 글자 단위로 지워지며 퇴장 —
  demo-spec.json "discover" 씬에 이미 있던 조합을 registry 로 승격한 것).

### B축 — 씬(스크린 전체) 전환 + 카메라

- **범위**: 씬 전체. 요소가 뭘 하든 상관없이 `SceneRenderer.tsx`의
  `SceneBody`가 sceneWrap(모든 요소를 감싼 div) 통째로 변형하거나 풀스크린
  오버레이를 얹는다. 요소 개별 애니메이션과는 완전 무관.
- **등록 위치**: `registry.ts` `SCENE_TRANSITIONS`(slide_push/zoom_punch/
  wipe_collapse/light_sweep/text_collapse_fill) + `CAMERA_MOTIONS`
  (push_in/follow_caret). 실제 CSS/보간 로직은 `motion/effects/
  transitions.ts`(이미 있었음, 이번에 registry 로 노출만 새로 함).
- **compose 입력**: `AdScene.transitionOut`("hard_cut" | "fade" |
  `{type:"slide_push", direction:"left"}` 같은 객체) + `AdScene.camera`
  (`{type:"push_in"}`). 둘 다 씬 소속이지 element 소속이 아니다.
- **카메라는 숫자 노브가 없다** — `fromScale`/`toScale`/`easing` 전부
  cemented. LLM 은 "어떤 카메라를 쓸지"만 고른다(실측 근거 없는 임의
  줌량이 될 위험 때문에 일부러 안 열어둠).
- **알 수 없는 transitionOut/camera 값**: 경고만 남기고 `hard_cut`/카메라
  없음으로 안전 폴백(compose.ts `resolveTransitionOut`/`resolveCamera`).

### A축과 B축은 독립 스택 — 동시에 걸 수 있다

요소가 `fly_out` 하면서 씬 자체도 `slide_push` 하는 조합이 가능하다(둘 다
`compose/transitionsSample.ts`의 "combo" 씬에서 실증). 하나를 껐다고
다른 하나가 영향받지 않는다.

### 아직 안 된 것 / 로드맵

- L1'(structuralOut) 은 `typewriter_erase` 하나뿐. 다른 구조형 효과(예:
  letter_scatter 의 out variant)는 이미 아톰 레벨(letter_scatter mode:"out")
  엔 있는데 registry structuralOut 후보로 등록만 안 한 상태 — 편입 후보.
- B축 5개 전환 중 `scene24_motion_engine_spec.md` 2절의 `zoom_focus_cut`
  (사용자 지목 기법, 홀드+pan+정렬 착시 3조건)은 아직 미구현 — 지금
  `zoom_punch` 는 단순 scale+fade 다이브라 다른 정체. `whip_pan_blur`,
  `specular_strobe`(반복 스트로브), `concentric_ripple`, `dot_grid_fill`,
  `expand_reveal` 도 전부 미구현(로드맵). `catalog.ts SPEC_NAME_MAP` 에
  각 항목이 문서의 뭐랑 어떻게 다른지/뭐가 안 맞는지 정확히 적어뒀다.
- 검증 상태: registry/compose 레벨 배선 + node smoke test 로 확인함(정상
  케이스 + 잘못된 값 폴백 케이스 둘 다). **실제 렌더 눈 검증은 아직 안 함**
  — 스튜디오 컴포 `ComposeTransitions`(compose 통과시킨 버전) +
  `survey-transitions-survey`(raw SceneSpec, 손으로 짠 것) 두 개를 만들어
  뒀으니 다음 세션에서 스튜디오로 확인 필요.
- 버그 하나 픽스함: `text_collapse_fill` 이 화면 중앙이 아니라 최상단에
  눌어붙어 보이던 버그. 원인/수정은
  `labs/docs/pitfalls/transform-containing-block-top-pin.md` 참고
  (CLAUDE.md 버그 룩업에도 등록해둠).

---

## 3. compose 시스템 (LLM 조합 → 실제 스펙)

`labs/remotion/src/compose/`:

| 파일 | 역할 |
|---|---|
| `registry.ts` | 효과별 `cemented`(고정 수치) + `exposed`(LLM 노브 스키마) + `variants`(모드/방향). wrapper 도. **`SCENE_TRANSITIONS`/`CAMERA_MOTIONS`(B축, 2026-07-07 신설)도 여기.** |
| `catalog.ts` | 효과별 기술 설명(어떻게 보이는지/언제 쓰는지/노브 의미). LLM용. `SCENE_TRANSITION_DOCS`/`CAMERA_DOCS` 도 여기. |
| `menu.ts` | `buildMenu()` = registry + catalog 합쳐 LLM 메뉴 JSON. `sceneTransitions`/`camera` 섹션 포함. |
| `compose.ts` | `compose(요소1개)` + `composeAd(광고 한 편=씬/그룹/위치)`. 검증(exposed 화이트리스트, enum/clamp, cemented 침범 차단). `AdScene.transitionOut`/`camera` 검증도 여기(`resolveTransitionOut`/`resolveCamera`). |
| `sample.ts` | 단일 요소 데모 → Root "Compose" 컴포. |
| `adSample.ts` | LLM이 뱉을 광고 조합 예시(핀테크 3씬) → Root "ComposeAd" 컴포. |
| `transitionsSample.ts` | **(신규)** A축(shrink_out/fly_out/typewriter_erase)+B축(전환 5종+카메라 2종) 을 compose 입력으로 검증하는 8씬 샘플 → Root "ComposeTransitions" 컴포. |
| `llm-menu.json` | 생성된 메뉴판. 재생성 방법: 6장 참고(이번 세션에 새 효과 반영해서 재생성함). |

씬 레벨 raw JSON 서베이(compose 안 거치고 SceneRenderer 가 직접 먹는 것):
`specs/survey/transitions-survey.json` → Root "survey-transitions-survey"
컴포. B축 5개 전환 + 카메라 2종 + A축 3개(shrink_out/fly_out 유무 비교/
typewriter erase) 를 raw SceneSpec 으로 나열. `ComposeTransitions`(compose
경유) 와 같이 보면서 "LLM 이 이렇게 써도 실제로 이렇게 나오는지" 대조하는
용도.

**흐름**: LLM이 `adSample.ts` 같은 조합 JSON을 뱉음 → `composeAd()`가 실측 cemented 값을 얹어 완성 스펙 생성 → 렌더. `compose`는 motion 내부 타입에 의존 안 함(순수 JSON 빌더, 독립 테스트 가능).

**스튜디오 데모 컴포**: `Compose`(단일 요소), `ComposeAd`(3씬 광고), `text-motion-*`(효과별 데모), `text-motion-frame-group`(그룹).

---

## 4. 지금까지 한 것 (최근 순)

- **(2026-07-07, 세션 2) 트랜지션 A축/B축 정리 + compose 편입 + 버그 픽스**:
  - 요소 exit(A축) registry 신설: `shrink_out`(punch 실측값), `fly_out`
    (hero_zoom 실측값, scale+move compound — `WrapperEffect.parts` 타입
    확장해서 구현), `typewriter_erase`(demo-spec.json 기존 패턴 승격,
    `structuralOut` 슬롯 신설).
  - 씬 전환/카메라(B축) registry 신설: `SCENE_TRANSITIONS`(slide_push/
    zoom_punch/wipe_collapse/light_sweep/text_collapse_fill) +
    `CAMERA_MOTIONS`(push_in/follow_caret). `AdScene.transitionOut`/
    `camera` 필드로 compose 에 노출(`resolveTransitionOut`/`resolveCamera`,
    잘못된 값은 경고+hard_cut/카메라없음 폴백).
  - `catalog.ts`/`menu.ts` 에 위 전부 문서화, `llm-menu.json` 재생성
    (wrapper 8 / structural 12 / sceneTransitions 5 / camera 2).
  - **버그 픽스**: `text_collapse_fill` 이 화면 중앙 대신 최상단에 눌어붙어
    보이던 버그(transform 걸린 zero-height wrapper div 가 containing
    block 이 되는 CSS 함정). `SceneRenderer.tsx` 한 줄 수정.
    `labs/docs/pitfalls/transform-containing-block-top-pin.md` 신규 기록.
  - 검증: tsc 전체 통과(기존 three 에러만 남음), eslint 통과, node로
    compose 파이프라인 정상/오류 케이스 smoke test(잘못된 슬롯 조합은
    에러, 알 수 없는 이름은 경고+폴백 — 둘 다 확인).
  - 스튜디오 데모 2개 신설: `survey-transitions-survey`(raw SceneSpec, 13개
    구성 나열) + `ComposeTransitions`(compose 경유, 8씬) — **아직 스튜디오
    눈 검증 전.** 자세한 규정은 **2-3장** 참고.
- **(2026-07-07, 세션 1) 문서 대비 감사 + 기존 효과 compose 편입**: flip/shrink_into_place wrapper, apple_text/words_up/words_down structural, color(gradient/palette) 를 registry+catalog+menu 에 올림. `llm-menu.json` 재생성(structural 11 / wrapper 6 / color). `SPEC_NAME_MAP` 으로 문서명 정렬. UI 계층은 로드맵 유지로 재확인(5-1/5-2). composeAd 로 새 효과 조합 warnings 0 검증.
- 효과 8개 튜닝 완료. 특히 `stat_reveal`: prefix/prefixSide(좌우)/suffix/suffixMode(reveal 쇼케이스 vs static 평범카운터)/from/to/baseColor/landColor/착지 바운스/숫자슬롯 고정("+" 안 밀림).
- `number_counter` 완전 제거 → `stat_reveal`로 통합. base44/remake + stat_counter 프리셋도 마이그레이션.
- 죽은 요소 제거(marquee/path/orb/input_box/particles/swirl_orb/prompt_box + base44/remake.json).
- **프레임 그룹 [2] 구현** — `element:"group"`, SceneRenderer에 SceneElement/FrameGroup 재귀 렌더.
- **compose 시스템 구축** — registry/catalog/menu + `composeAd`(씬 레벨) + LLM 메뉴 생성 + 데모 광고(ComposeAd) 렌더까지 검증.
- `characters_down` → `characters_settle` 이름 변경.

---

## 5. 다음 할 것 (우선순위)

1. **스튜디오 눈 검증(신규, 최우선)** — 이번 세션에 만든 `survey-
   transitions-survey`(raw)와 `ComposeTransitions`(compose 경유) 를
   `npm run dev`로 실제로 재생해서 확인. 특히: (a) text_collapse_fill
   버그 픽스가 실제로 화면 중앙에 뜨는지, (b) fly_out 이 motionBlur
   없이/있이 어떻게 다른지, (c) B축 5개 전환 퀄 중 뭐가 쓸만하고 뭐가
   아닌지 골라내기. 여기서 나온 피드백으로 registry 값 조정.
2. **실제 LLM 연결** — `llm-menu.json`을 LLM 프롬프트/툴 스키마에 넣고, "이런 광고 만들어" → LLM이 `adSample`/`transitionsSample` 같은 JSON 뱉음 → `composeAd` → 렌더. 이제 A축/B축 다 메뉴에 올라가 있어서 이 연결이 "말로 광고 뽑기"의 진짜 마지막 조각.
3. **compose 마감(잔여)** — flip/shrink_into_place/apple_text/words_up/words_down/color/A축(shrink_out,fly_out,typewriter_erase)/B축(전환5+카메라2) 편입 완료(2026-07-07). 남은 것: mask 아톰 구현 후 wrapper 편입, `letter_scatter` out variant 를 structuralOut 후보로 검토, `zoom_focus_cut` 등 스펙 2절 미구현 전환들.
4. **UI 모션 계층 (문서 5절)** — neon_border_runner / light_burst / light_sweep / spotlight_breathing / metaball_morph / cursor 등. **로드맵 유지**(아래 5-1 참고 — 이전에 지운 건 계획이 아니라 저퀄 구현체다).
5. **위 스택 [3][6]** — 3D 곡률(원통/구 매핑), 오디오/비트 동기화. 아예 없음.
6. **비텍스트 요소** — 현재 logo만 element 로 남음. UI/이미지 필요하면 element 타입 + compose 편입.

### 5-1. scene24_motion_engine_spec.md 대비 정렬 상태 (2026-07-07 감사)

- **텍스트 계층 [1]**: 문서 효과 거의 다 구현됨. 안 만든 게 아니라 "compose 메뉴 노출"이 부분적이었고, 이번에 flip_text/apple_text/words_up·down/color(palette·gradient) 편입해 메뉴에 올림.
- **프레임 그룹 [2]**: 문서 6절과 일치(element:"group" + 그룹 transform).
- **접근/철학**: "요소 프리셋 + cemented 수치 + LLM 조합"(문서 8절 목적)과 일치. 실측근거 없는 수치 금지 원칙도 유지.
- **아직**: [3] 3D 곡률, [5] UI 모션 풀셋, [6] 오디오. **[4] 카메라(push_in/follow_caret)와 트랜지션(5종)은 2026-07-07 세션2 에서 compose 노출 완료** — 남은 건 문서 2절의 `zoom_focus_cut`/`whip_pan_blur`/`specular_strobe`/`concentric_ripple`/`dot_grid_fill` 같은 미구현 전환 기법들(2-3장 참고).
- **문서명 vs 우리 이름**: 하드 리네임 안 함. `SPEC_NAME_MAP`(catalog.ts) + `llm-menu.json.specNameMap` 으로 대조. 이유: registry 키/기존 스펙 깨짐 방지 + stat_reveal 등은 문서(number_count)보다 기능이 넓어 우리 이름이 더 정확.

### 5-2. 이전에 제거한 UI 요소 기록 (계획 아님, 저퀄 구현체 정리)

문서 5절 UI 모션은 **로드맵으로 살아있음**. 아래는 초기 저퀄 프로토타입이라 지운 것 — 재구현 시 이 목록 참고(제로부터 다시 만드는 게 맞음, 기존 코드 복구 아님):

- 삭제된 아톰 파일: `swirlOrb.tsx`, `promptBox.tsx`, `plasmaOrb.tsx`, `inputBox.tsx`, `particleWarp.tsx`, `ringGlow.tsx`.
- SceneRenderer 에서 뺀 element 타입: `orb`, `swirl_orb`, `input_box`, `prompt_box`, `particles`.
- 남은 비텍스트 element: `logo` 만.
- 재구현 방향: 문서 5절 스펙(빛 러너/버스트/스윕/스포트라이트/메타볼 morph/커서) 기준으로 element 타입 신설 + registry/catalog 편입. 텍스트 계층과 동일하게 cemented+exposed 구조로.

---

## 6. 검증 방법 (샌드박스 제약 있음)

- **tsc**: `npx tsc --noEmit -p tsconfig.json`. `Spike3D/SpikeInput3D/three` 관련 에러는 **기존 것이라 무시**(three 타입 선언 이슈).
- **스튜디오 눈 검증**: 사용자가 Mac에서 `npm run dev`(remotion studio). 스펙 바꿨는데 안 먹으면 `rm -rf node_modules/.cache` 후 재시작(webpack 캐시가 spec 변경 못 읽음).
- **compose 로직 검증**: 샌드박스에서 `tsx` 안 됨(node_modules esbuild가 darwin 바이너리, 여긴 linux). → `npx tsc <파일들> --outDir /tmp/x --module commonjs --skipLibCheck` 로 JS emit 후 `node /tmp/x/...` 로 실행. compose 계층은 motion 의존 없어서 이게 됨.
- **llm-menu.json 재생성**: 위 방법으로 `registry.ts catalog.ts menu.ts compose.ts` 를 같이 emit 한 뒤 `node -e "const {buildMenu}=require('./menu.js'); require('fs').writeFileSync('llm-menu.json', JSON.stringify(buildMenu(), null, 2))"`. registry 에 효과를 추가/변경했으면 반드시 재생성 — 안 하면 LLM 메뉴가 코드랑 안 맞는 상태로 남는다.
- **모션 타이밍 검증**: 렌더 못 보니 easing/타이밍은 node로 곡선 값 시뮬해서 확인(프레임별 scale/opacity 등).
- 렌더 실물은 **사용자가 스튜디오에서 확인** → 값 튜닝은 그 피드백으로.

---

## 7. 반드시 지킬 룰

- **모션 수치는 실측 근거만.** AdOps 분석 or 기존 튜닝값 기반. AI 임의값 금지(사용자 극혐). 값마다 출처 주석 권장.
- **이모지 절대 금지** — 코드/문서/스펙 어디든. (일반 채팅만 예외)
- **기존 클래스/함수/효과 이름 함부로 안 바꿈.**
- **LLM 노출 경계**: EXPOSED = 상황 따라 시각적으로 달라야 하는 것만(affix 내용/위치, 숫자 범위, 모드/방향, 색, 위치, 켜고끄기). CEMENTED = 세부 수치·곡선·타이밍 전부.
- **24fps 고정**: Root `FPS=24`. 스펙의 `fps` 필드는 스튜디오에서 무시됨. 등속(linear) count는 "프레임당 증가 ≤ 1"이어야 정수 스킵 없음(0~55 스킵없는 최고속 = countDuration 55).
- **사용자(이성민) 톤**: 부산 사투리 + 친구 톤, 답변 시작은 "저기... 성민씨,,". 단, **코드/문서/스펙은 표준 한국어**(사투리·이모지 없음). 거칠게/솔직하게, 대충하면 바로 알아챔 — 검증 중시.

---

*작성: 2026-07-06. 갱신: 2026-07-07 세션1(문서 대비 감사 + 기존 효과 compose 편입 + UI 로드맵/제거요소 기록), 세션2(트랜지션 A축/B축 registry+compose 편입, text_collapse_fill 버그 픽스, llm-menu.json 재생성 — 2-3장이 이번 세션 핵심).*
