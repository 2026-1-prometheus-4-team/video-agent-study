# 텍스트 모션 효과 컨트랙트

이 문서는 구현된 텍스트 모션 전체를 LLM이 "조합"으로 만들 수 있게 일반화하기 위한 계약서다.
각 효과마다 LLM이 지정 가능한 것(EXPOSED)과 프리셋으로 고정하는 것(CEMENTED)을 정의한다.
이 표가 LLM 조합 스키마 + 검증기의 근거다.

---

## 0. 원칙

- **EXPOSED (LLM 지정 가능)**: 상황에 따라 시각적으로 달라야 하는 것만.
  - 텍스트 내용 / 폰트 크기 / 색
  - affix 내용과 위치 (예: "+"가 왼쪽/오른쪽, "+" 대신 다른 문자)
  - 숫자 범위 (from ~ to)
  - "무엇을" 선택하는 모드/방향 (예: 위/아래, stagger/together, in/out)
  - 효과 켜고/끄기 (toggle)
- **CEMENTED (프리셋 고정, LLM 불가)**: 세부 수치·곡선·타이밍 전부.
  - duration, easing, scale 양, stagger 프레임, blur px, spread, 확률, 임계값 등
  - 이건 실측으로 튜닝한 값이라 잠근다. LLM이 숫자를 못 박는다.

한 줄: **LLM은 "무엇을 켜고, 뭘 넣을지"만. 숫자 튜닝은 절대 안 건드린다.**

---

## 1. 계층 (조합 규칙)

| 계층 | 선택 방식 | 내용 |
|---|---|---|
| L1 Structural | 택1 (radio) | 글자 그리는 리빌. 한 시점 하나만 |
| L2 Wrapper | 스택 (checkbox) | 요소 전체 모션. 여러 개 동시 |
| L3 Effects | 스택 (checkbox) | glow, motionBlur |
| L4 Color | 택1 모드 | solid / gradient / palette |
| Surface | 값 지정 | text, fontSize, fontWeight, position |

검증 규칙: **L1은 2개 이상이면 reject(또는 role 시퀀스로 분리). L2·L3는 자유 스택.**

---

## 2. L1 Structural 효과 (택1)

| 효과 | 아톰 | EXPOSED | CEMENTED |
|---|---|---|---|
| typewriter | typewriter | unit(char/word), cursor(none/light/dark) | charsPerSecond, cadence, seed |
| characters_settle | typewriter(+revealX/scale/rotate/blur) | — (텍스트만) | reveal 전부(from/duration), 우측앵커 reflow |
| word_gap_settle | typewriter(+revealGap/reflow/revealMove) | — | gap 1.8/10, reflow 12/lead5, move 0.18, blur |
| flicker | letter_flicker | (opt) speed 토큰 | revealFrames, flickerHold, litProb, settleStartFrac, partial |
| letters_whoosh | letter_stagger(char+y) | direction(up/down) | staggerTotal, duration, easing, y량, blur |
| letter_roll | letter_roll | mode(stagger/together) | rollSpeed, freeFrac, duration, blurFactor, seed |
| letter_scatter | letter_scatter | mode(in/out) | spread, rotation, stagger, duration, verticalBias |
| stat_reveal | stat_reveal | prefix, prefixSide(left/right), suffix, suffixMode(reveal/static), from, to, baseColor, landColor | count/scale/color drain/slide/suffix 타이밍, landBounce 전부 |
| words_up | letter_stagger(word+y) | — (텍스트만) | staggerTotal12, duration10 easeOutExpo, y0.6, blur14 |
| words_down | letter_stagger(word+y) | — | words_up 과 동일, y -0.6 |
| apple_text | letter_stagger(word+blur) | — | staggerTotal14, duration13 easeOut, blur26, y0.14 (glow 궁합) |

> 참고: 같은 아톰(typewriter)에서 나온 characters_settle / word_gap_settle 는 각각 다른 "named 효과"다. reveal 내부값이 서로 다르게 고정돼 있고, LLM은 이름만 고른다.
>
> **stat_reveal 이 카운터 전담**: `suffixMode:"reveal"`=affix 글자별 등장 + 좌측 슬라이드 쇼케이스(+55 ATMs), `"static"`=평범 카운터(단위 정적, 슬라이드 없이 착지 바운스, 예 4.2 kW / Build 42%). number_counter 아톰은 제거하고 stat_reveal 로 통합했다.
>
> 제거된 효과: path_in, marquee_rows, number_count, letter_choreography(bespoke, s1c 전용 아톰으로만 잔존).

