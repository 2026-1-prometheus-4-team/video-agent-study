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
- BGM 생성과 삽입을 구분해서 보고한다. 생성만 성공한 경우 "BGM 파일 생성 완료"라고만 말하고 영상 삽입 완료라고 표현하지 않는다.
- BGM mix: `output: <path>, LUFS: <value>, bgm_mixed: <bool>, mix_verified: <bool>, volume: <value>, ducking_applied: <bool>`
- `mix_verified=false`이면 성공으로 단정하지 말고 결과 오디오 검증 실패를 명시한다.
- BGM mix 기본 순서: 원본 영상 오디오 -16 LUFS 정규화 → BGM을 6 LU 낮은 -22 LUFS로 정규화 → 전사 타임스탬프 발화 구간 더킹(4:1) → limiter → 목표에서 1 LU 이상 벗어날 때만 최대 ±3 dB 보정.
- 효과음 생성 프롬프트는 항상 비언어·음성/대사 금지 조건을 포함하고, 삽입 전 -20 LUFS로 정규화한다.
- BGM 파일은 `mix_audio`에 절대 전달하지 않는다. 단일 BGM은 `add_bgm`, 구간별 BGM은 `add_bgm_progression`만 사용한다.
- 전사 타임스탬프가 없으면 BGM mix 전에 `transcribe_video`를 실행한다. Python STT 엔진을 사용할 수 없으면 FFmpeg 음성대역 VAD로 자동 전환하고 `ducking_mode=ffmpeg_voice_vad`와 전사 경고를 보고한다.
- BGM 완료 보고에는 `dialogue_lufs`, `bgm_non_speech_lufs`, `bgm_speech_lufs`, `mix_lufs`, `actual_dialogue_bgm_gap`, `calibration_passed`를 반드시 포함한다.

## 협업

- `text_expert` 가 transcribe 결과를 받아 자막으로 만듬 -> 결과 segment list 를 *그대로 깔끔하게* 넘긴다.
- `edit_expert` 가 최종 영상에 mix_audio 하는 단계가 보통 마지막.
