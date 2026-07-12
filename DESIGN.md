# Video Agent Studio — Design System

프로젝트의 시각/모션/토큰 단일 소스 오브 트루스. 모든 UI 결정은 여기 토큰을 참조해서 이뤄지고, 새 토큰 추가는 이 문서를 먼저 갱신한 뒤 코드에 반영한다.

작성: 성민, 2026-07-13 · 근거: `wf_69ab25ca-8a1` 리서치 결과 (Linear · Vercel · Cursor · Perplexity · Claude Console · Refactoring UI · Dieter Rams)

---

## 1. Philosophy

1. **Footage is hero, chrome fades.** 우측 프리뷰와 타임라인이 시각 가중치의 축. 사이드바·헤더는 인프라로만 존재하고 스스로 눈에 띄지 않는다.
2. **Hierarchy = spacing + surface + weight, not lines.** 계층은 24/32/48px 여백과 4단 surface ladder (deep → base → raised → overlay) 로 만든다. Divider 남발 금지.
3. **Streaming reveals structure.** WebSocket 이벤트 하나하나가 UI 로 흘러들어와야 한다. 스피너로 대체하지 않는다. Research → Planning → Edit 파이프라인 outline 을 미리 그려두고 도착하는 데이터가 슬롯을 채운다.
4. **Motion is a state-change reporter.** 데코용 idle floating, 컬러 glow, ambient parallax 금지. 모든 애니메이션은 *상태 전환* 신호 (arrive / resolve / interrupt / error / complete).
5. **Warm ember, not AI blue.** 프라이머리는 warm amber `#E08A3C` (DaVinci/Resolve 계열 heritage). 파랑·보라·시안 accent 는 정보/링크에만 소극적 사용. 그라디언트 배경·네온·좌측 컬러 스트립 카드 등 AI-slop 시그니처는 완전 금지.
6. **Every color has a job.** amber = agent activity / focus, green = 완료, red = error, blue = 링크 only. 데코용 색 사용 없음.
7. **Depth from lighter surface + shadow-as-border.** Vercel Geist 방식. 그림자는 모두 black + optional 1px top inset highlight. 컬러 발광은 focus ring 한 곳에서만.
8. **Keyboard first-class.** Cmd+K palette, Space 재생, ⌘⏎ 전송, F 피드백. 모든 액션에 shortcut hint 를 label 옆에 노출.
9. **한글 typographical fitness.** Pretendard Variable + 전역 `letter-spacing: -0.025em`. 양수 트래킹은 오직 eyebrow (all-caps) 에서만 예외로 `+0.08em`.

---

## 2. Color System

다크가 canonical, 라이트는 미러. semantic 토큰만 사용하고 hex 는 이 문서 안에서만 존재한다. 실제 CSS 는 `frontend/src/theme/tokens.css`.

```css
:root, :root[data-theme="dark"] {
  /* Surface ladder (4-step, luminance +2~4% each step) */
  --bg-deep:        #050506;   /* app 바깥·behind */
  --bg-base:        #0A0A0B;   /* main canvas */
  --bg-raised:      #111113;   /* sidebar, panel */
  --bg-overlay:     #18191C;   /* popover, modal, dropdown */

  --surface-subtle:  #0D0D0F;
  --surface-default: #141518;
  --surface-strong:  #1C1D21;
  --surface-hover:   #1E1F23;
  --surface-pressed: #171820;
  --surface-selected:        #2A1A0C;
  --surface-selected-strong: #3D2612;

  /* Border (마지막 수단, 우선 spacing 으로 대체) */
  --border-subtle:   #1A1B1E;
  --border-default:  #26272C;
  --border-emphasis: #3A3B42;
  --border-focus:    #E08A3C;
  --border-focus-glow: rgba(224, 138, 60, 0.32);

  /* Text (4-step, WCAG AA) */
  --text-primary:   #F4F5F7;
  --text-secondary: #B6B9C1;
  --text-tertiary:  #82858C;
  --text-muted:     #54575D;
  --text-disabled:  #3A3C42;
  --text-on-accent: #150804;
  --text-inverse:   #0A0A0B;

  /* Accent — warm ember */
  --accent:               #E08A3C;
  --accent-hover:         #EC9D55;
  --accent-pressed:       #C67630;
  --accent-subtle-bg:     #2A1A0C;
  --accent-subtle-fg:     #F0B476;
  --accent-secondary:     #6B7280;
  --link:                 #79B8FF;

  /* Status */
  --success:    #3ECF8E;  --success-fg: #7FE3B0; --success-bg: #0F2419;
  --warning:    #F5A524;  --warning-fg: #FBC069; --warning-bg: #2A1F0A;
  --danger:     #E5484D;  --danger-fg:  #F07278; --danger-bg:  #2A1216;
  --info:       #79B8FF;  --info-fg:    #A3CCFF; --info-bg:    #0D1F2E;
  --streaming:  var(--accent);
  --streaming-pulse: rgba(224, 138, 60, 0.4);

  /* Agent node colors */
  --node-orchestrator: #B6B9C1;
  --node-research:     #79B8FF;
  --node-planning:     #C084FC;
  --node-edit:         #E08A3C;
  --node-critic:       #3ECF8E;
}
```

