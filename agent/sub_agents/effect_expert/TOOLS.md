# effect_expert — Tools

## 구현됨

(현재 없음 — 전부 TODO. owner: 병건)

## TODO

- `apply_fade(video_path, in_sec, out_sec)` — fade in/out (밝기).
- `apply_zoom(video_path, start, end, scale, focus_xy)` — Ken Burns / push-in.
- `apply_transition(clips, type)` — cut / dissolve / wipe / slide.
- `apply_blur(video_path, region, intensity)` — Gaussian / box. 얼굴 / 로고 가림.
- `apply_color_grade(video_path, preset)` — warm / cool / cinematic / vivid.
- `apply_speed_ramp(video_path, [(time, factor)])` — slow-mo / 빠른 cut.
- `apply_shake(video_path, intensity, at_time)` — 카메라 흔들기 강조.
- `apply_lut(video_path, lut_file)` — 3D LUT (.cube) 적용.

## 구현 가이드

- 대부분 FFmpeg filter_complex 로 구현 가능.
- LUT 는 `assets/luts/*.cube` 폴더 사전 적재.
- color grade preset 은 hard-coded 값 매핑 (warm = `eq=brightness=0.02:saturation=1.1` 등).
- transition 라이브러리 옵션: `xfade` filter (FFmpeg 4.3+).
