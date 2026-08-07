"""
Script 생성 노드

사용자 자연어 요청 + 사전 영상 분석을 받아서
6 단계 (또는 그 이상) 의 plan JSON 을 생성한다.

사진의 "Script 생성 노드" 가 이 모듈에 해당.

흐름:
1. system prompt: SOUL + AGENTS + TOOLS + tts_voices + analysis 결합 (stable, 캐시)
2. user prompt:  사용자 요청 원문 + (있으면) 이전 plan + 피드백
3. LLM 호출, JSON 추출
4. state 에 script_plan 저장
5. plan.questions 가 비어있지 않으면 interrupt 게이트가 사용자에게 물어봄
"""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from agent import config
from agent.llm import make_llm
from agent.prompt_builder import build_script_node_system_prompt
from agent.state import AgentState

logger = logging.getLogger(__name__)


# =============================================================
# JSON 추출
# =============================================================

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_json(text: str) -> dict[str, Any]:
    """LLM 응답에서 JSON 블록 추출.

    1) ```json ... ``` 코드블록
    2) 그 외엔 첫 `{` 부터 마지막 `}` 까지
    """
    m = _JSON_BLOCK.search(text)
    payload = m.group(1) if m else text

    if not m:
        # bracket span fallback
        start = payload.find("{")
        end = payload.rfind("}")
        if start != -1 and end != -1:
            payload = payload[start : end + 1]

    try:
        return json.loads(payload)
    except json.JSONDecodeError as e:
        # Gemini occasionally leaves a trailing comma before a closing bracket.
        # This is unambiguous to repair and avoids an unnecessary second call.
        repaired = re.sub(r",\s*([}\]])", r"\1", payload)
        if repaired != payload:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        logger.error("script JSON parse failed: %s\n%s", e, payload[:500])
        return {
            "_parse_error": str(e),
            "_raw": payload[:2000],
            "questions": [
                "script 생성 중 JSON 파싱 오류. 사용자 요청을 다시 한 번 명확히 말씀해 주세요."
            ],
        }


def _message_text(content: Any) -> str:
    if isinstance(content, list):
        return " ".join(
            (part.get("text", "") if isinstance(part, dict) else str(part))
            for part in content
        )
    return str(content)


def _parse_failure_plan(error: object) -> dict[str, Any]:
    """End cleanly instead of presenting a zero-step approval card."""
    return {
        "mode": "chat",
        "reply": (
            "편집 계획 JSON 생성이 두 번 모두 올바른 형식으로 끝나지 않았어. "
            "빈 계획을 승인 화면에 표시하지 않고 이번 실행을 종료했어. "
            "같은 요청을 다시 보내면 새 계획을 생성할게."
        ),
        "steps": [],
        "questions": [],
        "_script_error": str(error)[:1000],
    }


