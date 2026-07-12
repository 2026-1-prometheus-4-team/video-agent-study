# Tool Catalog (TOOLS.md)

Supervisor 는 sub-agent 만 부른다. 직접 부르는 tool 은 없다.
하지만 어떤 sub-agent 가 어떤 능력을 갖고 있는지 *상세히* 알아야
올바른 위임이 가능하다. 이 문서는 그 카탈로그다.

각 sub-agent 가 보유한 tool 은 sub_agents/<role>/TOOLS.md 로도 별도 정의됨.
이 파일은 Supervisor 시점의 high-level view.


## edit_expert

영상 구조 편집. FFmpeg 기반. 컷 / 머지 / 내용 기반 장면 검색.

| tool                     | 시그니처                                                          | 설명                                  |
|--------------------------|-------------------------------------------------------------------|---------------------------------------|
| `cut_video`              | `(video_path, start_ms, end_ms, output_path?) -> path`            | 구간 cut. **타임스탬프는 ms 단위.** 병렬 호출 가능. |
| `merge_video`            | `(clip_paths: list[str], output_path?) -> path`                   | 여러 클립 concat. 스펙 다르면 자동 reencode. |
| `search_video_segments`  | `(video_path, query, max_results?) -> json`                       | 분석 JSON 에서 자연어로 장면 검색 (컷 안 함) |
| `cut_by_description`     | `(video_path, query, merge?, padding_ms?, max_segments?) -> json` | 자연어 장면 검색 + 자동 컷 (+선택 병합) |

호출 시 박을 정보: 입력/출력 경로, start_ms/end_ms (밀리초 int) 또는 자연어 query.

**중요 — 장면 선별 원칙:**
- 목표 길이(예: 1분)가 있으면 그 길이에 맞는 장면 *몇 개만 선별*해서 cut 한다.
  전체 scene 을 모두 cut 하는 것 금지 (원본 길이 그대로 나옴).
- "입국 장면", "골 장면" 같은 내용 기반 요청은 scene_id 나열 대신
  `cut_by_description(query=...)` 을 장면당 1 회씩 쓰는 것이 정확하다.


## audio_expert

음성 / 오디오 / BGM / 효과음 / 나래이션 전반.

| tool                 | 시그니처                                               | 설명                                   |
|----------------------|--------------------------------------------------------|----------------------------------------|
| `transcribe_video`   | `(video_path) -> [{start, end, text}]`                 | Whisper 자막/발화 추출 (timestamp)     |
| `text_to_speech`     | `(text, voice_id, output_path) -> path`                | TTS / 나래이션 음성 합성               |
| TODO: `add_bgm`      | `(video_path, bgm_path, volume, ducking) -> path`      | BGM 깔기 (ducking = 발화 구간 자동 감쇠) |
| TODO: `add_sfx`      | `(video_path, sfx_path, at_time) -> path`              | 효과음 (woosh, ding, beat 등) 삽입     |
| TODO: `mix_audio`    | `(video_path, audio_path, mode) -> path`               | 영상에 오디오 트랙 mix (replace / overlay) |
| TODO: `denoise`      | `(audio_path) -> path`                                 | 노이즈 제거                            |
| TODO: `normalize_loudness` | `(path, target_lufs) -> path`                    | 라우드니스 정규화 (-14 LUFS 등)        |

TTS voice_id 는 assets/tts_voices.json 의 id 사용 (예: `male_ko_general`).
나래이션 / TTS 는 같은 tool — 사용 맥락만 다르다.
"비트", "효과음", "사운드" 같은 사용자 어휘는 모두 `add_sfx` 로 매핑.


## text_expert

자막 / 타이틀 / 캡션 / 오버레이 텍스트 전반.

| tool                       | 시그니처                                              | 설명                              |
|----------------------------|-------------------------------------------------------|-----------------------------------|
| TODO: `add_subtitle`       | `(video_path, srt_path, style) -> path`               | SRT 자막 burn-in                  |
| TODO: `add_auto_subtitle`  | `(video_path, style) -> path`                         | transcribe 결과 자동으로 자막화   |
| TODO: `add_title`          | `(video_path, text, position, duration, anim) -> path`| 타이틀 오버레이 (애니메이션 포함) |
| TODO: `add_caption`        | `(video_path, text, at_time, duration, style) -> path`| 한 줄 캡션 (강조 텍스트)          |
| TODO: `add_emoji_overlay`  | `(video_path, emoji, at_time, position) -> path`      | 쇼츠/릴스용 이모지 강조           |

