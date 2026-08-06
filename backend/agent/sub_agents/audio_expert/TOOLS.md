# audio_expert — Tools

## 구현됨

- `transcribe_video(video_path)` — Whisper STT, segment list 반환.
- `text_to_speech(text, voice_id, output_path)` — TTS (edge-tts default).
- `generate_bgm(prompt, duration_sec, video_path, mood, genre, tempo, energy)` — ElevenLabs Music으로 새 BGM 생성.
- `add_bgm(video_path, bgm_path, volume=1.0, speech_target_lufs=-16, bgm_offset_lu=6, ducking=true, ducking_threshold=0.03, ducking_ratio=4)` — 대사를 먼저 정규화하고 BGM을 기본 -22 LUFS로 맞춘 뒤 mix. 전사 타임스탬프 구간에서만 더킹하고, 캐시가 없으면 음성 대역 gate를 사용.
- `add_bgm_progression(video_path, segments, volume=1.0, speech_target_lufs=-16, bgm_offset_lu=6, ducking=true, ducking_threshold=0.03, ducking_ratio=4)` — 구간별 BGM에도 동일한 대사 기준 상대 음량·발화 구간 더킹 정책 적용.
- `generate_sfx(text, duration_seconds, loop, prompt_influence, output_path)` — ElevenLabs로 효과음 파일 생성.
- `add_sfx(video_path, sfx_path, at_time, sfx_target_lufs=-20)` — 효과음을 정규화하고 limiter를 적용해 지정 시각에 삽입.

## TODO

- `mix_audio(video_path, audio_path, mode, original_volume=0.85, overlay_volume=1.0)` — 나레이션/더빙 전용 replace 또는 overlay. BGM 파일 입력은 런타임에서 거부됨.
- `denoise(audio_path)` — Demucs 또는 RNNoise.
- `normalize_loudness(path, target_lufs)` — pyloudnorm 또는 ffmpeg loudnorm filter.

## 구현 가이드

- TTS engine 추상화: `tts.py` 에 engine 별 dispatch. edge-tts / openai / elevenlabs.
- Whisper 는 `faster-whisper` 권장 (CPU/GPU 모두 빠름).
- BGM library 는 `assets/bgm/` 폴더 사전 적재 권장 (저작권 free).
- ducking 은 `ffmpeg -af "sidechaincompress=..."` 또는 librosa 기반 envelope.
