# text_expert — Tools

## 구현됨

(현재 없음 — 전부 TODO. owner: 은채)

## TODO

- `add_subtitle(video_path, srt_path, style)` — SRT burn-in. FFmpeg subtitles filter.
- `add_auto_subtitle(video_path, style)` — transcribe 결과 → SRT 변환 → burn-in (one-shot).
- `add_title(video_path, text, position, duration, anim)` — 타이틀 오버레이 (fade-in/out 포함).
- `add_caption(video_path, text, at_time, duration, style)` — 강조 캡션 (특정 시점).
- `add_emoji_overlay(video_path, emoji, at_time, position)` — 쇼츠/릴스용 이모지.

## 구현 가이드

- FFmpeg `subtitles=` filter 또는 `drawtext=` filter.
- SRT 파일은 `videos/subtitles/` 폴더 권장.
- 폰트 파일은 `assets/fonts/` 사전 적재. 한국어 default: NotoSansKR.
- 자막 burn-in vs sidecar (.srt 별도 파일) — Supervisor 가 명시. default = burn-in.
