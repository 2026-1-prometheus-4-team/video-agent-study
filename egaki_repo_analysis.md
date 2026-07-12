# egaki repo 정밀 분석 (Scene24 경쟁/차용 관점)

- 원본: https://github.com/remorses/egaki
- 분석일: 2026-07-05
- 버전: 0.8.0 (npm 배포, MIT)
- 저자: Tommy D. Rossi (GitHub remorses, unframer.co) - 솔로 개발
- 분석 방법: repo clone 후 gateway/엔진/CLI 소스 직접 정독 (52,943 라인 중 핵심 코드 직접 확인)

---

## 0. TL;DR (30초 요약)

egaki는 두 개가 한 패키지에 묶인 물건이다.

1. AI 미디어 생성 CLI - Veo/Kling/Imagen/GPT-image 등 113개 모델을 터미널 한 줄로 호출하는 래퍼
2. MDX-to-video 프레임워크 - Remotion 위에 얹은 저작 레이어. MDX 문서 하나가 영상이 된다.

핵심 통찰: 영상을 "평문 텍스트 파일 하나"로 환원해서 LLM이 마크다운 쓰듯 영상을 짜게 만든 것. 트윗의 "Meet egaki" 영상은 저자가 이 프레임워크로 자기 런치 광고를 직접 짠 dogfooding 결과물이다.

Scene24와의 관계: 같은 Remotion 기반 + "agents & humans" 포지셔닝 + AI가 영상 코드를 짜는 딸깍. 정면으로 겹친다. 단, egaki는 개발자용 CLI/프레임워크이고 Scene24는 노코드 웹 SaaS + 광고 특화 + 재현 파이프라인이라 결이 다르다.

---

## 1. 정체 & 팩트시트

| 항목 | 내용 |
|---|---|
| 종류 | monorepo (pnpm workspace). CLI + 비디오 엔진 + gateway + 문서사이트 + 30여 개 예제 |
| 코어 코드 | cli/ 아래 65개 소스 파일, 약 26,685 라인 TS/TSX |
| 버전 | 0.8.0 (0.0.2부터 약 14 릴리즈). 4개월 만에 코드량 약 2배 |
| 저자 | 1인 (Tommy D. Rossi). gateway는 자매 SaaS "critique"에서 복붙 |
| 테스트 | 6개 test 파일. mdx-video.test.tsx가 2,125라인/131 테스트로 최대. gateway는 테스트 0개 |
| TS 엄격도 | strict + noUncheckedIndexedAccess + verbatimModuleSyntax. AI SDK 버전 exact 핀 고정 |
| 라이선스 | MIT |

성숙도 판정: 프레임워크 코어는 진짜다(vaporware 아님). 테스트도 엔진 쪽은 촘촘하다. 단 결제/과금(gateway)은 테스트 0, 단일 squashed 커밋이라 히스토리 추적 불가, 철저히 솔로 프로젝트.

---

## 2. 아키텍처 전체 그림 (monorepo)

```
egaki/
├── cli/                         핵심 패키지 (npm 'egaki')
│   ├── src/cli/                 생성 CLI (image/video/speech/transcribe/models/auth)
│   │   ├── model-catalog.ts     113개 모델 + 가격 단일 소스 (2,336라인)
│   │   ├── generate.ts          Vercel AI SDK v6 래퍼 (912라인)
│   │   └── cached-generate.ts   빌드타임 파일 캐시 (generate once, cache forever)
│   ├── src/vite/                MDX 비디오 엔진 (여기가 심장)
│   │   ├── vite-plugin.ts       MDX 발견 + virtual module + HMR (495라인)
│   │   ├── mdx-parse.ts         헤딩→섹션, duration, FPS/BEAT (343라인)
│   │   ├── mdx-video.tsx        Series 변환 + 애니 프리미티브 + easing (976라인)
│   │   ├── keyframes.tsx        Lottie/AE 키프레임 모델 (347라인)
│   │   ├── layout-transition.tsx FLIP 씬 전환 (706라인)
│   │   ├── server-mdx.ts        RSC <Server> 슬롯 (285라인)
│   │   ├── render-client.ts     WebCodecs export (84라인)
│   │   ├── sdk.ts               window.egakiSDK 에이전트 SDK (598라인)
│   │   └── motion-timing.ts     framer-motion 프레임 결정론화 (194라인)
│   └── skills/egaki/SKILL.md    npm에 동봉한 에이전트 스킬 (배포 전술)
├── gateway/                     Cloudflare Worker (구독 수익화)
│   ├── worker.ts                Hono 프록시 + Stripe + KV 과금 (825라인)
│   └── plans.ts                 Plus $29 / Pro $99, markup 1.4배
├── website/                     문서 사이트 (별도 Worker)
├── docs/patterns.md             미구현 모션 기법 22종 (사실상 로드맵)
└── {30여 개}-example/           작동 예제 (launch-video 포함)
```

