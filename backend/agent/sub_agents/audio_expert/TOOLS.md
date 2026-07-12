# audio_expert — Tools

## 구현됨

- `transcribe_video(video_path)` — Whisper STT, segment list 반환.
- `text_to_speech(text, voice_id, output_path)` — TTS (edge-tts default).

## TODO

- `add_bgm(video_path, bgm_path, volume, ducking)` — BGM mix (ducking 자동).
- `add_sfx(video_path, sfx_path, at_time)` — 효과음 (woosh, ding, beat, …) 삽입.
- `mix_audio(video_path, audio_path, mode)` — replace / overlay.
- `denoise(audio_path)` — Demucs 또는 RNNoise.
- `normalize_loudness(path, target_lufs)` — pyloudnorm 또는 ffmpeg loudnorm filter.

## 구현 가이드

- TTS engine 추상화: `tts.py` 에 engine 별 dispatch. edge-tts / openai / elevenlabs.
- Whisper 는 `faster-whisper` 권장 (CPU/GPU 모두 빠름).
- BGM library 는 `assets/bgm/` 폴더 사전 적재 권장 (저작권 free).
- ducking 은 `ffmpeg -af "sidechaincompress=..."` 또는 librosa 기반 envelope.
