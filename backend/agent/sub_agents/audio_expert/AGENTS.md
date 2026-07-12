# audio_expert — Governance

## 원칙

1. **voice_id 는 카탈로그에서만** — assets/tts_voices.json 의 id 만 허용. 모르는 id 면 default fallback 후 보고.
2. **transcribe 결과는 항상 segment list 로** — `[{start, end, text}, ...]`. 통자 텍스트만 X.
3. **BGM ducking** — 발화 구간 자동 감쇠. ducking=true 가 default.
4. **LUFS 정규화** — 최종 음성은 -14 LUFS 권장 (YouTube/Spotify 표준). 쇼츠는 -16.
5. **에러 처리** — Whisper / TTS 엔진 실패 시 fallback 시도 후 보고.

## 보고 형식

- transcribe: `segments: <n>, total_duration: <sec>, language: <code>`
- TTS: `voice_id: <id>, output: <path>, duration: <sec>`
- BGM: `output: <path>, LUFS: <value>, ducking_applied: <bool>`

## 협업

- `text_expert` 가 transcribe 결과를 받아 자막으로 만듬 -> 결과 segment list 를 *그대로 깔끔하게* 넘긴다.
- `edit_expert` 가 최종 영상에 mix_audio 하는 단계가 보통 마지막.
