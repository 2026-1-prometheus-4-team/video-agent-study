# Tool Catalog (TOOLS.md)

Supervisor 는 대부분의 실행을 sub-agent 에 위임하지만, 다음 2개는 직접 부른다.

| tool                    | 시그니처                                                        | 설명 |
|-------------------------|------------------------------------------------------------------|------|
| `search_video_segments` | `(video_path, query, queries?, max_results?, merge_gap_ms?) -> json` | 장면 후보 검색 (컷 안 함). 반환 stats.top_score / margin 으로 확신도 판단. status=no_match 면 near_misses 후보 포함. |
| `ask_user`              | `(question, candidates?, options?, context) -> str`             | 실행 중 사용자 확인. candidates 는 search 결과 matches/near_misses 그대로 전달 가능. 호출 후엔 즉시 'AWAITING_USER' 로 응답 종료. |

어떤 sub-agent 가 어떤 능력을 갖고 있는지 *상세히* 알아야
올바른 위임이 가능하다. 이 문서는 그 카탈로그다.

각 sub-agent 가 보유한 tool 은 sub_agents/<role>/TOOLS.md 로도 별도 정의됨.
이 파일은 Supervisor 시점의 high-level view.


## edit_expert

영상 구조 편집. FFmpeg 기반. 컷 / 머지 / 내용 기반 장면 검색.

| tool                     | 시그니처                                                          | 설명                                  |
|--------------------------|-------------------------------------------------------------------|---------------------------------------|
| `cut_video`              | `(video_path, start_ms, end_ms, output_path?) -> path`            | 구간 cut. **타임스탬프는 ms 단위.** 병렬 호출 가능. |
| `merge_video`            | `(clip_paths: list[str], output_path?) -> path`                   | 여러 클립 concat. 스펙 다르면 자동 reencode. |
| `search_video_segments`  | `(video_path, query, queries?, max_results?, merge_gap_ms?) -> json` | 분석 JSON 에서 자연어로 장면 검색 (컷 안 함). 인접 매칭 자동 병합, stats + near_misses 포함 |
| `cut_by_description`     | `(video_path, query, merge?, padding_ms?, max_segments?) -> json` | 자연어 장면 검색 + 자동 컷 (+선택 병합). 중첩 구간은 union 후 컷 |

호출 시 박을 정보: 입력/출력 경로, start_ms/end_ms (밀리초 int) 또는 자연어 query.

**중요 — 장면 선별 원칙:**
- 목표 길이(예: 1분)가 있으면 그 길이에 맞는 장면 *몇 개만 선별*해서 cut 한다.
  전체 scene 을 모두 cut 하는 것 금지 (원본 길이 그대로 나옴).
- "입국 장면", "골 장면" 같은 내용 기반 요청은 scene_id 나열 대신
  `cut_by_description(query=...)` 을 장면당 1 회씩 쓰는 것이 정확하다.


## audio_expert

음성 / 오디오 / BGM / 효과음 / 나래이션 전반.

| tool                 | 시그니처                                                              | 설명                                   |
|----------------------|------------------------------------------------------------------------|----------------------------------------|
| `transcribe_video`   | `(video_path) -> [{start, end, text}]`                                | Whisper 자막/발화 추출 (timestamp)     |
| `text_to_speech`     | `(text, voice?, voice_id?, stability?, style?, speed?, output_path?, model?) -> json` | TTS / 나래이션 합성. 생성 이력은 narration.json manifest 에 자동 기록 |
| `transcribe_video_to_speech` | `(video_path, voice?, voice_id?, output_path?, model?, stability?, style?, speed?) -> json` | 영상 발화를 전사해 그대로 다른 목소리로 재생성 (더빙 / 보이스 교체) |
| `add_bgm`            | `(video_path, bgm_path, volume, ducking, narration_path?) -> path`    | BGM 깔기 (ducking = 발화 구간 자동 감쇠) |
| `add_sfx`            | `(video_path, sfx_path, at_time) -> path`                             | 효과음 (woosh, ding, beat 등) 삽입     |
| `mix_audio`          | `(video_path, audio_path, mode, output_path?, at_time_ms?) -> path`   | 오디오 mix. overlay + at_time_ms 로 특정 시점 배치 |
| `denoise`            | `(audio_path) -> path`                                                 | 노이즈 제거                            |
| `normalize_loudness` | `(path, target_lufs) -> path`                                          | 라우드니스 정규화 (-14 LUFS 등)        |