style = {font, size, color, stroke, bg, position}.
SOUL.md 의 *포맷별 default 스타일* 따름 — 쇼츠는 큰 폰트·중앙, 유튜브는 중간·하단.


## effect_expert

시각 이펙트 / 전환효과 / 색보정.

| tool                       | 시그니처                                            | 설명                              |
|----------------------------|-----------------------------------------------------|-----------------------------------|
| TODO: `apply_fade`         | `(video_path, in_sec, out_sec) -> path`             | 페이드 인/아웃 (밝기)             |
| TODO: `apply_zoom`         | `(video_path, start, end, scale, focus_xy) -> path` | Ken Burns 줌 (시점 보정 포함)     |
| TODO: `apply_transition`   | `(clips: list[str], type) -> path`                  | clip 간 트랜지션 (cut/dissolve/wipe/slide) |
| TODO: `apply_blur`         | `(video_path, region, intensity) -> path`           | 영역 블러 (얼굴/로고 가림)        |
| TODO: `apply_color_grade`  | `(video_path, preset) -> path`                      | 색보정 (warm/cool/cinematic/vivid)|
| TODO: `apply_speed_ramp`   | `(video_path, [(time, factor)]) -> path`            | 속도 ramp (slow-mo / 빠른 cut)    |
| TODO: `apply_shake`        | `(video_path, intensity, at_time) -> path`          | 카메라 흔들기 (강조)              |
| TODO: `apply_lut`          | `(video_path, lut_file) -> path`                    | 3D LUT 적용 (영화풍 색감)         |

사용자 어휘 매핑:
- "전환" / "트랜지션" -> `apply_transition`
- "이펙트" / "효과" -> 맥락 보고 가장 가까운 것 (zoom / shake / blur / color_grade)
- "감성" / "영화같이" -> `apply_color_grade(preset=cinematic)` + `apply_lut`


## research_expert

웹 / 트렌드 / 레퍼런스 조사.

| tool                  | 시그니처                                              | 설명                                |
|-----------------------|-------------------------------------------------------|-------------------------------------|
| TODO: `web_search`    | `(query) -> [results]`                                | Tavily 검색                         |
| TODO: `youtube_trend` | `(category, region) -> [videos]`                      | YouTube Data API trending           |


## 전처리 tool (Supervisor 가 직접 보지는 않음)

다음은 graph 진입 직전 / script 노드에서 호출되어 `video_context` 를 채움.

| tool                      | 위치                            | 설명                              |
|---------------------------|---------------------------------|-----------------------------------|
| `analyze_video`           | tools/video_understanding_eun   | Gemini multimodal 영상 분석       |
| `analyze_video_scenes`    | tools/video_analysis            | OpenCV + Gemini Vision 프레임 분석 |
| `get_video_info`          | tools/scene                     | ffprobe 메타데이터                |

생성된 결과는 `video_context.scenes` / `transcript` 로 들어가 stable prefix 의 일부가 됨.


## 호출 패턴 (참고)

```
spawn_sub_agent(
    "edit_expert",
    task="""
videos/raw/video1.mp4 의 11.15~11.17 초 구간을 cut 해서
videos/clips/cut_0.mp4 로 저장해.

이건 사용자가 '맛있다' 라고 말하는 구간 중 첫 번째 occurrence 다.
output 파일은 다음 step (merge) 의 입력으로 쓰임.
타겟 포맷: shorts (이후 9:16 으로 resize 예정).
""",
    allowed_tools=["cut_video"],
)
```

명시적 task + 좁은 allowlist = OpenClaw ACP 패턴.


## 포맷별 권장 처리 순서

플랫폼 특성 상 같은 tool 도 *호출 순서가 포맷에 따라 다르다*.

### shorts / 릴스
```
transcribe (필요시) → cut (병렬) → merge → resize(9:16) → tts → subtitle → mux_audio
                                              ↑
                                   리프레임은 자막 전에 (자막 위치 계산 위해)
```

### 유튜브 영상
```
transcribe → cut (선별, 병렬) → merge → tts (선택) → subtitle(하단) → fade(intro/outro)
```

### 일반 영상 (사용자 요청 그대로)
```
사용자 시퀀스 따라 순차 호출. 포맷 변환 추가 X.
```