빌드 시스템 핵심: Vite를 client / ssr / rsc 3개 환경으로 돌린다. spiceflow(저자가 만든 RSC 런타임) + @vitejs/plugin-react + tailwind를 자동 주입. 즉 Remotion을 stock Webpack 번들러가 아니라 Vite + RSC 위에서 돌린다. 이게 기술적 차별점이다(아래 3-6, 8 참고).

---

## 3. MDX 비디오 엔진 원리 (심장부)

전체 파이프라인:

```
video.mdx ──▶ Vite 플러그인 ──▶ 3환경 렌더 ──▶ 브라우저 Player ──▶ WebCodecs MP4
   │              │                  │              │                    │
헤딩=씬     virtual module     client/ssr/rsc    라이브 프리뷰        FFmpeg 없음
프리미티브  frontmatter 추출   Server 슬롯       tweakpane 조정      전부 클라이언트
```

### 3-1. Vite 플러그인 (vite-plugin.ts): MDX를 코드로 바꾸는 진입점

- 프로젝트 루트의 `.mdx` 파일을 스캔해서 각각을 라우트로 만든다 (video.mdx 우선, 없으면 index.mdx).
- 3개의 virtual module을 생성한다:
  - `virtual:egaki-mdx`: 엔트리 MDX를 `?raw` 문자열로 import + frontmatter(fps/width/height)를 파싱해 컴포지션 치수로 내보냄.
  - `virtual:egaki-modules`: 프로젝트 내 모든 유저 파일(.tsx/.ts/.mdx)을 eager import한 맵. 단 `*.server.tsx`는 제외(브라우저로 절대 안 넘기는 하드 가드).
  - `virtual:egaki-app`: spiceflow RSC 앱 진입점.
- HMR이 정교하다. 엔트리 MDX가 바뀌면 RSC flight를 다시 받고, `<Server>` 슬롯 참조 파일이 바뀌면 `rsc:update` 이벤트를 쏴서 슬롯만 갱신. 일반 컴포넌트는 Fast Refresh로 player 상태를 보존한다.

핵심: MDX는 빌드 시점에 React 컴포넌트 트리로 컴파일된다. 파싱은 safe-mdx로 하고, 렌더는 remotion으로 한다.

### 3-2. 파싱 (mdx-parse.ts): 헤딩이 씬이 되는 규칙

- `splitIntoSections()`: mdast를 순회하며 `#` heading을 만날 때마다 새 섹션을 연다. heading 전 내용은 preamble(전 씬에 깔림 - BGM/배경).
- duration 파싱: `# Intro duration=3s` 에서 정규식 `\s+(duration)=(\d+)(s|fps|frames?|beats?)?` 로 뽑는다.
  - `s` -> `Math.round(v * fps)` 프레임
  - `beat/beats` -> `Math.round(v * framesPerBeat)` (음악 비트 동기화)
  - 단위 없으면 raw 프레임
- `null` duration은 "미디어에서 자동 추론"(auto-duration). Audio/Video 컴포넌트가 mediabunny로 메타데이터를 읽어 섹션 길이를 정한다.
- 스코프 변수: `FPS = fps`, `BEAT = fps / (bpm/60)`. MDX 표현식에서 `duration={2 * BEAT}` 처럼 쓴다. Math/Number/JSON 등 안전한 JS 전역도 주입.

### 3-3. 애니메이션 프리미티브 (mdx-video.tsx): 원리의 핵심

