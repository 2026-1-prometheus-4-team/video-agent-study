# Motion Directing Guide

The most critical skill in ad creation. Bad copy with great motion still looks premium.
Great copy with bad motion looks amateur.

## 10 Motion Choreography Principles

### 1. Minimum 3 simultaneous property changes
Never animate just opacity. Combine opacity + scale + blur, staggered 2-3 frames apart.
Single-property animation looks like a PowerPoint fade.

### 2. Stagger properties 2-3 frames apart
If opacity, scale, and position all start on the same frame, the motion looks mechanical.
Offset each by 2-3 frames. Opacity leads, position follows, scale last.

### 3. Velocity curves that breathe
No linear motion. Every animation has acceleration and deceleration.
Use the "pause at 80%" technique: element reaches near-final position, holds 3-5 frames
with micro-drift, then settles. Creates anticipation.

### 4. Inter-element relationships
One element's exit TRIGGERS another's entrance. They're not independent.
The leaving element's momentum passes to the arriving element.
Think of it as a relay race, not individual sprints.

### 5. Breathing micro-motion on all holds
Any element visible for >15 frames (0.5s) must have breathing motion:
- Scale: +/- 0.2% oscillation
- Position: +/- 1px drift
- Opacity: +/- 2% pulse
This prevents "frozen PowerPoint" syndrome.

### 6. Blur behavior
Leading edge of entering element clears first (blur 8 -> 0 over 10 frames).
Exiting elements inherit blur from the transition (get blurrier as they leave).
Never: instant blur on/off. Always: gradient blur that follows motion direction.

### 7. Spring configs by brand energy
- Restrained (corporate, enterprise): stiffness 80-120, damping 20-30
- Moderate (SaaS, startup): stiffness 120-160, damping 15-20
- High (consumer, playful): stiffness 160-220, damping 10-16
Match the brand's energy from capture data. Never guess.

### 8. Exits accelerate (ease-in), not decelerate
Elements leaving the screen speed UP as they go, not slow down.
Ease-in for exits, ease-out for entrances. The opposite of what feels intuitive,
but it's how real objects move (they accelerate away from view).

### 9. Size relationships = hierarchy
Primary element enters large, shrinks as secondary joins.
Secondary enters at 60% size, grows to 80% as it takes focus.
Size changes communicate who's talking and what's important NOW.

### 10. Click interaction = one continuous spring
When simulating a UI click: press (scale to 0.95) and grow (scale to 1.02)
must be ONE continuous spring animation, not two separate tweens.
A return-to-1.0 between press and grow creates an unnatural "snap."

## Hyperframes Quality Tier S Standards

### Entrance timing
Offset first animation 0.1-0.3s into the scene. Starting motion at frame 0
creates a jarring jump-cut. Let the scene "breathe in" before motion begins.

### Mid-scene activity
EVERY scene longer than 4 seconds must have continuous motion.
No static slides. Use: floating drift, counter animation, glow pulse,
slow zoom, particle movement. Something must always be alive.

### Easing variety
Minimum 3 different eases per scene. Avoid using the same ease everywhere.
- Smooth: power2.out (0.4-0.6s) — default entrances
- Snappy: power4.out (0.2-0.3s) — UI elements, buttons
- Bouncy: back.out(1.6) (0.3-0.5s) — playful reveals
- Dramatic: expo.out (0.3-0.5s) — hero text, big moments
- Dreamy: sine.inOut (0.5-0.8s) — backgrounds, atmospheric
- Mechanical: steps(5) (0.3-0.5s) — counters, data

### Hard cuts vs transitions
95% of cuts are HARD CUTS. Transitions (shaders/fades) are for 2-3 key moments only:
- Hero reveal / product unveil
- Major energy shift / act break
- CTA landing / final brand moment
Everything else = hard cut. Over-using transitions = amateur.

### Scene duration rules
| Display text | Min duration |
|---|---|
| No text (hero/icon) | 1.5-2s |
| 1-3 words | 2-3s |
| 4-10 words (headline) | 3-4s |
| 11-20 words (sentence) | 4-6s |
| 21-35 words (paragraph) | 6-8s |
| 35+ words | Split into 2 scenes |

Hard ceiling: 5s per scene unless justified (hero hold, cinematic push, long counter).

