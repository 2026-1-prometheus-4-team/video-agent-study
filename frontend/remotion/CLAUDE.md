# CLAUDE.md — Scene24 Remotion 모션 엔진

이 폴더(`labs/remotion`)는 Scene24의 JSON spec 기반 모션그래픽 엔진이다.
spec(JSON) -> React 컴포넌트(`src/motion/*`) -> Remotion 렌더.

핵심 색/모션 로직: `src/motion/color/engine.ts`, `src/motion/structural/*`,
`src/motion/ComposedText.tsx`.

---

## 버그 디버깅 — 가장 먼저 할 것

색 / 그라데이션 / 모션 / 렌더에서 이상한 증상(깜빡임, 흰색 튐, 색 안 맞음,
중간만 이상함 등)이 보이면, **코드를 다시 파기 전에 반드시
`../docs/pitfalls/`를 먼저 읽어라.** 이미 한 번씩 당한 함정만 모아놨고,
"뻔한 진단이 틀린" 케이스들이다. 똑같은 디버깅을 처음부터 반복하지 말 것.

- `pitfalls/README.md` — 인덱스
- `color-interpolation-spaces.md` — sRGB / OKLab / OKLCh 를 어디에 쓰나
- `timeline-cross-fade-endpoints.md` — transition 경계의 1프레임 점프
- `glow-on-gradient-text.md` — per-letter glow 가 깨지는 이유
- `gradient-transition-white-flash.md` — gradient + timeline transition 에서
  단어 중간 글자가 순백으로 깜빡이는 버그 (mix 함수가 "rgb(...)" 문자열을
  반환하는데 `hexToRgb` 가 못 읽어서 흰색 폴백)
- `transform-containing-block-top-pin.md` — transform 이 조건부로 걸리는
  wrapper div 에 position/inset 이 없으면 화면 중앙이 아니라 최상단에
  눌어붙는 버그 (`text_collapse_fill` 이 이걸로 깨졌었음)

증상이 새로운 거면, 해결 후 같은 형식(symptom / root cause / fix / files /
anti-patterns)으로 `pitfalls/`에 새 문서를 추가하고 README 인덱스에 넣어라.

---

## 색 파이프라인 핵심 주의 (`engine.ts`)

- mix 함수(`mixHex`/`mixHexSrgb`/`mixHexOklch`)는 **`"rgb(...)"` 문자열을
  반환**한다 (hex 가 아님).
- `fillColorAt` 이 gradient 를 보간하면 그 문자열을 내놓는다. 그 결과를 다시
  mix 에 넣는 경로(예: `letterColor` 의 transition 블렌드)가 있으면
  `hexToRgb` 가 그 문자열을 파싱할 수 있어야 한다. 안 그러면 `[1,1,1]` 흰색
  폴백. (`gradient-transition-white-flash.md`)
- 색 값 타입이 hex / "rgb()" 로 섞여 있다. 새 색 경로를 짤 때 입력이 둘 중
  뭐든 들어올 수 있다고 가정해라.

---

## 렌더 디버깅 워크플로우 (검증된 방법)

"우리 렌더 vs 원본/기대치"가 다를 때 추측하지 말고 픽셀로 잡는다:

1. ffmpeg 로 렌더 mp4 를 프레임 단위 추출 (`fps=` 는 원본 fps 에 맞춤).
2. PIL 로 **요소별/글자별 RGB 를 풀로 측정**한다 (B-G 같은 스칼라 하나만
   보지 말 것). 순백 `(255,255,255)` 이 찍히면 그건 색 계산이 아니라
   폴백 / 파싱 실패다 — 어떤 그라데이션 보간도 순백을 만들 수 없다.
3. 엔진 로직을 순수 JS 로 **미러링한 sim** 으로 같은 프레임을 재현한다.
   - 함수의 **반환 타입까지** 똑같이 (mix 는 string 반환, array 아님).
   - sim 이 버그를 재현 못 하면 sim 이 타입 / 경로를 잘못 모델한 것이다.
     실제 시그니처를 다시 맞춰라.
4. 어느 프레임(transition vs hold) / 어느 요소(stop 위 vs stop 사이)가
   깨지는지로 코드 경로를 좁힌다.

원본 레퍼런스 영상은 `../../reference/` 아래에 도메인별 폴더로 정리돼 있다.

---

## 렌더 ↔ 비교 자동화 (compare / watch:compare) — 기본 워크플로우

mp4 업로드 없이 렌더 결과를 Claude 가 직접 읽는다. scene24 가 Claude
작업공간에 연결돼 있어서, `out/compare/<id>/` 에 저장된 프레임/montage 를
Claude 가 Read + 픽셀 측정한다. 모든 모션 작업은 이 사이클로 굴린다.

- 단발:    `npm run compare -- <id> --ref <video> --refStart <sec> --crop <WxH+X+Y>`
- 상시(권장): `npm run watch:compare -- <id> ...` 를 별도 터미널에 켜두면
  `src/`(specs 포함) 변경 시 자동으로 렌더+대조. 사용자는 watcher 한 번만 켜고
  그 뒤 개입 0.

생성물 `out/compare/<id>/`: `ours.mp4`, `our_*.png`, `ref_*.png`,
`compare.png`(REF|OURS 나란히). montage(compare.png)는 imagemagick 필요
(`brew install imagemagick`). 없어도 프레임 png 는 생성되고 Claude 가 직접
측정/montage 하므로 무방.

사이클: Claude 가 spec/엔진 수정 → watcher 자동 렌더 → Claude 가
`out/compare/<id>/` 읽고 측정/분석 → 또 수정 → 반복. 렌더 자체만 사용자
Mac CPU 에서 돌고(Claude 는 sandbox 에서 직접 렌더 불가 — node_modules 가
macOS 용), 나머지는 전부 자동 + Claude 가 직접 읽음.

---

## hot-reload 주의

- `.ts` 소스 수정은 hot-reload 잘 된다.
- `require.context` 로 불러오는 `src/specs/*.json` 은 dev 서버가 변경을 다시
  안 읽는 경우가 있다. spec(JSON)만 바꿨는데 렌더가 그대로면 dev 서버를
  재시작하거나 webpack/rspack 캐시를 의심해라.
- 단, 이 가능성이 진짜 엔진 버그를 가리지 않게 — 위 2번(프레임 RGB 측정)으로
  먼저 사실을 확인한 다음 hot-reload 를 의심해라.

---

## 사용자(성민) 협업 룰

- 이모지 금지 (코드 / 문서 / 주석 어디든).
- 코드 주석은 한국어로 쓰되 기존 클래스 / 함수 이름은 함부로 바꾸지 말 것
  (`enhanced_x` 같은 리네이밍 금지).
- 대충 비슷하게 만들지 말 것. "똑같이" 요구하면 픽셀 / 타이밍 단위로 맞춘다.
- 추측으로 수정하지 말고 측정으로 근거를 만든 뒤 고친다.
- 씬 경계 모션이 끊겨 보이면 값/속도/글로우/frameOffset 연속성부터 확인
  (체크리스트: `DESIGNVERSE-HANDOFF.md`).

---

## designverse 재현 작업

designverse.mp4 재현 작업(spec: `src/specs/designverse-fst/`, 전용 element:
`src/motion/effects/designverse.tsx`)을 이어서 할 때는 **반드시
`DESIGNVERSE-HANDOFF.md` 를 먼저 읽어라.** 진행 상태, 엔진 확장 파라미터
치트시트, 씬 경계 연속성 체크리스트, 남은 작업이 정리돼 있다.