모든 프리미티브(`Opacity`, `Scale`, `TranslateX`, `TranslateY`, `Blur`)는 `useAnimateValue()` 라는 공통 훅 하나를 공유한다. 실제 구현 요지:

```
function useAnimateValue(componentName, props) {
  const frame = useCurrentFrame()              // Remotion: 현재 프레임
  const { durationInFrames, fps } = useVideoConfig()
  // tweakpane로 from/to/duration/startInFrames/easing 실시간 조정 wrap
  const { effectiveStart } = resolveAnimateStart(startInFrames, duration, cutInMotion, durationInFrames)
  const value = interpolate(
    frame,
    [effectiveStart, effectiveStart + duration],
    [from, to],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: finalEasing }
  )
  return { value, ... }
}
```

그리고 각 프리미티브는 이 value를 CSS 속성 하나에 매핑할 뿐이다:

- `Opacity`  -> `opacity: value`
- `Scale`    -> `transform: scale(value)`
- `TranslateX` -> `transform: translateX(value px)`
- `TranslateY` -> `transform: translateY(value px)`
- `Blur`     -> `filter: blur(value px)`

정리하면 프리미티브는 Remotion의 `useCurrentFrame` + `interpolate`를 감싼 얇은 래퍼다. 화면은 프레임의 순수 함수이므로 결정론적이고 seek 가능하고 프레임별 export가 된다.

디테일:
- 등장/퇴장은 `startInFrames` 부호로 판정. 양수/0 = enter(섹션 시작 기준), 음수 = exit(섹션 끝 기준).
- 기본 easing: enter = cubicBezier(0.5,0,0,1) (ease-out), exit = cubicBezier(1,0,1,1) (ease-in). spring/bounce는 기본값 아님(egaki도 ease 계열 위주 - LangEase 분석 발견과 동일 패턴).
- `cutInMotion`(0-1): 씬 경계에서 애니를 잘라 conveyor-belt 전환(컨베이어처럼 다음 씬 텍스트가 이미 움직이는 중 등장). launch-video에서 실제 사용.
- 프리미티브를 nest하면 동시 다속성 변화(예: TranslateY + Scale + Opacity 동시). AdOps에서 강조하는 "동시 3-5속성"과 정확히 같은 구조.
- 모든 프리미티브는 DOM에 `data-animation={label}` 속성을 남긴다. 에이전트가 DOM inspection으로 어떤 애니가 걸렸는지 읽으라고 만든 것.

### 3-4. Easing 엔진 + keyframes/Lottie

- mdx-video.tsx에 intensity(0-100) 기반 easing 함수 20여 종(smoothEasing, overshootEasing, bounceEasing, elasticSnapEasing...). Jitter(모션 툴) 파생.
- `cubicBezier()`는 반환 함수에 `[BEZIER_POINTS]` 심볼로 원본 제어점을 붙인다. 덕분에 tweakpane의 bezier blade가 곡선을 시각적으로 편집 가능. (그래서 AGENTS.md가 "easing은 remotion이 아니라 egaki에서 import하라"고 강제 - remotion 버전은 이 메타데이터가 없어서 편집 불가.)
- keyframes.tsx: Lottie/After Effects 키프레임 모델을 `keyframes(frame, [{time, value, easing, hold}])` 로 제공. `fromLottieProperty()`로 Lottie JSON을 직접 변환. 즉 AE/Lottie 애니를 Remotion으로 포팅하는 경로가 열려 있다.

### 3-5. Server Components (server-mdx.ts): AI 생성 미디어를 빌드타임에 인라인

- `<Server>`로 감싼 MDX 서브트리는 React Server Component로 실행(async 허용, fs/API 접근). spiceflow RSC로 클라이언트에 스트리밍.
- `.server.tsx` 파일은 자동으로 `<Server>` 래핑.
- 이 안에서 `<GeneratedImage prompt="...">`, `<GeneratedVideo>`, `<GeneratedSpeech text="...">`를 쓰면 렌더 시점에 egaki 생성 백엔드를 호출해 결과 미디어를 트리에 구워넣는다.
- cached-generate.ts가 이걸 받쳐준다: 프롬프트/파라미터/바이트를 해시한 캐시 키로 `public/generated/{namespace}/`에 파일 저장. 같은 프롬프트는 재생성 안 함(generate once, cache forever). 파라미터 바뀌면 옛 파일을 `stale/`로 옮겨 fallback으로 보여주며 재생성.