def _enforce_requested_features(plan: dict[str, Any], user_request: str) -> dict[str, Any]:
    """Drop optional production features the user did not request.

    Prompt-only guards are not sufficient: a creative brief often inspires the
    model to add narration/BGM and then critic treats those invented steps as
    required. Keep the plan's creative text, but constrain executable steps and
    follow-up questions to explicit user intent.
    """
    request = user_request.casefold()

    def requested(*terms: str) -> bool:
        return any(term.casefold() in request for term in terms)

    wants_tts = requested(
        "tts", "나레이션", "내레이션", "음성 합성", "목소리", "더빙", "보이스",
    )
    wants_bgm = requested("bgm", "배경 음악", "배경음악", "노래", "음악 넣")
    wants_sfx = requested("sfx", "효과음")
    wants_audio_mix = wants_tts or requested("오디오", "음원", "소리 섞", "mix", "믹스")
    wants_caption = requested(
        "캡션", "화면 문구", "온스크린",
        "타이틀", "title",
        "제목 넣", "제목을 넣", "제목 추가", "제목 달", "제목 붙", "제목 올",
        "텍스트 넣", "텍스트 추가",
        "인트로",
    )
    wants_emoji = requested("이모지", "emoji")

    brief = plan.get("creative_brief")
    if isinstance(brief, dict):
        if not wants_bgm:
            brief["bgm_flow"] = ""
        storyboard = brief.get("storyboard")
        if isinstance(storyboard, list):
            for scene in storyboard:
                if not isinstance(scene, dict):
                    continue
                if not wants_tts:
                    scene["narration"] = ""
                if not wants_caption:
                    scene["on_screen_text"] = ""

    def keep_step(step: Any) -> bool:
        if not isinstance(step, dict):
            return False
        action = str(step.get("action", "")).casefold()
        if action in {"text_to_speech", "transcribe_video_to_speech"}:
            return wants_tts
        if action == "mix_audio":
            return wants_audio_mix
        if action == "add_bgm":
            return wants_bgm
        if action == "add_sfx":
            return wants_sfx
        if action in {"add_caption", "add_title"}:
            return wants_caption
        if action == "add_emoji_overlay":
            return wants_emoji
        return True

    path_aliases: dict[str, str] = {}

    def resolve_alias(value: Any) -> Any:
        if isinstance(value, str):
            seen: set[str] = set()
            while value in path_aliases and value not in seen:
                seen.add(value)
                value = path_aliases[value]
            return value
        if isinstance(value, list):
            return [resolve_alias(item) for item in value]
        if isinstance(value, dict):
            return {key: resolve_alias(item) for key, item in value.items()}
        return value

    raw_steps = [
        step for step in plan.get("steps", [])
        if isinstance(step, dict)
    ]
    raw_by_id = {
        step.get("step_id"): step
        for step in raw_steps
        if step.get("step_id") is not None
    }
    removed_dependencies: dict[Any, list[Any]] = {}
    kept_original_ids: list[Any] = []
    steps = []
    for raw_step in raw_steps:
        if not isinstance(raw_step, dict):
            continue
        step = dict(raw_step)
        params = resolve_alias(dict(step.get("params") or {}))
        step["params"] = params
        if keep_step(step):
            steps.append(step)
            kept_original_ids.append(step.get("step_id"))
            continue

        # Audio/text overlays generally preserve the input video's timeline.
        # If such a step is omitted, downstream references to its output must
        # point back to the resolved input rather than a file that will not exist.
        old_id = step.get("step_id")
        if old_id is not None:
            dependencies = step.get("depends_on")
            removed_dependencies[old_id] = (
                list(dependencies) if isinstance(dependencies, list) else []
            )
        output_path = params.get("output_path")
        input_path = next(
            (
                params.get(key)
                for key in (
                    "video_path",
                    "input_path",
                    "input_video",
                    "input_video_path",
                )
                if isinstance(params.get(key), str)
            ),
            None,
        )
        if isinstance(output_path, str) and isinstance(input_path, str):
            path_aliases[output_path] = input_path

    # A kept step may reference a removed output that appeared immediately
    # before it; resolve once more after all aliases have been collected.
    for step in steps:
        step["params"] = resolve_alias(step.get("params") or {})

    # If a removed producer used a malformed input key, its output can still be
    # recognized as unavailable. Reconnect only that missing generated path to
    # the latest valid video output; source video paths are never rewritten.
    raw_output_paths = {
        str((step.get("params") or {}).get("output_path"))
        for step in raw_steps
        if isinstance((step.get("params") or {}).get("output_path"), str)
    }
    produced_paths: set[str] = set()
    latest_video_output: str | None = None
    video_extensions = (".mp4", ".mov", ".mkv", ".avi", ".webm")
    for step in steps:
        params = dict(step.get("params") or {})
        video_path = params.get("video_path")
        if (
            isinstance(video_path, str)
            and video_path in raw_output_paths
            and video_path not in produced_paths
            and latest_video_output
        ):
            params["video_path"] = latest_video_output
        step["params"] = params

        output_path = params.get("output_path")
        if isinstance(output_path, str):
            produced_paths.add(output_path)
            if output_path.casefold().endswith(video_extensions):
                latest_video_output = output_path

    old_to_new = {
        old_id: index
        for index, old_id in enumerate(kept_original_ids, 1)
        if old_id is not None
    }

    def resolve_dependency(old_id: Any, seen: set[Any] | None = None) -> list[int]:
        if old_id in old_to_new:
            return [old_to_new[old_id]]
        if old_id not in removed_dependencies:
            return []
        visited = set(seen or ())
        if old_id in visited:
            return []
        visited.add(old_id)
        resolved: list[int] = []
        for dependency in removed_dependencies[old_id]:
            resolved.extend(resolve_dependency(dependency, visited))
        return resolved

    for index, (step, old_id) in enumerate(zip(steps, kept_original_ids), 1):
        dependencies = step.get("depends_on")
        repaired_dependencies: list[int] = []
        if isinstance(dependencies, list):
            for dependency in dependencies:
                for resolved in resolve_dependency(dependency):
                    if resolved != index and resolved not in repaired_dependencies:
                        repaired_dependencies.append(resolved)
        step["depends_on"] = repaired_dependencies
        step["step_id"] = index

    producer_by_path = {
        str((step.get("params") or {}).get("output_path")): step["step_id"]
        for step in steps
        if isinstance((step.get("params") or {}).get("output_path"), str)
    }
    for step in steps:
        params = step.get("params") or {}
        consumed_paths = []
        video_path = params.get("video_path")
        if isinstance(video_path, str):
            consumed_paths.append(video_path)
        clip_paths = params.get("clip_paths")
        if isinstance(clip_paths, list):
            consumed_paths.extend(path for path in clip_paths if isinstance(path, str))
        dependencies = list(step.get("depends_on") or [])
        for consumed_path in consumed_paths:
            producer = producer_by_path.get(consumed_path)
            if producer and producer != step["step_id"] and producer not in dependencies:
                dependencies.append(producer)
        step["depends_on"] = sorted(dependencies)

    plan["steps"] = steps

    questions = []
    for question in plan.get("questions", []):
        text = str(question).casefold()
        if not wants_tts and any(term in text for term in ("tts", "나레이션", "내레이션", "보이스")):
            continue
        if not wants_bgm and any(term in text for term in ("bgm", "배경 음악", "배경음악")):
            continue
        if not wants_sfx and any(term in text for term in ("sfx", "효과음")):
            continue
        questions.append(question)
    plan["questions"] = questions
    return plan


