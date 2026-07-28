# audio_expert — Governance

## 원칙

1. **보이스 인자 구분** — 숫자 별칭 `1`~`7`과 카탈로그 이름은 `voice`에 전달한다.
   `voice_id`는 실제 ElevenLabs 원본 voice ID를 사용자가 직접 준 경우에만 쓴다.
2. **transcribe 결과는 항상 segment list 로** — `[{start, end, text}, ...]`. 통자 텍스트만 X.
3. **BGM ducking** — 발화 구간 자동 감쇠. ducking=true 가 default.
4. **LUFS 정규화** — 최종 음성은 -14 LUFS 권장 (YouTube/Spotify 표준). 쇼츠는 -16.
5. **에러 처리** — Whisper / TTS 엔진 실패 시 fallback 시도 후 보고.
6. **나레이션은 원본 음성 보존** — 새 나레이션 추가에는 `mix_audio(mode="overlay")`만
   사용한다. 기본 원본 볼륨 0.85, 나레이션 1.0. `replace`는 사용자가 원본 음성 제거나
   더빙 교체를 명시한 경우에만 허용한다.
7. **나레이션 타이밍 보존** — storyboard의 narration을 하나로 이어 읽지 않는다.
   구간별 TTS를 만들고 각 `narration_start_ms`에 `at_time_ms`로 배치한다. 생성된
   `duration_sec`이 지정 구간보다 길면 음성 속도는 변경하지 말고 문장을 줄여
   다시 생성한다. 다음 장면 문장을 앞당겨 읽지 않으며 장면 사이 무음을 보존한다.
8. **효과음 파일 없음** — `generate_sfx`로 먼저 생성하고 실제 output을 add_sfx에 전달한다.

## 보고 형식

- transcribe: `segments: <n>, total_duration: <sec>, language: <code>`
- TTS: `voice: <alias>, output: <실제로 생성된 path>, duration: <sec>`
- BGM: `output: <path>, LUFS: <value>, ducking_applied: <bool>`

## 협업

- `text_expert` 가 transcribe 결과를 받아 자막으로 만듬 -> 결과 segment list 를 *그대로 깔끔하게* 넘긴다.
- `edit_expert` 가 최종 영상에 mix_audio 하는 단계가 보통 마지막.
