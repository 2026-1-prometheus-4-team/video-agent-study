# edit_expert — Tools

본 sub-agent 가 직접 호출 가능한 tool. (agent/tools/__init__.py 의 `tool_groups["edit"]`)

## 구현됨

- `cut_video(video_path, start_ms, end_ms, output_path=None)` — ms 기준 구간 cut. 병렬 호출 가능.
- `merge_video(clip_paths, output_path=None)` — 여러 클립 concat. stream copy 우선, 해상도/fps가 다르면 reencode fallback.
- `search_video_segments(video_path, query, analysis_path=None, max_results=5)` — 분석 JSON에서 장면 설명/객체/자막 기반 구간 검색.
- `cut_by_description(video_path, query, analysis_path=None, merge=False, padding_ms=0, max_segments=5, output_path=None)` — 내용 검색 후 자동 cut, 필요 시 merge.
- `cut_scene(video_path, scene_name=None, scene_index=None, analysis_path=None, output_path=None)` — 기존 scene 이름 또는 분석 JSON segment index 기반 cut.
- `resize_video(video_path, aspect_ratio="9:16", mode="crop", output_path=None)` — 화면비 변환.
  aspect_ratio: 9:16(쇼츠) / 16:9 / 1:1 / 4:5. mode: crop(중앙 기준 꽉 채움) / pad(검은 여백).
  cut·merge 로 편집을 끝낸 *뒤* 마지막에 호출한다.

## TODO (owner 가 채울 것)

다음은 시그니처만 명시. 구현은 별도 PR.

- `reframe(path, target_aspect)` — subject-aware 리프레임 (인물 추적 크롭)
- `change_speed(path, factor)` — 0.25x ~ 4x
- `crop(path, x, y, w, h)`
- `rotate(path, degrees)` — 90 / 180 / 270
- `trim(path, head_cut, tail_cut)` — 앞/뒤 trim
- `concat_with_transition(paths, transition_type)` — merge + transition (effect_expert 와 협업)

## 구현 가이드

- 새 tool 추가 시 `agent/tools/<name>.py` 에 작성, `TOOLS = [...]` 노출.
- `agent/tools/__init__.py` 의 `tool_groups["edit"]` 에 추가.
- FFmpeg 호출은 subprocess.run, stderr 캡처 필수.
- 경로는 모두 절대 경로 또는 프로젝트 루트 기준 (`videos/clips/cut_0.mp4`).
- 분석 JSON은 기본적으로 `videos/<영상명>_analysis.json` 을 자동 탐색한다.
