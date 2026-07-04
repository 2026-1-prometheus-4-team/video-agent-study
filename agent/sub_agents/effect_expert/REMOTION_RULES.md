# Remotion Implementation Rules

Constants, safe zones, font sizes, and component patterns for Remotion TSX.

## Canvas Constants

```
Resolution: 1920 x 1080
FPS: 30
Safe zone width: 1728px (90% of 1920)
Safe zone margin: 96px from each side
```

## Font Size Rules

| Element | Size range | Minimum |
|---|---|---|
| Hero headline | 120-160px | 72px |
| Section headline | 64-96px | 48px |
| Body text | 32-48px | 24px |
| Caption/label | 20-28px | 16px |

NEVER below 16px. At 1080p, anything smaller is unreadable.

## UI Element Sizes (common presets)

| Element | Typical size |
|---|---|
| Pill input | ~1200 x 100px |
| Card | ~800 x 200px |
| Button | ~400 x 80px |
| Phone mockup | ~400 x 800px |
| Browser mockup | ~1400 x 900px |

## Text Fit Pre-Calculation

Before placing text, calculate if it fits:
```
characters * fontSize * 0.55 = approximate width in px
Example: 40 chars * 48px * 0.55 = 1056px (fits in 1728px safe zone)
```

If text overflows safe zone, reduce font size or break into 2 lines.

## 3D Device Mockups

iPhone preset rotation: base [PI/2, 0, PI], camera top-down Y-axis.
NEVER guess 3D rotation values. Use the presets from device_frames/ or
reference example-ads/ for exact camera positions.

## Import Pattern

Always start with Remotion imports, then custom components:
```tsx
import { Composition, Sequence, useCurrentFrame, useVideoConfig,
         interpolate, spring, Img } from 'remotion';
```

## Constants-First Code Structure

Start every TSX with const declarations:
```tsx
// Brand colors from capture
const BRAND = {
  primary: '#FF983B',    // from tokens.json
  dark: '#0F0F0F',
  light: '#FAF9F7',
};

// Timing in frames (30fps)
const TIMING = {
  hookStart: 0,
  hookDuration: 150,     // 5s
  problemStart: 150,
  problemDuration: 120,  // 4s
  // ...
};

// Typography
const TYPO = {
  heroSize: 140,
  headingSize: 72,
  bodySize: 36,
  captionSize: 24,
};
```

## Determinism Rules (from Hyperframes)

These break Remotion rendering — NEVER use:
- `Math.random()` — non-deterministic frame output
- `Date.now()` — changes between renders
- `setInterval` / `setTimeout` — framework owns the timeline
- `repeat: -1` — infinite loop breaks render pipeline
- `video.play()` / `audio.play()` — framework controls playback

Use instead:
- Fixed values + `useCurrentFrame()` for all timing
- `interpolate()` + `spring()` for all animation
- `<Sequence>` for all temporal arrangement

## 8 Core Animation Patterns (from Hyperframes)

Every quality composition uses at least 2 per scene:

1. **Counter** — Numbers animate from 0 to target
2. **SVG stroke draw** — strokeDashoffset animation
3. **Character stagger** — Text char-by-char with stagger delay
4. **Breathing float** — Vertical bob on held elements
5. **Bar chart fill** — Sequential bars from bottom
6. **Orbit/rotation** — Continuous rotation with ease: "none"
7. **Highlight sweep** — backgroundSize animating for underline
8. **Grain texture** — CSS radial-gradient (NOT SVG filter)
