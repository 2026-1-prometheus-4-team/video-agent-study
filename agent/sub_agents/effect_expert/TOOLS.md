# effect_expert — Tools

## 구현됨 (Remotion 기반)

| tool                       | 시그니처                                                                                                  | 설명 |
|----------------------------|----------------------------------------------------------------------------------------------------------|------|
| `apply_remotion_effect`    | `(clip_path, pattern_id, effect_params, effect_mode, text_overlay, brand_energy, target_format, duration_sec, output_path) -> JSON` | 영상 클립에 카탈로그의 패턴 1 개 입혀서 새 mp4 산출. subprocess 로 `npx remotion render` 호출. |
| `query_effect_catalog`     | `(pattern_id, category) -> JSON`                                                                          | registry.json 빠른 조회. pattern_id 명시 시 그 패턴 메타 전체, 없으면 카테고리별 요약. |

## 카탈로그 (20 패턴)

`agent/effects/registry.json` 에 메타. `agent/effects/INDEX.md` 에 카테고리 요약. 실제 Remotion 컴포넌트는 `remotion/src/effects/`.

| 카테고리 | 패턴 |
|---|---|
| ambient | BreathingDots, FilmGrain |
| entrance | BlurSlideIn, FadeIn, KineticWordSwap, TextReveal, TypewriterText |
| exit | BlurSlideOut, FadeOut |
| data | NumberTicker, ProgressBar |
| celebration | ConfettiExplosion |
| color | ColorSweep |
| feedback | CheckmarkDraw |
| interaction | HandCursor |
| showcase | DeviceMockup |
| timing | Hold |
| transition | HardCut, LiquidMorph, ZoomIntoScreen |

## effect_mode 선택 가이드

| mode | 설명 | 적용 패턴 |
|---|---|---|
| `overlay` | 영상 위에 absolute fill 로 깔음 | FilmGrain, Vignette, ConfettiExplosion, CheckmarkDraw, HandCursor, BreathingDots |
| `wrap` | 영상을 children 으로 감싸서 transform | ZoomIntoScreen, BlurSlideIn, BlurSlideOut, FadeIn, FadeOut, Hold |
| `replace` | 영상 없이 효과만 (인서트 컷) | TypewriterText, NumberTicker, TextReveal, KineticWordSwap, ProgressBar, ColorSweep, LiquidMorph |

## effect_params 예시

각 패턴의 default_params 는 `registry.json` 의 `default_params` 참조.
brand_energy 별 typical_duration_frames 는 같은 entry 의 `typical_duration_frames`.

```json
// BlurSlideIn (entrance)
{
  "startFrame": 0,
  "durationFrames": 18,
  "offsetPx": 200,
  "startScale": 1.5,
  "startBlur": 30,
  "from": "right"
}

// TypewriterText (replace mode)
{
  "startFrame": 0,
  "text": "Welcome to the future",
  "charDelay": 3,
  "withCursor": true
}

// ZoomIntoScreen (wrap mode)
{
  "startFrame": 0,
  "durationFrames": 60,
  "targetScale": 3.0,
  "focusX": 0.5,
  "focusY": 0.5
}
```

## 셋업 (팀원 첫 클론 시)

```bash
cd remotion/
pnpm install   # 또는 npm install
# 동작 확인
pnpm dev       # Remotion Studio 띄움 (http://localhost:3000)
```

`apply_remotion_effect` 가 *자동 셋업 점검* 후 친절한 에러 줌. node_modules 없으면 그 메시지 따라 install.

## 운영 가이드

- Render 시간: 클립 길이의 0.5x ~ 3x (해상도 / 패턴 복잡도 따라). 1080p 3 초 → ~10-30 초.
- 메모리: Remotion 4.x 는 Chromium 띄움. 8 GB RAM 권장.
- 동시 render: 한 번에 1 개만 — `Config.setConcurrency(1)` 권장 (CPU 코어 다 안 잡아먹게). 현재는 null=auto.
- 임시 props json 은 `tempfile` 로 만들어 render 후 정리됨.
