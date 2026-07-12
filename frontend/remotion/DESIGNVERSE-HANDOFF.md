# DESIGNVERSE 재현 프로젝트 핸드오프

새 세션/프로젝트에서 이 문서만 읽으면 이어서 작업할 수 있게 정리한 문서.
목표: designverse.mp4(76s, 30fps) 홍보영상을 spec JSON + 엔진 확장으로 재현.
원본 영상은 세션에 업로드해서 쓰거나 reference/ 폴더에 두고 compare 로 대조한다.

## 파일 지도

- spec: `src/specs/designverse-fst/01~13-*.json` (컴포지션 id = `designverse-fst-<파일명>`)
- 전용 element 3종: `src/motion/effects/designverse.tsx` (neon_pill, streak, badge_logo)
- 엔진 공용 확장: `src/motion/SceneRenderer.tsx` (scaleKeyframes, cameraMotionBlurPx, BgBlobs)
- 비트별 원본 타임스탬프: `src/specs/designverse-fst/README.md` 의 비트 맵 표

## 진행 상태

집중 튜닝 완료(사용자 눈 검수 여러 회차 반영):

- 01 idea-to-product: Idea/to 미세 줌아웃(camera push_in 역방향), product 는
  글자 letterIn -> 느린 줌아웃 -> 급줌아웃과 동시에 테두리가 화면급 크기에서
  박스로 수렴(borderFrom + drawStyle fade + 카메라 motionBlur).
- 02 at-lightspeed: 대기->눌림->유지가 scaleKeyframes 한 씬(V자, 유지구간 없음,
  모노톤 보간), 발사는 portal 모드(버튼 내부가 워프 창이 되어 화면 비율로 확대,
  innerFade 로 내부 하드컷 방지), 글자는 letterOut 순차 낙하(성장 시작과 동기),
  워프 frameOffset 체인, "at" 은 revealAt 으로 즉시 등장.
- 03 introducing-logo: 아크가 글자 리빌과 같은 속도로 성장(linear 12f 동기),
  완성 후 느린 드리프트 -> 막판 가속 탈출(travel start 12), 오른쪽 훅(hook,
  접선 연속), 전 씬 미세 줌아웃, D 트레이스는 왼쪽 스템만 crawl 빈틈(위로 이동),
  오른쪽 보울은 통짜, 액센트는 오른쪽 절반 감싸기(span 0.95, 미세 드리프트),
  네온 bleed 1.5.
- 04 build-swap-pill: 테두리 80% 상태에서 위쪽 빈틈이 닫히며 완성(drawFrom +
  drawGap, 대시 주기 = 경로길이 필수), 완성과 동시에 줌인 정지(scaleKeyframes),
  스왑은 연속 릴(reelIndexAt, 모노톤) - 내림차순 단어 -> 룰렛 재순환 ->
  widthRamp 로 폭 축소(왼쪽 공백 유지: align left + paddingLeft, anchor 는 빼둠),
  블러는 룰렛 구간만(shrinkStarted 게이트), contentOffsetY 광학 보정.

초안 상태(원본 대조 전): 05-much-faster ~ 13-outro. 구조는 깔려 있고
타이밍/색/배치를 04 까지 한 것처럼 원본이랑 대조하며 조여야 한다.

## 엔진 확장 요약 (designverse.tsx)

neon_pill 주요 파라미터:
- 지오메트리: width/height/radius(vw), position, anchor("left"=왼쪽 고정 축소)
- 보더: borderColors, borderWidth, glow, glowPulse, drawIn, drawFrom(시작 진행도),
  drawGap(빈틈 위치, 대시 주기 주의), drawStyle(trace/fade), borderFrom(큰 사각형->pill 수렴)
- 콘텐츠: mode(swap/type/dots), fixedPrefix, swapWords[{text,frame}], swapDuration,
  swapGap(단어 세로 간격 em), swapBlur(룰렛 블러, widthRamp 시작 후에만),
  letterIn(글자 스태거 등장), letterOut(글자 순차 낙하, fadePortion 으로 이동/페이드 분리),
  contentOut(통짜 가라앉기), contentOffsetY(세로 광학 보정)
- 변형: scaleRamp(자체 확대, 카메라 대신 - 배경 연속성), widthRamp(폭만 축소),
  portal{cover, innerFade}(내부가 창이 되어 화면 비율로 확대), fadeOut, fillColor

streak 주요 파라미터:
- variant: arc(+apexX, hook{x,y,k}), comet, rect(radius), d_trace(D 라인아트)
- travel: span/spanFrom/grow(길이 성장), growMode(forward/center), from,
  distance(이동량, 0=고정), easing, profile("out_in"=감속 후 재가속),
  white{span,distance,from}(d_trace 흰 선 crawl 빈틈)
- bleed(네온 빛번짐 px), draw(트레이스 또는 등장 페이드)

badge_logo: letter, wordmark, size, badgeColors, rimColor, scaleIn, wordmarkIn, loader

SceneRenderer 확장:
- camera.scaleKeyframes[{t,s}]: 모노톤 큐빅(C1 연속, 오버슈트 없음). 다단 모션은
  씬 쪼개지 말고 이걸로.
- camera.motionBlur{amount,maxBlur}: push_in 속도 연동 블러
- background.blobs[]: 드리프트 글로우. 위상은 씬 시작 프레임을 더해 전 씬 연속

## 씬 경계 연속성 체크리스트 (끊김 디버깅 순서)

1. 스케일/위치 값이 이어지는가 (카메라 끝값 = 다음 씬 시작값)
2. 속도가 이어지는가 (정지->급출발 금지. scaleKeyframes 로 합치거나 easeIn 시작)
3. 글로우/색/불투명도/보더 두께가 같은가 (portal 은 두께에 contentScale 곱함)
4. 파티클 frameOffset 이 이어지는가 (씬 프레임 합 누적)
5. blobs 위상 (엔진이 자동 처리, BgBlobs frameOffset)
6. 요소 하나만 커져야 하면 카메라 말고 scaleRamp/portal (카메라는 다음 씬과 끊김)

## 검증 워크플로우

- 렌더 확인: dev 서버 재시작(specs JSON 은 require.context 라 hot-reload 씹힘)
- 원본 대조: `npm run watch:compare -- designverse-fst-04-build-swap-pill --ref <원본> --refStart 8.8`
  (비트별 refStart 는 specs/designverse-fst/README.md 표 참고)
- 측정 원칙은 CLAUDE.md 그대로: 추측 말고 프레임 추출 + 픽셀 측정

## 남은 것

- 05~13 원본 대조 튜닝 (04까지 했던 방식으로 비트별 진행)
- d_trace 의 D_PATHS 좌표를 원본 D 모양에 픽셀 대조로 맞추기
- 배경 그라데이션/blobs 색을 프레임 RGB 측정으로 보정
- 목업/실사 구간(12.1-17.0, 22.0-27.3, 30.3-56.9s)은 의도적으로 스킵된 상태
- 폰트: 현재 Inter. 원본 워드마크는 더 라운드한 지오메트릭 계열로 보임(미확정)