이게 plain Remotion 대비 가장 깊은 해자다. "영상이 자기 에셋을 스스로 컴파일"한다. MEMORY.md 저자 표현: "plain Remotion에서 복사 가능한 부분 없음 - RSC/MDX 파싱/컴포지션 추상화가 전부 커스텀 인프라".

### 3-6. Export (render-client.ts): WebCodecs 인브라우저, FFmpeg 없음

- `@remotion/web-renderer`의 `renderMediaOnWeb()`에 `allowHtmlInCanvas: true`로 export.
- 원리: 크로미움의 `drawElementImage` API로 매 프레임 DOM을 통째 스크린샷 -> 브라우저 내장 WebCodecs `VideoEncoder`로 h264 인코딩 -> mp4 mux. 서버도 FFmpeg도 렌더팜도 없이 전부 클라이언트.
- 하드 제약(코드 주석에 명시): scaffold wrapper의 translate/clip-path/opacity를 건드리면 Chrome paint 파이프라인이 깨져 검은 프레임이 나온다. 그래서 z-index로 덮개만 씌우는 트릭 사용.
- 함의: 렌더 인프라 비용 0. 대신 Chromium 전용 + 싱글스레드라 긴 영상/고해상도에서 브라우저 한계가 export ceiling이 된다.

참고: docs/remotion-renderer-protocol.md에서 저자는 Remotion 헤드리스 렌더러가 Webpack에 묶여있지 않고 window 함수(`remotion_setFrame` 등)만 본다는 걸 역공학으로 밝혀냈다. 즉 서버 렌더도 가능하다는 걸 알면서도 인브라우저 export를 택했다.

### 3-7. Agent SDK + motion-timing

- sdk.ts: `window.egakiSDK`에 `screenshot()`, `screenshotCurrentFrame()`, `filmstrip()`, `export()`를 노출. Playwriter(브라우저 자동화)의 `page.evaluate()`로 에이전트가 호출. binary 직렬화가 안 되니 data URL로 반환.
- motion-timing.ts: framer-motion을 쓰면 `JSAnimation.prototype`을 패치해서 WAAPI를 죽이고 수동 타이밍(`useManualTiming`)으로 강제. 매 프레임 `seekTo(ms)`로 모든 애니를 동기 샘플링 -> Remotion 프레임과 결정론적으로 일치시킴. 손으로 잡은 교훈들이 주석에 쭉 있다(stop이 arrow field라 play에서 wrap 등).

---

## 4. CLI 생성 파이프라인 (113 모델)

- generate.ts는 Vercel AI SDK v6의 얇고 잘 타입된 래퍼. 모델별 `strategy`로 분기:
  - ChatGPT/Codex 백엔드(무료로 ChatGPT 구독 태우기): `chatgpt.com/backend-api/codex/responses`에 직접 fetch, SSE 파싱.
  - 일반 image: AI SDK `generateImage()` + 프로바이더별 옵션.
  - Gemini 멀티모달: `generateText()` + `responseModalities: ['TEXT','IMAGE']`.
- model-catalog.ts: 이미지 약 81종(11개 프로바이더) + 비디오 32종. 기본 이미지 nano-banana-pro-preview, 기본 비디오 veo-3.1-fast. 가격은 수동 관리(Vercel이 순수 이미지 모델 가격을 0으로 주기 때문).
- 0.8.0에서 `egaki bpm`, `egaki loudness`(EBU R128) 온디바이스 오디오 분석 추가 - API 없이 로컬 계산. launch-video가 이걸로 비트 그리드를 맞춘다.

---

## 5. 비즈니스 모델 (gateway = 얇은 arbitrage)