---

## 3. L2 Wrapper (스택, on/off)

| wrapper | 역할 | EXPOSED | CEMENTED |
|---|---|---|---|
| fade | 페이드 in/out | on/off | duration, easing |
| blur | 블러 in/out | on/off | from/to px, duration |
| scale | 스케일/바운스 | on/off, feel(pop/bounce/settle) | from/to, easing(springOut/easeOutBack), duration |
| move | 슬라이드 | on/off, dir(up/down/left/right) | 거리, duration, easing |
| flip | 3D Y축 플립(rotateY) | on/off, feel(half/full/bounce) | fromDeg(-90/-180), duration, easing |
| shrink_into_place | 커졌다 제자리 축소(히어로) | on/off | fromScale2.5, duration16, easeOutExpo |
| mask | 마스크 와이프 | (아톰 미구현 = 로드맵) | — |

> "바운스"는 scale wrapper의 feel=bounce(=springOut/easeOutBack) 로 켠다. 오버슈트 양은 고정.

---

## 4. L3 Effects (스택, on/off)

| effect | EXPOSED | CEMENTED |
|---|---|---|
| glow | on/off, color, strength(soft/strong) | radius, intensity timeline |
| motionBlur | on/off | stdDeviation(속도 연동 계산) |

---

## 5. L4 Color (택1 모드)

| 모드 | EXPOSED | CEMENTED |
|---|---|---|
| solid | color | — |
| gradient | colors[], mode(flow/sweep/static) | 각도, flow 속도 |
| palette | colors[] (단어/글자별) | 전이 hold/transition |

---

## 6. LLM 조합 스키마 (스케치)

```json
{
  "structural": {
    "effect": "stat_reveal",
    "prefix": "+", "prefixSide": "left", "from": 0, "to": 55, "suffix": "ATMs",
    "suffixMode": "reveal", "baseColor": "#111111", "landColor": "#E23B3B"
  },
  "wrappers": [ { "type": "scale", "feel": "bounce" } ],
  "effects": { "glow": { "strength": "soft", "color": "auto" } },
  "color": { "mode": "solid" },
  "surface": { "fontSize": 13, "background": "#EAF1FB" }
}
```

숫자 튜닝 0개. **효과 이름 선택 + 상황 노브 + 토글**만.

---

## 7. 구현 상태

1. **효과 레지스트리** — 완료. `src/compose/registry.ts` (`STRUCTURAL_EFFECTS` 11, `WRAPPER_EFFECTS` 6, cemented+exposed).
2. **조합 검증기** — 완료. `src/compose/compose.ts` (exposed 화이트리스트 밖 노브 무시+경고, enum/범위 clamp, variant 병합). structural 은 입력 구조상 택1.
3. **LLM 스키마 생성** — 완료. `src/compose/menu.ts` `buildMenu()` → `src/compose/llm-menu.json`(structural/wrappers/effects/color/surface/scene/specNameMap).
4. **다음** — 실제 LLM 연결(menu → 조합 JSON → composeAd → 렌더), camera/transition compose 노출, UI 모션 계층(문서 5절), 3D 곡률/오디오. 상세는 `SESSION_HANDOFF.md` 5장.

---

## 부록: 현재 text-motion 스펙 ↔ 효과 매핑

| text-motion 스펙 | 효과 | 아톰 |
|---|---|---|
| typewriter-test | typewriter | typewriter |
| characters-settle | characters_settle | typewriter |
| word-gap-settle | word_gap_settle | typewriter |
| flicker-words | flicker | letter_flicker |
| letters-whoosh | letters_whoosh | letter_stagger |
| letter-roll | letter_roll | letter_roll |
| letter-scatter | letter_scatter | letter_scatter |
| stat-reveal | stat_reveal | stat_reveal |
| words-test | words_up / words_down | letter_stagger |
| apple-text-test | apple_text | letter_stagger(word+blur) |
| flip-test | flip (wrapper) + gradient color | flip |
| bounce-test | scale(feel:bounce)+move 조합 데모 | (wrapper) |
| glow-bloom-test | glow effect 데모 | (effect) |
| fade-test | fade+move(wrapper) 데모 | (wrapper) |

> 부록 매핑은 데모 스펙 기준. registry 편입(LLM 조합 가능)된 것: 위 structural 11 + wrapper 6(fade/blur/scale/move/flip/shrink_into_place) + color(solid/gradient/palette).
