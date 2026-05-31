# Effect Pattern INDEX

video-agent-study 의 effect_expert 가 호출 가능한 모션 패턴 카탈로그.
scene24-codebase 의 craft/patterns 에서 20 개를 carve-out.

각 패턴의 *조합 규칙 / 회피 패턴 / brand_energy_behavior* 는 `registry.json` 참조.
실제 Remotion 컴포넌트 코드는 `remotion/src/effects/` (kebab-case .tsx).

**총 20 패턴**

## Ambient

- **BreathingDots** — 8-10 dots arranged in a pattern that slowly expand and contract (breathing animation). Mindfulness/wellness visual.
- **FilmGrain** — Subtle noise overlay changing every frame. Makes video feel 'alive' and cinematic.

## Entrance

- **BlurSlideIn** — Element enters with large size + strong blur, then settles to normal. 3 properties change simultaneously: position (slid...
- **FadeIn** — Simple opacity 0 → 1 entrance. The most basic entrance — use when the content should appear without drawing attention to...
- **KineticWordSwap** — Hard 1-frame word replacement with kinetic spacing animation. Words swap instantly (no cross-fade), but the NEW arrangem...
- **TextReveal** — Text appears via mask wipe — a horizontal or vertical bar sweeps across, revealing text behind it. Clean, editorial feel...
- **TypewriterText** — Characters appear one by one at ~0.1s intervals. Optional blinking cursor.

## Exit

- **BlurSlideOut** — Element exits with simultaneous slide + blur + scale + fade. 4 properties change. CRITICAL: scale starts first, blur fol...
- **FadeOut** — Simple opacity 1 → 0 exit. The counterpart to FadeIn. Use when the element should disappear without drawing attention to...

## Data

- **NumberTicker** — Smoothly counting number that simulates live data. Ease-out deceleration (fast start, slow settle).
- **ProgressBar** — Animated fill bar with count-up number. Deceleration pattern: fast 0-70, medium 70-90, slow 90-99, pause at 99, then 100...

## Celebration

- **ConfettiExplosion** — Colored rectangular paper pieces burst outward then fall with gravity + wobble. Celebration moment.

## Color

- **ColorSweep** — Color sweeps across an element from one side to the other. Like a wave of paint.

## Feedback

- **CheckmarkDraw** — SVG checkmark drawn with stroke-dasharray animation. Progressive stroke from left to right with ease-out. Success/comple...

## Interaction

- **HandCursor** — Stylized hand cursor that hovers and clicks. Mac grab-hand style, not system pointer.

## Showcase

- **DeviceMockup** — Product screenshot inside a 3D device frame (iPhone, MacBook, iPad, browser). CSS 3D perspective with shadow.

## Timing

- **Hold** — Element stays on screen for a specified duration. NOT truly static — MUST include Breathing micro-motion (scale 0.998-1....

## Transition

- **HardCut** — Instant 1-frame scene change. Background color, text, and all elements swap simultaneously in a single frame. No fade, n...
- **LiquidMorph** — Shape smoothly transforms: rectangle → pill → circle, or button → star. Organic, fluid feel.
- **ZoomIntoScreen** — Camera pushes into a device screen — device frame scales up and off-screen, revealing the content inside at full resolut...