**규칙**
- `bg-X` 뒤에는 반드시 `text-X-foreground` 짝.
- `dark:` 접두사 hardcoding 금지. semantic 한 줄이면 자동 라이트 대응.
- 컴포넌트 CSS 에 `#hex` 리터럴 직접 쓰기 금지. 반드시 `var(--…)` 참조.

---

## 3. Typography

Pretendard Variable, 전역 `letter-spacing: -0.025em`.

```css
:root {
  --font-ui:  'Pretendard Variable', Pretendard, -apple-system,
              BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif;
  --font-mono:'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace;
}
body {
  font-family: var(--font-ui);
  letter-spacing: -0.025em;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```

**Type scale**

| Token       | Size    | Line-height | Weight | Tracking   | Usage                         |
|-------------|---------|-------------|--------|------------|-------------------------------|
| display     | 48px    | 1.04        | 600    | -0.045em   | 온보딩 hero, 큰 empty title    |
| title       | 32px    | 1.10        | 600    | -0.035em   | 섹션 타이틀, 모달 제목         |
| heading     | 22px    | 1.24        | 600    | -0.030em   | 사이드바 섹션, 카드 제목       |
| subheading  | 17px    | 1.40        | 500    | -0.025em   | 서브 패널 헤더                 |
| body        | 14px    | 1.50        | 400    | -0.020em   | 채팅 본문, 기본 텍스트         |
| body-strong | 14px    | 1.50        | 600    | -0.020em   | 인라인 강조                    |
| label       | 13px    | 1.40        | 500    | -0.015em   | 입력 라벨, 탭 라벨             |
| caption     | 12px    | 1.40        | 500    | -0.010em   | 타임스탬프, 메타               |
| micro       | 11px    | 1.30        | 600    | 0          | 뱃지, 단축키                   |
| eyebrow     | 11px    | 1.20        | 600    | **+0.08em**| all-caps 섹션 eyebrow (예외)   |
| mono        | 12.5px  | 1.50        | 500    | 0          | tool payload, timecode         |

Weight 500(medium) 을 Pretendard Variable 에서 활용해 Semibold 없이 강조. 700+ 남발 금지.

---

## 4. Spacing / Radius

```css
:root {
  --sp-0: 0;  --sp-0-5: 2px;  --sp-1:  4px;  --sp-1-5: 6px;
  --sp-2: 8px;--sp-3: 12px;   --sp-4: 16px;  --sp-5: 20px;
  --sp-6: 24px;--sp-8: 32px;  --sp-10:40px;  --sp-12:48px;
  --sp-16:64px;--sp-20:80px;  --sp-24:96px;  --sp-32:128px;

  --r-1: 2px;  --r-2: 4px;  --r-3: 6px;  --r-4: 8px;   --r-5: 10px;
  --r-6: 14px; --r-7: 20px; --r-8: 28px; --r-full: 9999px;
}
```

- 컴포넌트 내부 padding = sp-3/sp-4/sp-5 로 90% 커버
- 카드 간격 sp-2, 그룹 간격 sp-6, 섹션 간격 sp-10+
- 카드 radius r-5, 버튼/인풋 r-4, pill r-full, 모달 r-6

---

## 5. Elevation

Vercel Geist 방식 — shadow-as-border. 컬러 그림자 금지.

```css
:root {
  --elev-flat: none;
  --elev-hairline:  0 0 0 1px rgba(255,255,255,0.04);
  --elev-raised:
    0 0 0 1px rgba(255,255,255,0.05),
    0 1px 2px 0 rgba(0,0,0,0.40),
    0 4px 12px -4px rgba(0,0,0,0.35);
  --elev-floating:
    0 0 0 1px rgba(255,255,255,0.06),
    0 8px 16px -6px rgba(0,0,0,0.50),
    0 20px 40px -12px rgba(0,0,0,0.40);
  --elev-overlay:
    0 0 0 1px rgba(255,255,255,0.08),
    0 20px 40px -12px rgba(0,0,0,0.65),
    0 40px 80px -24px rgba(0,0,0,0.55),
    inset 0 1px 0 0 rgba(255,255,255,0.05);
  --elev-dramatic:
    0 0 0 1px rgba(255,255,255,0.10),
    0 32px 64px -16px rgba(0,0,0,0.75),
    0 60px 100px -40px rgba(0,0,0,0.60),
    inset 0 1px 0 0 rgba(255,255,255,0.06);
}
```

---

## 6. Motion

Framer Motion v12 (`motion/react`). 프리셋은 `frontend/src/lib/motion.ts` 에 코드로. 컴포넌트는 그것만 참조.

