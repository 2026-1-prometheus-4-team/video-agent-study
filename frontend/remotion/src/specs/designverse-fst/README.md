# designverse-fst — 전체 타임라인 spec

designverse.mp4(76s, 30fps) 전체를 비트 단위로 재현한 spec 시리즈.
목업/실사 UI 구간(스크린샷 필요)은 제외했고, 나머지 모션그래픽 비트는 전부 커버한다.
타이밍은 8fps 고밀도 프레임 추출로 측정한 값을 24fps로 환산해서 박았다.

새 element 3종(neon_pill, streak, badge_logo)은 src/motion/effects/designverse.tsx 에 있고
SceneRenderer 에 와이어링돼 있다. 파라미터 상세는 그 파일 상단 주석 참고.

## 비트 맵 (원본 refStart 초 기준)

| spec | 원본 구간 | 내용 |
|------|-----------|------|
| 01-idea-to-product | 0.0 - 2.0 | 키네틱 Idea/to + product 네온 pill 줌 |
| 02-at-lightspeed | 2.0 - 5.1 | 워프 터널 + at light speed |
| 03-introducing-logo | 5.1 - 8.8 | 아크 스우시 + 네온 D 트레이스 + 배지 로고 |
| 04-build-swap-pill | 8.8 - 12.1 | 보라 pill, Build + 단어 스왑 롤링 |
| (스킵) | 12.1 - 17.0 | Woodco/대시보드 목업 |
| 05-much-faster | 17.0 - 18.6 | MUCH(보라) faster than before |
| 06-create-pill | 18.6 - 22.0 | 핑크 pill 타이핑 + 줌아웃 |
| (스킵) | 22.0 - 27.3 | SpaceZ 목업 + 실사 노트북 |
| 07-look-specific | 27.3 - 30.3 | 혜성 + Look 타이핑, more specific? |
| (스킵) | 30.3 - 56.9 | 에디터/챗/대시보드/송금 UI |
| 08-full-stack | 56.9 - 58.4 | full stack{ / working apps |
| 09-app-designverse | 58.4 - 61.5 | app.DesignVerse{ / not just a pretty face |
| (스킵) | 61.5 - 66.0 | 후기 카드(아바타 사진 필요) |
| 10-chat-bubble | 66.0 - 68.3 | 그린-퍼플 네온 버블 타이핑 |
| 11-loader | 68.8 - 70.5 | 배지 + 로딩 점 pill |
| 12-build-anything | 70.5 - 73.4 | Build anything + 30x faster |
| 13-outro | 73.4 - 76.0 | 배지 + 워드마크 + rect 드로우 + fade |

## compare 워크플로우

컴포지션 id는 폴더-파일명이다. 예: designverse-fst-04-build-swap-pill

    npm run compare -- designverse-fst-04-build-swap-pill --ref <designverse.mp4 경로> --refStart 8.8
    npm run watch:compare -- designverse-fst-06-create-pill --ref <경로> --refStart 18.6

specs JSON은 require.context 로딩이라 hot-reload가 씹힐 수 있다.
바꿨는데 그대로면 dev 서버 재시작부터 할 것 (CLAUDE.md 참고).

## 알려진 근사치 (compare로 조일 것)

- d_trace의 D 라인아트 path는 손으로 잡은 근사 좌표다. 픽셀 대조 후 D_PATHS 수정 필요.
- 05/08/09의 다색 텍스트는 move 오프셋으로 나란히 배치한 것이라 x 오프셋 미세 조정 필요.
- MUCH faster 비트의 시안색 가이드라인(17.1s 부근)은 미구현.
- 배경 그라데이션은 눈측정 근사. 프레임 RGB 측정으로 조정할 것.
- 06 핑크 pill의 카메라는 원본이 좌측 클로즈업에서 풀아웃하는 것을 push_in 역방향으로 근사.