TTS voice 는 assets/tts_voices.json 의 카탈로그 id (예: `male_ko_general`),
숫자 별칭 (`"2"` -> .env 의 ELEVENLABS_VOICE_2), 또는 raw ElevenLabs voice id.
명시적 id 를 쓰려면 voice_id 파라미터 (voice 보다 우선).
"이 영상 목소리만 바꿔줘" = transcribe_video_to_speech (전사 + 재합성 한 번에).
사용자 표현 매핑: "더 차분하게" -> stability 상향(0.7~0.9)
+ speed 하향(0.9), "더 밝게/에너지있게" -> stability 하향(0.3) + style 상향.
특정 구간 나래이션 교체 = 해당 문장만 재합성 -> mix_audio(overlay, at_time_ms).
나래이션 / TTS 는 같은 tool — 사용 맥락만 다르다.
"비트", "효과음", "사운드" 같은 사용자 어휘는 모두 `add_sfx` 로 매핑.


## text_expert

자막 / 타이틀 / 캡션 / 오버레이 텍스트 전반.

**자막은 큐 문서(videos/subtitles/<stem>.cues.json)가 진실의 원천이다.**
큐 문서 = {style_defaults, cues:[{id, start, end, text, style?}]}. 수정은 데이터
수정 + render 1회 — 재전사 금지. 렌더는 항상 번인 전 source_video 기준
(이중 번인 방지, 문서에 기록돼 있음).

| tool                       | 시그니처                                                        | 설명                              |
|----------------------------|------------------------------------------------------------------|-----------------------------------|
| `list_subtitle_cues`       | `(video_path) -> json`                                          | 큐 문서 조회 (없으면 사이드카에서 자동 승격) |
| `update_subtitle_cues`     | `(video_path, updates:[{id?|index?|at_ms?, text?, start?, end?, style?, delete?}]) -> json` | 큐 배치 수정 (오타/타이밍/개별 스타일/삭제) |
| `add_subtitle_cue`         | `(video_path, start, end, text, style?) -> json`                | 새 큐 삽입                        |
| `set_subtitle_style`       | `(video_path, style, scope?) -> json`                           | 전역 스타일 (defaults) 또는 전체 큐 일괄 |
| `render_subtitles`         | `(video_path, output_path?) -> path`                            | 큐 문서 -> ASS -> 번인 (per-cue 스타일 반영) |
| `add_subtitle`             | `(video_path, srt_path, style) -> path`                         | (레거시) SRT 직접 burn-in         |
| `add_auto_subtitle`        | `(video_path, style) -> path`                                   | STT -> 큐 문서 생성 -> 렌더 (최초 자막용) |
| `add_title`                | `(video_path, text, position, duration, anim) -> path`          | 타이틀 오버레이 (애니메이션 포함) |
| `add_caption`              | `(video_path, text, at_time, duration, style) -> path`          | 한 줄 캡션 (강조 텍스트)          |
| `add_emoji_overlay`        | `(video_path, emoji, at_time, position) -> path`                | 쇼츠/릴스용 이모지 강조           |

style = {font, size, color(임의 hex 가능), stroke_color, stroke_width, position, margin_v, bold, fade}.
개별 큐 지정: "두번째 자막" -> index=1, "0:32 자막" -> at_ms=32000.
폰트는 assets/fonts 보유분만 — 없는 폰트 요청 시 보유 목록과 함께 사용자 안내.
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
