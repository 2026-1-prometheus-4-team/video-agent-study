# edit_expert — Tools

본 sub-agent 가 직접 호출 가능한 tool. (agent/tools/__init__.py 의 `tool_groups["edit"]`)

## 구현됨

- `cut_video(input_path, start, end, output_path)` — 구간 cut. 병렬 호출 가능.
- `cut_scene(scene_id)` — analysis.json 의 scene index 로 cut.

## TODO (owner 가 채울 것)

다음은 시그니처만 명시. 구현은 별도 PR.

- `merge_video(paths: list[str], output: str)` — concat (재인코딩 없이 stream copy 우선)
- `resize(path, width, height, mode)` — 해상도. mode: pad / crop / stretch
- `reframe(path, target_aspect)` — subject-aware 9:16 / 16:9 리프레임
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