def _constrain_cut_duration(
    plan: dict[str, Any],
    user_request: str,
    video_context: dict[str, Any] | None,
) -> dict[str, Any]:
    """Keep planned cuts inside an explicit duration range after speech snap."""
    duration_match = re.search(
        r"(\d+(?:\.\d+)?)\s*(?:초|s)?\s*[~\-–]\s*"
        r"(\d+(?:\.\d+)?)\s*(?:초|s)",
        user_request,
        re.IGNORECASE,
    )
    if not duration_match or not isinstance(video_context, dict):
        return plan

    min_ms = int(float(duration_match.group(1)) * 1000)
    max_ms = int(float(duration_match.group(2)) * 1000)
    if min_ms > max_ms:
        min_ms, max_ms = max_ms, min_ms

    transcripts: dict[str, list[dict[str, Any]]] = {}
    for item in video_context.get("transcript", []):
        if not isinstance(item, dict) or not item.get("video"):
            continue
        transcripts.setdefault(str(item["video"]), []).append(item)

    cuts: list[dict[str, Any]] = []
    for index, step in enumerate(plan.get("steps", [])):
        if not isinstance(step, dict) or step.get("action") != "cut_video":
            continue
        params = step.get("params") or {}
        try:
            start_ms = int(params["start_ms"])
            end_ms = int(params["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        source = str(params.get("video_path", ""))
        snapped_start, snapped_end = start_ms, end_ms
        for segment in transcripts.get(source, []):
            try:
                speech_start = int(round(float(segment["start"]) * 1000))
                speech_end = int(round(float(segment["end"]) * 1000))
            except (KeyError, TypeError, ValueError):
                continue
            if (
                speech_start < start_ms < speech_end
                and start_ms - speech_start <= 4000
            ):
                snapped_start = min(snapped_start, speech_start)
            if (
                speech_start < end_ms < speech_end
                and speech_end - end_ms <= 4000
            ):
                snapped_end = max(snapped_end, speech_end)
        cuts.append({
            "index": index,
            "source": source,
            "duration_ms": max(0, snapped_end - snapped_start),
            "output_path": str(params.get("output_path", "")),
        })

    total_ms = sum(cut["duration_ms"] for cut in cuts)
    if total_ms <= max_ms:
        return plan

    source_counts: dict[str, int] = {}
    for cut in cuts:
        source_counts[cut["source"]] = source_counts.get(cut["source"], 0) + 1

    removed_indices: set[int] = set()
    removed_outputs: set[str] = set()
    while total_ms > max_ms:
        removable = [
            cut for cut in cuts
            if cut["index"] not in removed_indices
            and source_counts.get(cut["source"], 0) > 1
            and total_ms - cut["duration_ms"] >= min_ms
        ]
        if not removable:
            break
        # Prefer the removal that lands closest to the requested upper bound.
        chosen = min(
            removable,
            key=lambda cut: abs(max_ms - (total_ms - cut["duration_ms"])),
        )
        removed_indices.add(chosen["index"])
        if chosen["output_path"]:
            removed_outputs.add(chosen["output_path"])
        source_counts[chosen["source"]] -= 1
        total_ms -= chosen["duration_ms"]

    path_aliases: dict[str, str] = {}

    def resolve(value: Any) -> Any:
        if isinstance(value, str):
            seen: set[str] = set()
            while value in path_aliases and value not in seen:
                seen.add(value)
                value = path_aliases[value]
            return value
        if isinstance(value, list):
            return [
                resolve(item)
                for item in value
                if not (isinstance(item, str) and item in removed_outputs)
            ]
        if isinstance(value, dict):
            return {key: resolve(item) for key, item in value.items()}
        return value

    constrained: list[dict[str, Any]] = []
    for index, raw_step in enumerate(plan.get("steps", [])):
        if index in removed_indices or not isinstance(raw_step, dict):
            continue
        step = dict(raw_step)
        params = resolve(dict(step.get("params") or {}))
        step["params"] = params
        if step.get("action") == "merge_video":
            clip_paths = params.get("clip_paths")
            output_path = params.get("output_path")
            if isinstance(clip_paths, list) and len(clip_paths) == 0:
                continue
            if (
                isinstance(clip_paths, list)
                and len(clip_paths) == 1
                and isinstance(output_path, str)
            ):
                path_aliases[output_path] = str(clip_paths[0])
                continue
        constrained.append(step)

    for index, step in enumerate(constrained, 1):
        step["params"] = resolve(step.get("params") or {})
        step["step_id"] = index
    plan["steps"] = constrained
    plan["estimated_cut_duration_ms"] = total_ms
    return plan


def _propagate_target_aspect_ratio(plan: dict[str, Any]) -> dict[str, Any]:
    """Normalize each clip before concat so mixed orientations do not letterbox."""
    target = str(plan.get("target_aspect_ratio") or "")
    if target not in {"9:16", "16:9", "1:1", "4:5"}:
        return plan

    steps = plan.get("steps")
    if not isinstance(steps, list):
        return plan

    resize_by_input: dict[str, dict[str, Any]] = {}
    for step in steps:
        if not isinstance(step, dict) or step.get("action") != "resize_video":
            continue
        params = step.get("params") or {}
        video_path = params.get("video_path")
        if isinstance(video_path, str):
            resize_by_input[video_path] = params

    for step in steps:
        if not isinstance(step, dict) or step.get("action") != "merge_video":
            continue
        params = dict(step.get("params") or {})
        output_path = params.get("output_path")
        downstream_resize = (
            resize_by_input.get(output_path)
            if isinstance(output_path, str)
            else None
        )
        ratio = (
            str(downstream_resize.get("aspect_ratio") or target)
            if downstream_resize
            else target
        )
        if ratio not in {"9:16", "16:9", "1:1", "4:5"}:
            ratio = target
        params["aspect_ratio"] = ratio
        params["mode"] = (
            str(downstream_resize.get("mode") or "crop")
            if downstream_resize
            else "crop"
        )
        step["params"] = params
    return plan


# =============================================================
# 노드 본체
# =============================================================

def script_node(state: AgentState) -> dict[str, Any]:
    """script_plan 을 생성해서 state 에 박는다.

    재진입 시 (사용자 피드백 후): state["script_feedback"] 가 있으면
    이전 plan + 피드백을 user prompt 에 포함시켜 재생성.
    """
    started = time.monotonic()
    user_request = state.get("user_request", "")
    video_context = state.get("video_context")
    previous_plan = state.get("script_plan")
    feedback = state.get("script_feedback")
    revision = state.get("script_revision", 0)

    # 무한 재생성 방지
    if revision >= 5:
        logger.warning("script_revision >= 5, force end")
        return {
            "script_plan": {
                **(previous_plan or {}),
                "questions": ["plan 재생성이 5 회를 넘었습니다. 요청을 더 간단히 다시 주세요."],
            },
            "script_revision": revision,
        }

    # 긴 영상/다중 영상은 최초 호출부터 초압축 컨텍스트를 사용한다. 일반
    # 프롬프트가 deadline에 걸린 뒤 같은 크기의 요청을 반복하는 일을 막는다.
    scenes = video_context.get("scenes") if isinstance(video_context, dict) else []
    scene_count = len(scenes) if isinstance(scenes, list) else 0
    try:
        source_duration_sec = float(
            (video_context or {}).get("duration_sec")
            or (video_context or {}).get("duration")
            or 0
        )
    except (TypeError, ValueError):
        source_duration_sec = 0.0
    large_context = scene_count > 50 or source_duration_sec > 120

    # Script 전용 압축 프롬프트. Supervisor용 전체 문서를 중복 주입하지 않는다.
    sys_text = build_script_node_system_prompt(
        video_context=video_context,
        ultra_compact=large_context,
    )

    # user prompt
    user_parts: list[str] = [
        "# 사용자 요청",
        user_request,
    ]

    # 트렌드 사전조사 결과 (research_prepass 산출). 있으면 컨셉/BGM/페이싱을
    # 여기에 grounding — trend_elements / references 는 이걸로 채운다.
    trend_brief = state.get("trend_brief")
    if trend_brief:
        user_parts.append("\n# 트렌드 사전조사 (이걸 기획에 반영)")
        user_parts.append("```json")
        user_parts.append(json.dumps(trend_brief, ensure_ascii=False, indent=2))
        user_parts.append("```")
        user_parts.append(
            "위 트렌드를 concept/trend_elements/bgm_progression/pacing 에 반영하고, "
            "references 는 여기 자료로 채워라."
        )

    if state.get("video_paths"):
        user_parts.append("\n# 원본 영상")
        for p in state["video_paths"]:
            user_parts.append(f"- {p}")

    # 이전 turn 에서 만든 편집본이 있으면 새 요청은 그것을 소스로 삼는다.
    # (원본은 유지 · 편집본을 계속 파생시키는 흐름 — 사용자가 "그럼 자막도"
    #  같은 후속 요청을 하면 자동으로 편집본 위에서 이어짐)
    last_output = state.get("final_output_path")
    if last_output:
        user_parts.append("\n# 직전 편집 결과 (이번 요청의 실질 소스)")
        user_parts.append(f"- {last_output}")
        user_parts.append(
            "\n중요: 이번 요청은 위 편집본 위에서 이어서 편집한다. "
            "step 의 video_path 는 원본이 아니라 이 편집본 경로를 사용하라. "
            "다만 편집본 자체는 덮어쓰지 말고 새 파일로 저장 (예: `..._captioned.mp4`)."
        )
        # 이전 turn 의 편집 요약도 알려줌 (사용자가 후속 요청을 이해하기 쉽게).
        conv_summary = state.get("conversation_summary")
        if conv_summary:
            user_parts.append("\n# 이전 대화 요약")
            user_parts.append(conv_summary)

    if previous_plan and feedback:
        user_parts.append("\n# 이전 plan (사용자가 수정 요청)")
        user_parts.append("```json")
        user_parts.append(json.dumps(previous_plan, ensure_ascii=False, indent=2))
        user_parts.append("```")
        user_parts.append("\n# 사용자 피드백")
        user_parts.append(feedback)
        user_parts.append("\n이 피드백을 반영해서 *전체 plan 을 갱신* 해서 다시 출력하라.")

    user_text = "\n".join(user_parts)

    # LLM 호출 — 안정 prefix(sys_text)는 Gemini explicit cache 로 재사용해
    # 매 턴 ~20k prompt 토큰 반복 비용을 줄인다 (실패 시 자동 inline 폴백).
    # Script 노드는 아래에서 명시적으로 한 번만 축약 재시도한다. SDK 내부
    # 재시도까지 겹치면 한 요청이 수 분 동안 UI의 busy 상태를 점유한다.
    from agent.llm import system_user_invoke

    compact_attempted = False
    try:
        ai_msg = system_user_invoke(
            "script", sys_text, user_text,
            # 첫 시도가 90초에 걸려 타임아웃되면 아래 축약 재시도로 두 배 일한다
            # (실측 planning 252초 = 90초 타임아웃 + 재시도). 큰 storyboard 출력이
            # 90초를 넘기므로 첫 시도에 충분히 준다 → 대개 한 번에 끝남.
            temperature=0.1, max_retries=0, timeout=180,
        )
    except Exception as e:
        # 긴 프롬프트가 Gemini 서버 deadline에 걸리면 거버넌스/few-shot까지
        # 제외한 초압축 프롬프트로 한 번만 자동 복구한다. 실패를 questions로
        # 포장하면 0-step 승인 카드가 뜨므로 최종 실패는 chat 응답으로 종료한다.
        logger.warning("script LLM first attempt failed; retry compact: %s", e)
        compact_sys_text = build_script_node_system_prompt(
            video_context=video_context,
            ultra_compact=True,
        )
        compact_attempted = True
        try:
            retry_llm = make_llm(
                "script", max_retries=0, timeout=120, temperature=0.1
            )
            ai_msg = retry_llm.invoke(
                [
                    SystemMessage(content=compact_sys_text),
                    HumanMessage(content=user_text),
                ]
            )
        except Exception as retry_error:
            logger.exception("script LLM compact retry failed")
            return {
                "script_plan": {
                    **_parse_failure_plan(
                        f"{type(retry_error).__name__}: {retry_error}"
                    ),
                },
                "script_revision": revision + 1,
            }

    raw = _message_text(ai_msg.content)
    plan = _extract_json(raw)

    # A malformed/truncated response is much more common than an invoke
    # exception. Retry it once with the compact prompt and an explicit no-fence
    # JSON reminder instead of surfacing a zero-step approval card.
    if plan.get("_parse_error") and not compact_attempted:
        logger.warning("script JSON malformed; retry compact JSON generation")
        compact_sys_text = build_script_node_system_prompt(
            video_context=video_context,
            ultra_compact=True,
        )
        retry_user_text = (
            user_text
            + "\n\n# 출력 형식 재확인\n"
            + "설명이나 마크다운 코드펜스 없이, 완결된 JSON 객체 하나만 출력하라. "
            + "문자열 안의 줄바꿈은 \\n으로 이스케이프하고 마지막 항목 뒤 쉼표를 쓰지 마라."
        )
        try:
            retry_llm = make_llm(
                "script", max_retries=0, timeout=120, temperature=0.1
            )
            retry_msg = retry_llm.invoke([
                SystemMessage(content=compact_sys_text),
                HumanMessage(content=retry_user_text),
            ])
            raw = _message_text(retry_msg.content)
            plan = _extract_json(raw)
        except Exception as retry_error:
            logger.exception("script malformed-JSON retry failed")
            plan = _parse_failure_plan(
                f"{type(retry_error).__name__}: {retry_error}"
            )

    if plan.get("_parse_error"):
        plan = _parse_failure_plan(plan.get("_parse_error"))

    # 기본 필드 보강 (LLM 이 누락한 경우)
    plan.setdefault("steps", [])
    plan.setdefault("questions", [])
    plan.setdefault("target_format", "general")
    plan.setdefault("mode", "edit")
    plan = _enforce_requested_features(plan, user_request)
    plan = _constrain_cut_duration(plan, user_request, video_context)
    plan = _propagate_target_aspect_ratio(plan)
    # chat 모드인데 reply 가 없으면 edit 모드로 강등 (오분류 방어)
    if plan.get("mode") == "chat" and not str(plan.get("reply") or "").strip():
        plan["mode"] = "edit"

    # step_id 백필 — supervisor 의 완료 판정(_step_completed)이 step_id 기준이라
    # LLM 이 빠뜨리면 그 step 은 영영 "미완료"로 남아 매 재진입마다 재실행된다.
    steps = plan.get("steps")
    if isinstance(steps, list):
        for i, step in enumerate(steps, 1):
            if isinstance(step, dict) and not isinstance(step.get("step_id"), int):
                step["step_id"] = i

    duration = time.monotonic() - started
    logger.info(
        "script_node done: format=%s, steps=%d, questions=%d, %.2fs",
        plan.get("target_format"), len(plan.get("steps", [])),
        len(plan.get("questions", [])), duration,
    )

    return {
        "script_plan": plan,
        "script_revision": revision + 1,
        # feedback 은 한 번 쓰고 비움
        "script_feedback": None,
    }


# =============================================================
# 라우팅: interrupt 게이트로 갈지, supervisor 바로 갈지
# =============================================================

def should_interrupt_for_questions(state: AgentState) -> str:
    """script_node 이후 라우팅.

    - plan.mode == "chat" 이면 respond (편집 파이프라인 전체 스킵 — 대화 응답)
    - plan.questions 가 비어있고 사용자 승인 정책이 꺼져있으면 supervisor 로 바로
    - 그 외엔 interrupt 게이트로 (사용자 승인 / 수정 요청)

    Returns:
        "interrupt" | "supervisor" | "respond"
    """
    plan = state.get("script_plan") or {}

    if plan.get("mode") == "chat":
        return "respond"

    has_questions = bool(plan.get("questions"))
    gate_enabled = config.INTERRUPT_POLICY.gate_after_script

    if gate_enabled or has_questions:
        return "interrupt"
    return "supervisor"
