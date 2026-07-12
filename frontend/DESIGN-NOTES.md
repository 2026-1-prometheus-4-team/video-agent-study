# Scene24 Motion Editor — 디자인 규칙 (모든 UI 작업 필독)

근거 리서치: Linear/Raycast/Framer/Figma UI3 추출값 + 모션툴 UX 조사.
원문: 세션 스크래치패드 `scratchpad/research/` (dark-ui-2026.md, figma-ui.md,
timeline-ux.md, easing-editor.md, remotion-player.md).

## 절대 규칙

1. 색/치수/그림자/폰트는 전부 `src/app/globals.css` 의 토큰만 쓴다.
   hex 하드코딩 금지 (캔버스 위 콘텐츠 제외).
2. 깊이 = 서피스 사다리 + 헤어라인. 정지 상태 요소에 box-shadow 금지.
   그림자(`--shadow-float`)는 팝오버/메뉴/드래그 중인 것에만.
3. 크로마 포인트는 `--accent` 하나. 셀렉션/포커스/프라이머리 버튼/선택된
   키프레임에만. 패널 크롬은 완전 무채색. (타임라인 role 바 색은 예외 —
   `--role-*` 토큰)
4. 크롬 텍스트: 라벨 11px/500, 값 12-13px/400, 섹션 헤더 11px/550 + 살짝
   자간(+0.2px). 숫자 필드/타임코드는 반드시 `tnum` 또는 `mono` 클래스.
5. radius: 인풋/버튼 6px(--r-2), 패널/팝오버 10-12px(--r-3/4). 16px+ 금지.
6. 마이크로 모션: hover-in 은 즉시, hover-out/press 만 트랜지션
   (120-200ms, var(--ease-pop)). transform/opacity 만 애니메이션.
   재생/스크럽/키프레임 같은 고빈도 액션엔 애니메이션 0.
7. 이모지/그라디언트 배경/글래스모피즘 금지. AI-slop 패턴 금지
   (보라-파랑 그라디언트, 반투명+색테두리 조합, 거대 라운드).
8. 인풋은 outlined 가 아니라 filled: `--bg-elevated` 배경 + 1px 헤어라인,
   포커스 시 헤어라인이 accent 링으로.
9. 스타일링은 CSS Modules (`X.module.css`) + 토큰. 동적 값만 inline style.
10. 문서/코드/주석에 이모지 금지. 주석은 한국어.

## 참고 레시피

- 세그먼티드 컨트롤: 트랙 `--bg-inset`, 활성 thumb 은 한 단계 밝은 서피스
  (accent 아님), thumb 이동은 transform 150ms.
- 아이콘 버튼: `.icon-btn` 전역 클래스 사용 (28px, hover 필, active scale .96).
- 툴팁: `--bg-float` + 헤어라인 + 12px/500, 단축키는 `--text-3` 로 병기.
  등장 scale 0.96 + fade, transform-origin 은 트리거 쪽.
- 팝오버: `--shadow-float`, radius `--r-3`, 진입 scale(0.95)+opacity 150-200ms.
- 키캡 힌트: `.keycap` 전역 클래스.
- 빈 상태: 아이콘 흐리게 + 한 줄 (`--text-4`) + 키캡 힌트. 일러스트 금지.
- 드래그 스크럽 숫자 입력(Figma 식): 라벨에 ew-resize 커서, 드래그로 값 증감
  (shift=x10, alt=x0.1), 클릭하면 직접 입력. 값은 tnum.

## 레이아웃 (EditorShell 이 조립 — 각 패널은 자기 영역만)

```
+--------------------------------------------------------------+
| TopBar (36px)                                                |
+----------+--------------------------------------+-----------+
| LeftPanel|            CanvasStage               | Inspector |
| (260px)  |                                      | (280px)   |
+----------+--------------------------------------+-----------+
| TimelinePanel (260px, 위 엣지 드래그로 리사이즈)               |
+--------------------------------------------------------------+
```

패널 배경 `--bg-panel`, 캔버스 영역 `--bg-app`, 경계는 1px `--hairline`.
