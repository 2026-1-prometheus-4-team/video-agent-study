# Studio UI — 금지 목록과 팔레트

이 문서는 취향이 아니라 **판정 기준**이다. 새 UI 코드는 여기 걸리면 고친다.
아래 항목은 전부 현재 코드에서 실제로 발견된 것이고, 옆에 발견 위치를 적었다.

---

## 절대 사용 금지

### 1. live 인디케이터

색점 + "연결됨" 류의 상태 표시. 사용자에게 아무 행동도 만들지 않으면서
화면에 항상 떠 있는 장식이다.

- 발견: `studio-v2/StageToolbar.tsx:10-12` (`연결됨` / `연결 중` / `재연결 중`), `ConnectionPill`
- 대체: 연결이 **끊겼을 때만** 문구로 알린다. 정상일 때는 아무것도 그리지 않는다.

### 2. 반투명 배경 + 색감 테두리 조합

가장 흔한 AI 생성 UI 시그니처. 반투명 컬러 배경에 같은 색 반투명 테두리를 두르는 패턴.

- 발견: `rgba(124, 141, 241, ...)` — **59곳**
- 대체: 불투명 회색 서피스 + 밝기 차이로 층을 만든다. 강조는 텍스트/아이콘 색으로.

### 3. 보라빛 그라데이션 배경

- 발견: `sidebar.module.css:57,157` (`linear-gradient(135deg, #1e2033, #14152a)`),
  `rows.module.css:9` (`#23253a → #1a1c2e`), `emptystate.module.css:18`
- 대체: 단색 서피스. 그라데이션은 **글라스 엣지 라이트 한 곳**에만 허용한다.

### 4. 글로우 · 펄스 애니메이션

숨쉬는 로고, 빛나는 원, 상태 없는 무한 애니메이션.

- 발견: `sidebar.module.css:65` `.brandMarkGlow` (radial-gradient + `opacity: [0.6, 1, 0.6]` 무한 반복)
- 대체: 진행 중일 때만 움직인다. 유휴 상태에서 움직이는 것은 없다.

### 5. Sparkles / Wand / Bot / Brain 아이콘

"AI가 만들었습니다" 라고 쓰는 것과 같다.

- 발견: `Sidebar.tsx:5,179,230`
- 대체: 기능을 그리는 아이콘만 쓴다 (컷 = Scissors, 자막 = Type, 오디오 = AudioLines).

### 6. 애매한 색

푸른기·보라기가 섞인 회색과 중간 채도 색. 검정도 흰색도 아닌 색.

현재 팔레트에서 걸리는 값:

| 토큰 | 값 | 문제 |
|---|---|---|
| `--bg-app` | `#0a0b0d` | 검정이 아니라 푸른 회색 |
| `--bg-panel` | `#16181d` | 푸른기 |
| `--bg-elevated` | `#21242b` | 푸른기 |
| `--bg-float` | `#292d35` | 푸른기 |
| `--accent` | `#7c8df1` | 연보라 — 채도 낮고 정체 불명 |
| `--role-in` | `#4c8dff` | 애매한 파랑 |
| `--role-out` | `#ff8a5c` | 애매한 주황 |

- 대체: **무채색 회색 사다리** + 아래 포인트 색 4개만.

### 7. 그 밖의 금지

- 카드마다 다른 라운드 값 (반경은 3단계로 고정)
- 아이콘 없는 텍스트 버튼과 아이콘 있는 버튼의 혼용 (한 화면에서 한 규칙)
- 의미 없는 배지 (`STUDIO`, `BETA`, `AI` 등 상태를 안 나타내는 라벨)
- 이모지
- 3개 이상의 폰트 두께
- 그림자로 만드는 깊이 (정지 요소에 `box-shadow` 금지 — 층은 밝기로)

---

## 팔레트

레퍼런스 스크린샷 픽셀에서 측정한 값.

### 서피스 — 무채색만

```
--bg           #000000   앱 배경. 순수 검정
--surface      #141414   기본 카드
--surface-2    #1E1E1E   카드 위 카드 / 입력창
--surface-3    #282828   hover · 활성
--line         #2E2E2E   구분이 꼭 필요한 곳만
```

### 텍스트 — 흰색 사다리

```
--text         #FFFFFF   제목 · 주요 값
--text-2       #A8A8A8   본문
--text-3       #6E6E6E   보조 · 라벨
```

### 포인트 색 — 4개, 용도 고정

```
--violet   #6632D0   기본 액션 (전송, 승인, 선택 상태)
--yellow   #FDC02D   자막 트랙 · 강조
--coral    #FC5652   오류 · 삭제 · 효과 트랙
--green    #5CCC53   완료
```

포인트 색 사용 규칙:

- 한 화면에 **포인트 색 면적 5% 이하**
- 배경으로 쓰는 것은 primary 버튼과 타임라인 클립뿐
- 나머지는 텍스트·아이콘·1px 선으로만
- 반투명 버전(`rgba(...)`)을 만들지 않는다

---

## 형태

### 라운드 — 애플 스타일 연속 곡률

```css
--r-sm: 10px;   /* 배지 · 작은 버튼 */
--r-md: 16px;   /* 버튼 · 입력창 · 클립 */
--r-lg: 24px;   /* 카드 · 패널 */

/* 지원 브라우저에서는 연속 곡률로 승격 */
@supports (corner-shape: squircle) {
  :root { --corner: squircle; }
}
```

### 카드 — 글라스 엣지 라이트

검정 위에 뜬 회색 판. 테두리를 두르는 대신 **위쪽 모서리에만 빛이 걸리게** 한다.

```css
.card {
  position: relative;
  background: var(--surface);
  border-radius: var(--r-lg);
  corner-shape: var(--corner, round);
}

/* 상단·좌상단에만 얇은 밝은 림. 아래로 갈수록 사라진다. */
.card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  corner-shape: inherit;
  padding: 1px;
  background: linear-gradient(
    160deg,
    rgba(255, 255, 255, 0.14),
    rgba(255, 255, 255, 0.04) 28%,
    transparent 55%
  );
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
```

- 색을 섞지 않는다 (흰색 알파만)
- 카드 하나당 림 하나. 중첩 카드는 안쪽 카드에 림을 주지 않는다

---

## 자가 점검

새 화면을 만들고 아래를 확인한다.

1. 스크린샷을 흑백으로 바꿔도 정보 구조가 읽히는가 (색에 의존하지 않는가)
2. 포인트 색 면적이 5% 이하인가
3. 유휴 상태에서 움직이는 요소가 있는가 (있으면 제거)
4. `rgba(` 로 만든 컬러 배경이 있는가 (있으면 불투명 회색으로)
5. 사용자가 아무 행동도 할 수 없는 표시가 있는가 (있으면 제거)