**Spring**
- `microHover` s400 d30 m0.5 (120ms) — 카드 hover / 미세 확대
- `tapPress`   s500 d25 m0.4 (100ms) — 버튼 press
- `panelSlide` s300 d32 m0.9 (280ms) — 사이드바 collapse / drawer
- `scrub`      s700 d40 m0.3 (80ms)  — 스크러버 drag
- `cardEnter`  s320 d30 m0.6 (260ms) — 스레드 카드 도착

**Ease**
- `fastFade`  0.16s cubic-bezier(0.16,1,0.30,1)
- `modal`     0.24s cubic-bezier(0.32,0.72,0,1)
- `streaming` 0.18s cubic-bezier(0.40,0,0.20,1)
- `pulse`     1.60s cubic-bezier(0.40,0,0.60,1) infinite mirror

**규약**
- streaming 텍스트: chunk 단위 opacity 0→1 180ms, 20ms stagger
- 새 카드: `layout + initial={{opacity:0,y:8}} + spring.cardEnter`
- interrupt sticky: `initial={{y:-24, scale:0.98}} + panelSlide` + 페이지 opacity 1→0.92
- 사이드바 접기: layout animation + panelSlide 300ms
- **prefers-reduced-motion**: transform / scale / blur 애니메이션 disable, opacity 만 120ms

**금지**: idle floating, bouncing 카드, ambient parallax, color glow shadow, 그라디언트 애니메이션 배경.

---

## 7. Anti-AI Patterns (Do Not Ship)

1. 반투명 색 배경 + 색 테두리 조합 카드 (`bg-accent/8 + border-accent/40`)
2. Purple → cyan / blue → purple linear-gradient 배경
3. 네온 사이안 텍스트 (#22D3EE)
4. 카드 좌측 3~4px 컬러 스트립
5. box-shadow 컬러 발광 (`0 0 40px rgba(purple,0.5)`)
6. Inter / Roboto 기본 폰트 (반드시 Pretendard)
7. 헤더 하단 · 카드 사이 divider 반복
8. 중앙 정렬 남발
9. Sparkles ✨ 🎬 이모지로 UI 아이콘 대체
10. "AI Powered" 뱃지, 무지개 그라디언트 텍스트

---

## 8. Component Tokens

```css
--btn-h-sm: 28px;  --btn-h-md: 36px;  --btn-h-lg: 44px;
--btn-px:   var(--sp-4);
--btn-radius: var(--r-4);

--card-bg:         var(--surface-default);
--card-radius:     var(--r-5);
--card-padding:    var(--sp-4);
--card-elev:       var(--elev-hairline);
--card-elev-hover: var(--elev-raised);

--input-h:      36px;
--input-bg:     var(--surface-subtle);
--input-border: var(--border-subtle);
--input-focus:  var(--border-focus);
--input-radius: var(--r-4);

--badge-h: 20px;  --badge-px: var(--sp-2);  --badge-radius: var(--r-full);

--sidebar-w-collapsed: 60px;
--sidebar-w-default:   360px;
--sidebar-w-max:       520px;

--timeline-h:       184px;
--timeline-lane-h:  44px;
--timeline-ruler-h: 28px;
--playhead-w:       1.5px;
--playhead-color:   var(--accent);
```

---

## 9. Responsive breakpoints

```css
:root {
  --bp-mobile:  0px;
  --bp-tablet:  768px;
  --bp-desktop: 1280px;
  --bp-wide:    1600px;
}
```

- **Desktop ≥ 1280**: 사이드바 360px + 스테이지 + 타임라인 168~184px 3-column-row grid
- **Tablet 768–1279**: 사이드바가 collapsible overlay (vaul), 트리거 좌상단 FAB. 스테이지 풀폭
- **Mobile < 768**: 채팅을 bottom sheet (vaul). 스테이지 상단 sticky, 타임라인 hidden. `100dvh` + `safe-area-inset` 필수

---

## 10. Streaming UI 이벤트 매핑

| WS Event    | 대상 UI                        | 애니메이션                                  |
|-------------|-------------------------------|---------------------------------------------|
| `message`   | AgentBubble (스레드 최하단)    | chunk opacity 0→1 180ms + typing caret     |
| `tool_call` | ToolCallCard (사이드바)        | cardEnter spring + breathing pulse (running)|
| `tool_result`| ToolCallCard 상태 flip        | success: 체크 spring bounce / error: red flip |
| `interrupt` | Sticky InterruptCard 상단      | slideDown -24→0 + 페이지 opacity 1→0.92    |
| `final`     | FinalCard + VideoStage         | crossfade 480ms + 타임라인/Insights fill   |
| `done`      | InfoRow "세션 종료"            | delay 200ms fade-in                         |
| `error`     | ErrorRow 또는 OfflineBanner    | subtle red flip + sonner toast (dedup)     |
