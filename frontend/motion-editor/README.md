# Scene24 Motion Editor

`labs/remotion` 모션 엔진 위에 얹은 Figma 급 스펙 편집 UI (Next.js 15 + @remotion/player).
스튜디오에서 JSON 을 손으로 고치던 걸 시각 편집으로 대체한다.

## 실행

```bash
cd labs/motion-editor
pnpm install
pnpm dev            # http://localhost:3001 (webpack 모드 — turbopack 금지)
```

- 엔진 소스는 복사하지 않고 `@engine/* = ../remotion/src/*` 로 직접 import.
- specs 는 `../remotion/src/specs` 를 그대로 읽고 쓴다 (스튜디오와 같은 파일).
- fps 24 고정 (엔진 Root 와 동일). 스펙의 `fps` 필드는 무시.

## 구조

- `src/engine/` — 엔진 브리지 (normalize/fonts).
- `src/editor/store.ts` — zustand 단일 스토어 (immer patch undo/redo, 선택, UI).
- `src/editor/{specPath,timing,mutations,playerBridge,setByPath,curveSample}.ts` — 코어 유틸.
- `src/editor/schema.ts` — 엔진 레지스트리 기반 노브 카탈로그 (exposed 자동 + cemented 실측).
- 패널: `canvas/` `timeline/` `inspector/` `easing/` `library/` `layers/` `topbar/`.
- 계약: `CONTRACT.md` (모듈 API), `DESIGN-NOTES.md` (디자인 규칙).

## 기능 (구현됨)

- 캔버스: @remotion/player 임베드, fit/줌(cmd+wheel)/팬(space·middle), 클릭/shift/마퀴 선택,
  드래그 이동(alt=복제, shift=축 고정, 중앙 스마트 가이드 스냅), 그룹은 자식 leaf 이동.
- 타임라인: 씬 스트립(길이 드래그·순서·복제·삭제), 활성 씬 눈금+플레이헤드 스크럽,
  비트 그리드(0.6s), 요소별 enter/hold/exit 페이즈 바 + 레이어 칩(엔진 resolveTimings 그대로).
- 인스펙터: 씬(길이/맞춤/배경/전환/카메라/플래시) · 요소(텍스트/위치/타이포/색 단색·그라디언트·팔레트/
  레이어 스택/글로우·모션블러). 레이어는 등장·퇴장 리빌(structural, 슬롯 1개) + 래퍼 스택,
  exposed 노브 + 고정값(cemented, 락 표시). 드래그 스크럽 숫자 입력.
- 이징 에디터: 엔진 모든 EASING 곡선 갤러리(hover 재생) + 커스텀 cubic-bezier 핸들 드래그
  + 라이브 프리뷰. 엔진에 `cubic(a,b,c,d)` 커스텀 이징 지원 추가(`resolveEasing`).
- 라이브러리: specs 폴더 브라우저(폴더 그룹·shape 배지), 열기(더티 가드), 저장(API PUT).
- 레이어 트리, 단축키(Space/⌘Z/⌘D/⌘G/Del/화살표 넛지/[·]/T/1·2), undo·redo.

## 추가 기능 (2차)

- **JSON 소스 패널** (탑바 `{ }` 토글): 현재 스펙을 라이브 JSON 으로 보고 직접 편집 →
  파싱·정규화해 캔버스에 즉시 반영(양방향). LLM 산출물(JSON)을 직접 손보는 창.
- **독 툴바** (하단 플로팅): 선택(V)/손(H)/텍스트(T)/도형(R)/로고/그룹. 클릭하면 활성 씬
  중앙에 요소 추가. 라이브러리 새-파일 버튼은 VSCode 식(경로 지정 → 디스크 생성 → 열기).
- **shape 요소** (UI 프리미티브): 라운드 사각형(fill/stroke/radius/opacity/backdrop-blur).
  텍스트처럼 wrapper 레이어 전부 적용됨. UI 모션의 베이스.
- **키프레임 카메라** (AE/Figma 모션식): 타임라인 카메라 트랙에 다이아몬드 키프레임 —
  현재 위치에 추가(현재 카메라 캡처), 드래그로 이동, 더블클릭 삭제, 선택하면 인스펙터에서
  줌·X·Y·회전·세그먼트 이징 편집. 채널별 독립 보간. **캔버스 직접 조작 모드**: 캔버스에서
  드래그=팬 / 휠=줌 하면 플레이헤드에 키프레임 자동 기록.
- **3D 카메라 + 요소 포커스**: 카메라 키프레임에 rotateX(3D 틸트)/rotateY(3D 팬) 추가(perspective
  자동) — AE식 입체 회전. "선택 요소로 포커스" 버튼은 요소 중심에 줌+센터하는 키프레임을 찍어,
  여러 요소를 프레임마다 포커스하면 카메라가 이동하며 각 요소를 비춘다. (피그마 모션엔 카메라
  개념이 아예 없음 — 우리 계층 [4] 카메라라 유지·고도화.)