- 수익 경로는 오직 하나: egaki 구독. gateway(Cloudflare Worker)가 Vercel AI Gateway를 재판매(reseller)한다.
- 마진: `MARKUP_MULTIPLIER = 1.4` (40% markup, 실효 총마진 약 29%). 예) Imagen 4 원가 $0.04 -> 유저 $0.056, egaki가 $0.016 챙김.
- 플랜: Plus $29 / Pro $99 (월). 플랜 가격 = 그 달 지출 상한. 시트/쿼터 없음. 초과 시 402.
- 인프라: Hono + Cloudflare KV(과금/키 저장, SQL 없음) + R2(업로드) + Stripe + Resend(이메일). Doppler로 시크릿 관리.
- 전략적 취약점(중요): egaki는 자기 유료 gateway를 최후 fallback으로 둔다. 인증 우선순위가 "명시 키 > OAuth > 저장된 프로바이더 키 > egaki gateway". BYOK(유저 키 직접)나 ChatGPT OAuth를 쓰면 gateway를 완전히 우회 = egaki 수익 0. 즉 파워유저는 설계상 페이월을 우회하게 되어 있고, 수익은 "키 관리 귀찮은 편의 추구층"으로 캡된다.

---

## 6. 성숙도 & 리스크

강점:
- 엔진 코어는 실물. mdx-video.test.tsx 131개 테스트, HMR e2e(Playwright)까지.
- 4개월 만에 코드 2배, 14 릴리즈. 오늘(2026-07-05)도 커밋. 빠르게 움직임.
- TS 엄격, AI SDK 버전 고정(게이트웨이 프로토콜 변경이 CLI를 조용히 깨는 것 방지).

리스크/약점:
- 철저히 솔로. gateway는 자매 SaaS "critique"에서 복붙(CritiqueKv -> EgakiKv 흔적).
- 결제/과금 코드 테스트 0개. Stripe webhook, 사용량 미터링이 무테스트.
- 단일 squashed 커밋이라 개발 히스토리 추적 불가.
- 엔터프라이즈/팀/시트/인보이스 없음. 소비자 2플랜뿐.

---

## 7. 실증: 트윗의 런치 영상 = launch-video/video.mdx

트윗의 "Meet egaki" 33.5K뷰 영상은 repo 안 `launch-video/`에 소스가 그대로 있다. 저자가 자기 제품으로 자기 광고를 만든 dogfooding이다. 실제 MDX 발췌:

- BGM: "Dark Beach by Pastel Ghost" 129.2 BPM를 playbackRate로 140 BPM 가속, 첫 다운비트에 맞춰 11프레임 trim해서 비트 그리드를 frame 0에 정렬.
- 나레이션: `<GeneratedSpeech model="sonic-3" voice="...">`로 "This launch video wasn't made in a video editor. It was written by a coding agent." 생성.
- 자막: `egaki transcribe`로 word-level 타임스탬프를 뽑아 `TypewriterTitle`에 단어별 `startSec/endSec`를 박음(비트/음성 동기).
- 14개 섹션, 각 `duration=8beats`. TranslateY + Scale + cutInMotion 조합, LightSwipe(light overlay mp4), DriftZoom, WaveGradientShader 사용.

그리고 니(성민) AdOps 방법론과 정확히 겹치는 예제 2개:
- `bible-montage/`: raw-frames(원본 프레임) -> AI-cleaned images -> grok 애니 클립 + phrases.json(word-level 타임스탬프)로 캡션 sync. 9:16 Shorts용. 니가 하는 "프레임 추출 -> 재현" 파이프라인 그 자체.
- `claude-fusion-launch/`: `reference/original.mp4` + `reference/frames/sec-001~074.png`를 두고 Remotion으로 재현. 니 AdOps CLAUDE.md의 "레퍼런스 프레임 추출 후 픽셀 단위 재현"과 동일한 작업 방식.

결론: egaki 저자도 "실제 광고를 프레임 추출해서 Remotion으로 재현"하는 방법론을 쓴다. 니 방법론이 특이한 게 아니라 이 바닥의 정석이라는 검증이자, 경쟁자가 이미 그 워크플로우를 코드로 돌리고 있다는 신호.

---

## 8. Scene24 관점: 배낄 것 / 차별화할 것 / build vs adopt

### 배낄 것 (검증된 좋은 결정)