## Banned Patterns (instant quality failure)

- Camera shake / tremor / sub-pixel jitter — NEVER. Cinematic = locked camera.
- Velocity hitting 0 between phases — ALWAYS maintain micro-movement.
- Linear easing on visible elements — looks robotic and cheap.
- Same ease on everything — creates monotonous rhythm.
- Exit that decelerates — elements leaving must accelerate away.
- Static hold >0.5s without breathing — looks frozen/broken.
- Transition on every cut — destroys professional pacing rhythm.

## Code-Level Quality Gate

When writing TSX, check EVERY beat against these rules before moving on.
If a beat fails any of these, fix it before writing the next beat.

### Rule: No dead frames
Every single frame must have at least 2 properties changing somewhere on screen.
Background ambient (gradient pan, dust particles, grain) counts as 1 layer.
The content layer must ALSO be moving. Two static text elements sitting on an
animated background is still dead — the viewer's eye locks onto the static text.

### Rule: Minimum motion layers per beat
Every beat must have AT LEAST these simultaneously:
- Background layer: gradient pan, particle drift, or color shift (always moving)
- Content motion: the main visual element actively entering, moving, or transforming
- Text choreography: text appearing word-by-word, or shifting position, or scaling
Count your layers. If a beat has <3 simultaneous motion sources, add more.

### Rule: Text is choreography, not subtitles
Text must NEVER appear all at once. Choose one:
- Word-by-word reveal with stagger (each word 3-5 frames after the last)
- Character-by-character with spring bounce
- Start centered, then shift left as more words appear
- Scale from 0.8 to 1.0 with blur clearing as text lands
- Text enters from a direction (bottom-up, right-to-left) with spring
A sentence that fades in as a block = subtitle. A sentence that builds = cinema.

### Rule: Camera work is mandatory
Every beat >2s must have at least one of:
- Slow zoom in (scale 1.0 -> 1.03 over the full beat) — creates urgency
- Slow zoom out (scale 1.03 -> 1.0) — creates reveal
- Pan (translateX shift 0 -> 20px) — creates movement through space
- Push-in on a focal point — directs attention
These are subtle (1-3% scale, 10-20px translate) but ESSENTIAL.
A completely static camera for 3+ seconds = amateur.

### Rule: Depth must be visible
Every scene needs visual depth cues:
- Elements at different z-layers (foreground/midground/background)
- Foreground elements slightly larger, move faster (parallax)
- Background elements have more blur (depth of field)
- 3-layer shadows on floating elements (close/mid/far spread)
Flat = PowerPoint. Depth = cinema.

### Rule: Rhythm through timing variation
Entrances must NOT be evenly spaced. Use rhythmic timing:
- Quick-quick-slow (3f, 3f, 8f gaps between elements) = energetic
- Slow-quick-quick (8f, 3f, 3f gaps) = dramatic build
- Syncopation (5f, 3f, 7f, 2f) = musical feel
Evenly spaced entrances (5f, 5f, 5f, 5f) = mechanical, boring.

### Rule: Products must be immersive
When showing product UI/screenshots:
- NOT: flat static image sitting in the center of the screen
- YES: zoom-into-screen effect targeting a specific UI element
- YES: isometric tilt with 3-layer shadow for depth
- YES: slow pan across the UI while zoomed in (user exploring the product)
- YES: device mockup (phone/laptop frame) with screenshot inside, tilted
The viewer should feel like they're INSIDE the product, not looking at a postcard.

### Rule: Transitions carry momentum
When cutting from beat to beat:
- Exiting elements accelerate OUT (ease-in, not ease-out)
- The exit direction implies the entering direction of the next beat
- Overlap: next beat's first element starts entering 3-5 frames BEFORE current beat ends
- Energy from one beat transfers to the next (relay race, not separate sprints)

### Rule: Self-check before render_preview
Before calling render_preview, mentally walk through the ad frame by frame:
- Frame 0-30 (first second): is something already moving? Hook must be instant.
- Every 30 frames (every second): are at least 3 things changing on screen?
- Text appearances: does each one have entrance choreography, not just opacity fade?
- Product shots: are they moving (zoom/pan/tilt) or static?
- Beat transitions: does momentum carry across?
If ANY second has only 1-2 things changing, add more motion before rendering.