- **커스텀 이징 라이브러리**: 이징 에디터에서 커스텀 커브를 "이름 붙여 저장"하면
  `../remotion/src/customEasings.json` 에 영구 등록 → "내 커스텀 이징" 갤러리에 뜨고 재사용·삭제
  가능. 프리셋/커스텀 카드를 클릭하면 그 곡선이 커스텀 베지어 에디터에 로드돼 수정 가능(named 는
  fitBezier 근사). spec 에는 `cubic(...)` 로 적용돼 엔진 호환.
- **도형 변형 + 독 드롭다운**: shape 요소에 kind(사각형/타원/선). 독은 Figma UI3 식 그룹 드롭다운
  (선택▾=Move/Hand, 도형▾=사각형/타원/선). 근거: Figma 툴바 리서치.
- **이징 적용 대상 선택**: 탑바 이징 버튼(탐색 모드)에서도 요소 선택 시 "적용 대상" 드롭다운으로
  그 요소의 레이어 이징을 골라 프리셋/커스텀을 실제 적용.
- **레퍼런스 영상 비교**: `scene24/reference/<카테고리>/` 의 실제 영상들을 썸네일 피커
  모달(프레임 미리보기 + 이름 + 검색)로 선택 → **오버레이**(투명도 슬라이더로 JSON 컴포지션
  위에 겹쳐 재생) 또는 **좌우 분할**. 시작·끝 프레임을 클릭해 정렬(끝 지정 시 그 구간에
  영상을 늘려 맞춤 — time-remap). 심링크 `public/reference` 로 정적 서빙, `/api/reference` 목록.

## 엔진 변경 (이 에디터가 추가한 것 — 전부 additive, 스튜디오 호환)

- `core/easing.ts`: `bezierEasing` / `parseCubic` / `resolveEasing` 추가. `ease()` 가 이제
  `resolveEasing` 경유 — named 이징은 bit-identical, `cubic(...)` 문자열도 해석.
- `SceneRenderer.tsx`: `[data-scene]`/`[data-el]` 계측 태그(렌더 무영향). CameraSpec 에
  `type:"keyframes"`(keyframes[{frame,scale,x,y,rotate,easing}]) 추가 + `sampleCameraKeyframes`
  채널별 보간. `element:"shape"` 디스패치.
- `ComposedShape.tsx`(신규): shape 요소 렌더. ComposedText 의 wrapper/타이밍 재사용.

## prop 감사 (editor-prop-audit) — 반영 완료

병렬 감사(3 에이전트)로 엔진이 읽는 prop 전체를 에디터 노출과 대조. 수정한 것:
- **레이어 인스펙터 갭(치명적)**: `atomFallbackKnobs` 만 렌더돼 registry `exposed` 노브가
  전부 unreachable 이던 것 → atom 별 전체 편집 surface(`ATOM_KNOBS`)로 교체. 이제
  stat_reveal 접두/접미/from/to/색, typewriter unit/cursor/cadence, letter_scatter in/out,
  letter_roll settleMode 등 모두 편집 가능. cemented 노브는 레이어에 값이 있을 때만 노출.
- **씬 전환 경로 버그(치명적)**: exposed 노브가 `props.direction` 경로라 no-op 이던 것 →
  flat 경로(`direction`/`color`/`toScale`/`stops`)로 수정. text_collapse_fill 은
  `frames`(헛돎) 대신 `collapseFrames`/`fillFrames` 노출.
- **로고**: bladeColor/accentColor + 5개 램프(fadeIn/scaleIn/fadeOut/scaleOut/slideOut,
  각 from/to/duration/delay/easing) 전부 노출 신설.
- **glow**: radius(가장 큰 미스)/breath 추가, intensity 범위 0..1 로 정정.
- **fade**: blur 꼬리 + easing 추가. **move**: 범위 -0.5..0.5 로(엔진 clamp 일치).
  **scale**: origin(피벗)/dwellFrac. **shrink_into_place**: fromX/fromY, 범위 정정.
- **색**: letterOffsetFrames(글자 시프트)/sweepPerLetter(단어 스윕)/revealLinked 노출.
- **씬**: background.fadeInFrame/fadeDuration + brandDefaults.colors(오로라 블롭 색).

## 남은 한계 / 다음 단계 (의도적 v1 보류)

- 색/글로우 **멀티 엔트리 타임라인**(시간에 따라 색이 홀드/크로스페이드로 변하는)은 미노출 —
  `timeline[0]` 단일 엔트리만 편집. 애니메이션 색은 다음 단계.
- 단색 모드는 ColorSpec 을 삭제하므로 "단색 + 글자 색 시프트" 조합은 표현 불가
  (letterOffsetFrames 는 그라디언트/팔레트 모드에서만). 구조 개선 대상.
- 레이어는 atom 타입으로 저장 → words_up/apple_text 등 같은 atom 이면 이름 역추적 불가
  (atom+role 로 표시). compound 래퍼(fly_out)는 2개 레이어로 펼침.
- 캔버스 리사이즈 핸들은 시각용 — 크기는 인스펙터 노브로.
- LLM 조합(llm-menu.json → 이 에디터 프리뷰) 미연결.
- 정리: 죽은 필드 `background.blobs`(엔진 미사용) + 비활성 `wrappers/mask.ts` 삭제 권장.