- 저작 포맷을 raw TSX가 아니라 MDX로 잡은 것. LLM이 짜기 압도적으로 쉬움. Scene24가 AI로 영상을 뽑는다면 중간 표현(IR)을 이런 선언형 텍스트로 두는 게 유리.
- `data-animation` 같은 에이전트 inspection 훅. AI가 자기가 짠 영상을 되읽어 수정하는 루프에 필수.
- npm 패키지에 에이전트 스킬(SKILL.md) 동봉 -> Claude/Cursor가 자동으로 egaki를 집어들게. 배포 전술로 훔칠 만함.
- Vite + RSC로 Remotion을 stock Webpack에서 탈출시킨 것. HMR/서버 생성/캐싱이 다 여기서 나옴.
- docs/patterns.md의 미구현 모션 기법 22종(AI 씬 전환, 가상 카메라 팬, speed ramping, Warhol 그리드 전환 등)은 사실상 egaki 로드맵 = 니 경쟁 기능 체크리스트.

### 차별화할 것 (egaki가 안 하거나 못 하는 것)

- 서버/병렬 렌더. egaki는 인브라우저 WebCodecs라 Chromium 전용 + 싱글스레드 = 긴 영상/고해상도 ceiling. Scene24가 클라우드 병렬 렌더를 하면 명확한 차별점.
- 노코드 제품 UX. egaki는 Vite 설정 + MDX 직접 작성이 필요한 개발자 도구. Scene24의 딸깍/드래그 편집은 비개발자 타겟이라 시장이 다르다.
- 광고 특화 + 재현 파이프라인. egaki는 범용 영상 프레임워크. 니 premium_motion_factors / scatter_assemble 같은 광고 모션 요인 추출은 egaki에 없다.
- 소유 빌링/마진. egaki는 40% 재판매 마진 + gateway가 우회 가능. 자체 렌더 가치(고퀄 재현)를 얹으면 마진 구조를 egaki보다 두껍게 가져갈 수 있음.

### build vs adopt 판단 포인트

- egaki는 MIT 라이선스다. 즉 MDX 비디오 엔진(cli/src/vite/)을 렌더 레이어로 갖다 쓰는 게 법적으로 가능하다.
- adopt하면: 프리미티브/easing/RSC 생성/캐싱/WebCodecs export를 공짜로 얻고 니는 제품 UX + 광고 특화 + 재현에 집중.
- 리스크: 솔로 프로젝트 의존, 인브라우저 렌더 ceiling, gateway 종속(단 BYOK로 우회 가능). 엔진만 쓰고 gateway는 안 쓰면 종속 최소화 가능.
- 대안: 아키텍처(MDX IR + Vite RSC + interpolate 프리미티브)만 참고하고 직접 빌드 - 니가 이미 만들던 방향과 같음. 통제권은 크지만 시간 비용.

핵심 질문: 니 해자는 렌더 엔진이 아니라 "제품 UX + 광고 특화 + 재현 파이프라인"이다. 렌더 밑단을 egaki로 아웃소싱하고 위층에 집중하는 게 8월 데모데이 일정상 합리적일 수 있다. 최소한 launch-video/bible-montage 예제를 로컬에서 돌려보고 export 품질/속도를 직접 측정한 뒤 결정하는 게 맞다.

---

## 9. 검증 노트

- 직접 정독한 파일: vite-plugin.ts, mdx-parse.ts, keyframes.tsx, motion-timing.ts, render-client.ts, mdx-video.tsx(프리미티브부), sdk.ts, launch-video/video.mdx, bible-montage/AGENTS.md.
- 서브에이전트 정독: gateway/worker.ts, plans.ts, wrangler.jsonc, generate.ts, cached-generate.ts, model-catalog.ts, AGENTS.md, MEMORY.md, docs/*, SKILL.md, CHANGELOG.md.
- 색상/타이밍 추정 아님 - 코드/설정에서 직접 확인한 수치. 버전 0.8.0, 가격 $29/$99, markup 1.4, 모델 113개는 소스 verbatim.
- 미확인(필요시 추가): layout-transition.tsx의 FLIP 구현 디테일, shader-renderer.tsx, player-page.tsx UI, 실제 export한 mp4 품질/속도(로컬 실측 권장).
