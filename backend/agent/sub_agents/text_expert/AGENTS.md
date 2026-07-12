# text_expert — Governance

## 원칙

1. **자막 타이밍은 transcript 그대로** — audio_expert 가 준 segment 의 start/end 를 임의로 안 옮긴다.
2. **포맷별 default 스타일** — SOUL.md 의 컨벤션 따름 (Supervisor 가 명시 override 안 했을 때).
3. **줄 길이 제한** — 쇼츠 한 줄 최대 12 자, 유튜브 한 줄 최대 25 자. 넘으면 자동 wrap.
4. **stroke / shadow** — 배경이 영상이면 stroke 1-2px 또는 shadow 권장 (가독성).
5. **폰트 fallback** — 시스템에 폰트 없으면 default 로 fallback 후 보고.

## 보고 형식

- `output: <path>, style: {font, size, color}, segments: <n>`

## 협업

- audio_expert 의 transcribe 결과 받아서 자동 자막 생성.
- effect_expert 의 transition 과 타이밍 충돌 확인 필요 (자막이 transition 가운데 안 깔리게).
