# audio_expert — Tools

## 구현됨

- `transcribe_video(video_path)` — Whisper STT, segment list 반환.
- `text_to_speech(text, voice_id, output_path)` — TTS (edge-tts default).
- `generate_bgm(prompt, duration_sec, video_path, mood, genre, tempo, energy)` — ElevenLabs Music으로 새 BGM 생성.
- `add_bgm(video_path, bgm_path, volume, ducking)` — 원본 음성을 보존하며 BGM mix.
- `generate_sfx(text, duration_seconds, loop, prompt_influence, output_path)` — ElevenLabs로 효과음 파일 생성.
- `add_sfx(video_path, sfx_path, at_time)` — 생성/보유한 효과음을 지정 시각에 삽입.

## TODO

- `mix_audio(video_path, audio_path, mode, original_volume=0.85, overlay_volume=1.0)` — replace / overlay. 나레이션은 반드시 overlay로 원본 소리를 보존.
- `denoise(audio_path)` — Demucs 또는 RNNoise.
- `normalize_loudness(path, target_lufs)` — pyloudnorm 또는 ffmpeg loudnorm filter.

## 구현 가이드

- TTS engine 추상화: `tts.py` 에 engine 별 dispatch. edge-tts / openai / elevenlabs.
- Whisper 는 `faster-whisper` 권장 (CPU/GPU 모두 빠름).
- BGM library 는 `assets/bgm/` 폴더 사전 적재 권장 (저작권 free).
- ducking 은 `ffmpeg -af "sidechaincompress=..."` 또는 librosa 기반 envelope.
