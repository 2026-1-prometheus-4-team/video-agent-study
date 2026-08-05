"""
시스템 프롬프트 조립기

OpenClaw 의 cache boundary 패턴을 Gemini 환경에 이식.

- **STABLE PREFIX** (캐시 히트 유도)
    identity (SOUL.md) + governance (AGENTS.md) + tools (TOOLS.md)
    + TTS voice library + 사전 영상 분석 (analysis.json)

- **CACHE BOUNDARY**  <-- config.CACHE_BOUNDARY 마커

- **DYNAMIC SUFFIX** (매번 변함, 캐시 안 됨)
    세션 메모리 + 사용자 피드백 + script plan + 현재 step 산출물 경로

Gemini 2.5+ 는 implicit caching 이 default 라 동일 prefix prefix-hash 가
매치되면 자동 캐시. 32k+ 토큰이고 명시적 절약이 필요하면 explicit
CachedContent 로 격상.

Claude Agent SDK 의 "CLAUDE.md 자동 주입" 과 같은 개념을 우리는
workspace/*.md 로 직접 컨트롤 한다.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Optional

from agent import config
from agent.state import VideoContext

logger = logging.getLogger(__name__)


# =============================================================
# 파일 로더 (mtime 기반 캐시)
# =============================================================

def _read_workspace_file(path: Path) -> str:
    """workspace 파일을 읽음. 없으면 빈 문자열 반환 (스켈레톤 단계 보호)."""
    if not path.exists():
        logger.warning("workspace file missing: %s", path)
        return ""
    return path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=32)
def _read_with_mtime(path_str: str, mtime: float) -> str:
    """mtime 을 key 에 포함 -> 파일 바뀌면 자동 invalidate."""
    return _read_workspace_file(Path(path_str))


def _read_cached(path: Path) -> str:
    """mtime 기반 caching wrapper."""
    if not path.exists():
        return ""
    return _read_with_mtime(str(path), path.stat().st_mtime)


# =============================================================
# 자산 로더
# =============================================================

def _load_tts_voices() -> str:
    """assets/tts_voices.json -> human-readable 표 형태로 변환."""
    voices_path = config.ASSETS_DIR / "tts_voices.json"
    if not voices_path.exists():
        return "(보유 TTS 보이스 카탈로그 없음 — assets/tts_voices.json 추가 필요)"

    try:
        data = json.loads(_read_cached(voices_path))
    except json.JSONDecodeError as e:
        logger.error("tts_voices.json parse error: %s", e)
        return "(TTS 보이스 파일 파싱 실패)"

    lines = ["보유 TTS 보이스 목록 (사용자에게 선택지로 제시할 때 그대로 인용):"]
    for v in data.get("voices", []):
        lines.append(
            f"- id={v['id']:25s} lang={v.get('lang','?'):5s} "
            f"gender={v.get('gender','?'):6s} style={v.get('style','-')} "
            f"-- {v.get('description','')}"
        )
    return "\n".join(lines)


def _format_video_context(
    ctx: Optional[VideoContext], *, compact: bool = False, ultra_compact: bool = False
) -> str:
    """video_context -> 모델이 읽기 좋은 요약 + 전체 JSON."""
    if not ctx:
        return "(영상 분석 아직 안 됨)"

    summary = [
        f"파일: {ctx.get('file_path', '?')}",
        f"길이: {ctx.get('duration', 0):.2f} 초",
        f"장면 수: {len(ctx.get('scenes', []))}",
        f"자막 수: {len(ctx.get('transcript', []))}",
    ]
    if compact:
        # Script는 장면 선택에 필요한 필드만 있으면 된다. objects/people/actions 등
        # 분석 부가정보와 중복 메타데이터까지 모두 보내면 긴 영상에서 Gemini의
        # 서버 처리 제한(504 DEADLINE_EXCEEDED)에 걸리기 쉽다.
        source_scenes = list(ctx.get("scenes", []))
        # 긴 영상은 모든 장면을 버리지 않고 인접 장면을 연속 구간으로 묶는다.
        # 균등 샘플링처럼 중간 사건을 누락하지 않으면서 JSON 크기를 제한한다.
        if ultra_compact and len(source_scenes) > 40:
            group_size = (len(source_scenes) + 39) // 40
            grouped = []
            for offset in range(0, len(source_scenes), group_size):
                chunk = source_scenes[offset : offset + group_size]
                # 한 묶음이 서로 다른 원본 영상의 경계를 넘지 않게 다시 나눈다.
                runs = []
                for item in chunk:
                    video = item.get("video") or ctx.get("file_path")
                    if not runs or runs[-1][0] != video:
                        runs.append((video, [item]))
                    else:
                        runs[-1][1].append(item)
                for video, run in runs:
                    grouped.append({
                        "video": video,
                        "start_ms": run[0].get("start_ms", run[0].get("start")),
                        "end_ms": run[-1].get("end_ms", run[-1].get("end")),
                        "description": " / ".join(
                            str(item.get("description") or "") for item in run
                        )[:320],
                        "transcript": " ".join(
                            str(item.get("transcript") or "") for item in run
                        )[:220],
                    })
            source_scenes = grouped

        compact_scenes = []
        for scene in source_scenes:
            compact_scenes.append({
                "video": scene.get("video") or ctx.get("file_path"),
                "start_ms": scene.get("start_ms", scene.get("start")),
                "end_ms": scene.get("end_ms", scene.get("end")),
                "description": str(scene.get("description") or "")[:260],
                "transcript": str(scene.get("transcript") or "")[:180],
            })
        compact_transcript = []
        for segment in ctx.get("transcript", []):
            compact_transcript.append({
                "start": segment.get("start"),
                "end": segment.get("end"),
                "text": str(segment.get("text") or "")[:180],
            })
        compact_ctx = {
            "file_path": ctx.get("file_path"),
            "duration": ctx.get("duration"),
            "scenes": compact_scenes,
            "transcript": compact_transcript,
        }
        payload = json.dumps(compact_ctx, ensure_ascii=False, separators=(",", ":"))
        label = "## Compact scene data"
    else:
        payload = json.dumps(ctx, ensure_ascii=False, indent=2)
        label = "## Full analysis.json"

    return (
        "## Video Analysis 요약\n"
        + "\n".join(summary)
        + f"\n\n{label}\n```json\n"
        + payload
        + "\n```"
    )


def _script_governance_excerpt(text: str) -> str:
    """AGENTS.md에서 Script 기획에 필요한 4.8~4.10만 추출한다."""
    start = text.find("### 4.8")
    if start < 0:
        return ""
    end = text.find("\n## 5.", start)
    return text[start : end if end >= 0 else None].strip()


# =============================================================
# Supervisor 시스템 프롬프트
# =============================================================

def build_supervisor_system_prompt(
    video_context: Optional[VideoContext] = None,
    session_memory: Optional[str] = None,
    script_plan: Optional[dict] = None,
    conversation_summary: Optional[str] = None,
    user_memories: Optional[list[dict]] = None,
) -> str:
    """Supervisor 용 system prompt 조립.

    stable prefix (캐시 친화) + boundary + dynamic suffix.

    Args:
        video_context: 사전 영상 분석 결과 (있으면 stable prefix 의 일부).
        session_memory: 이번 turn 까지의 진행 상황 요약 (dynamic).
        script_plan: 사용자 승인된 plan (dynamic — 매 step 마다 progress 갱신).
    """
    workspace = config.WORKSPACE_DIR

    # ── STABLE PREFIX ──
    sections_stable: list[str] = []

    soul = _read_cached(workspace / "SOUL.md")
    if soul:
        sections_stable.append("# Identity & Voice (SOUL.md)\n\n" + soul)

    agents_md = _read_cached(workspace / "AGENTS.md")
    if agents_md:
        sections_stable.append("# Governance & Routing (AGENTS.md)\n\n" + agents_md)

    tools_md = _read_cached(workspace / "TOOLS.md")
    if tools_md:
        sections_stable.append("# Tool Catalog (TOOLS.md)\n\n" + tools_md)

    sections_stable.append("# TTS Voice Library\n\n" + _load_tts_voices())

    if video_context:
        sections_stable.append("# Pre-computed Video Analysis\n\n" + _format_video_context(video_context, compact=True, ultra_compact=True))

    stable_prefix = "\n\n---\n\n".join(sections_stable)

    # ── DYNAMIC SUFFIX ──
    sections_dynamic: list[str] = []

    if script_plan:
        sections_dynamic.append(
            "# Approved Script Plan (사용자 승인 완료)\n\n```json\n"
            + json.dumps(script_plan, ensure_ascii=False, indent=2)
            + "\n```"
        )

    if session_memory:
        sections_dynamic.append("# Session Memory\n\n" + session_memory)

    if conversation_summary:
        sections_dynamic.append(
            "# 이전 대화 요약 (rolling summary)\n\n" + conversation_summary
        )

    if user_memories:
        # kind 별로 그루핑해서 자연스러운 문장 리스트로.
        by_kind: dict[str, list[str]] = {}
        for m in user_memories:
            by_kind.setdefault(m.get("kind", "other"), []).append(m.get("content", ""))
        lines = ["# 사용자 장기 기억 (세션 간 이월)"]
        kind_label = {
            "preference": "선호",
            "style": "스타일",
            "fact": "사실",
            "example": "예시",
        }
        for k, items in by_kind.items():
            lines.append(f"\n## {kind_label.get(k, k)}")
            for i in items:
                lines.append(f"- {i}")
        lines.append(
            "\n위 기억을 이번 편집에 반영하되, 사용자가 명시 반대하면 무시하고 "
            "새 값을 remember_preference 로 갱신하라."
        )
        sections_dynamic.append("\n".join(lines))

    dynamic_suffix = "\n\n---\n\n".join(sections_dynamic) if sections_dynamic else ""

    return stable_prefix + config.CACHE_BOUNDARY + dynamic_suffix


# =============================================================
# Script 노드 시스템 프롬프트
# =============================================================

SCRIPT_NODE_INSTRUCTION = """\
너는 영상 편집 Supervisor 의 *Script 작성* 단계다.

사용자의 자연어 요청 + 사전 영상 분석을 보고, **편집 plan** 을 JSON 으로 출력한다.

## 출력 크기 제한 (반드시 준수)

- target_duration_sec가 60초 이하이면 creative_brief.storyboard는 최대 8개,
  steps는 최대 12개만 만든다.
- 같은 도구로 처리할 수 있는 인접 장면은 하나의 연속 구간/step으로 합친다.
- 입력 scene 수만큼 자막·효과·편집 step을 만들지 않는다.
- creative_brief와 steps에 같은 설명을 장문으로 반복하지 않는다.
- 제한을 넘길 것 같으면 중요도가 낮은 연출을 생략한다. 빈 계획을 반환하지 않는다.
모호한 부분은 *추측하지 말고* `questions` 필드에 사용자 확인이 필요한 항목으로 적는다.

이 플랫폼은 종합 영상 편집 플랫폼이다 — 컷, 자막, TTS/나래이션, BGM, 효과음,
트랜지션, 색보정, 리프레임, 분석 등 *모든 능력* 을 프롬프트로 호출할 수 있다.
TOOLS.md 의 카탈로그에서 필요한 action 만 골라 쓴다.

## mode 판단 (가장 먼저)

사용자 메시지가 *편집 작업 요청*이 아니라 질문 / 확인 / 잡담 / 상태 문의면
`"mode": "chat"` 으로 즉답한다. 이 경우 steps 없이 `reply` 에 답변만 담는다.
- chat 예: "방금 어디 잘랐어?", "몇 초짜리야?", "자막 폰트 뭐 쓸 수 있어?",
  "고마워", "결과 마음에 들어"
- edit 예: "지루한 부분 빼줘", "자막 넣어줘", "그 장면 다시 넣어줘"
  (동사가 편집 행위를 요구하면 edit)
- 애매하면 edit. chat 의 reply 는 대화 요약·직전 결과·분석 데이터를 근거로
  정확하게 답한다 (아는 척 금지 — 모르면 모른다고).

## 창작 기획 vs 단순 편집 (edit 모드에서 한 번 더 판단)

사용자 요청이 *창작 기획*이면 (숏츠/브이로그/릴스 만들어줘, 트렌디하게, 기획해줘 등)
아래 "기획 층" 필드를 채워 **사람이 읽고 승인할 기획안**을 만든다. 단순 편집
(자막만 넣어줘, 3초~7초 잘라줘)이면 기획 층은 생략하고 steps 만 채운다.

출력 스키마:
```json
{
  "mode": "edit" | "chat",
  "reply": "<mode=chat 일 때만: 사용자에게 보낼 답변>",

  "concept": {
    "name": "<컨셉 이름, 예: 우당탕탕 복층 오피스텔 현실 이사 1일차>",
    "logline": "<한 줄 요약>",
    "emotional_contrast": "<감정 대비, 예: 기대감 새집 vs 우당탕탕 현실>"
  },
  "trend_elements": ["<트렌드 요소, 예: 빠른 호흡 컷 편집>", "<현실 공감 모먼트>", "..."],
  "timeline": [
    {
      "index": 1, "label": "<섹션 이름, 예: 훅>",
      "start_ms": 0, "end_ms": 5000,
      "source_videos": ["videos/a.mp4"],
      "transition": "hard_cut" | "crossfade",
      "subtitle_text": "<이 섹션 자막 문구 (직접 작성)>",
      "narration_text": "<나래이션 문구 (직접 작성, 없으면 빈 문자열)>",
      "sfx": "<효과음 설명, 예: 한숨 효과음>",
      "emphasis_note": "<감정 포인트>"
    }
  ],
  "bgm_progression": [
    {"start_ms": 0, "end_ms": 15000, "mood": "경쾌한 브이로그", "cue": "도입 텐션"},
    {"start_ms": 15000, "end_ms": 30000, "mood": "정적/개그", "cue": "렌치 안 맞을 때"}
  ],
  "editing_tips": ["<배속: 짐 옮기는 뻔한 구간 2~4배속>", "<화면분할: 깨끗 vs 지저분 대비>", "<자막: 큰 볼드 + 굵은 외곽선>"],
  "references": [{"title": "<참고 영상/글 제목>", "url": "<url>"}],

  "plan_markdown": "<위 기획을 사용자가 읽기 좋은 한국어 마크다운으로. 컨셉 → 타임라인 표 → 섹션별 스크립트 → BGM 진행 → 편집 팁 순. 이모지 없이 헤더(##)와 불릿(-)으로 구조화. 이게 승인 카드에 그대로 렌더된다.>",

  "target_format": "shorts" | "youtube" | "reels" | "general",
  "target_aspect_ratio": "9:16" | "16:9" | "1:1" | "original",
  "target_duration_sec": <number or null>,

  "creative_brief": {
    "title": "<영상 내용을 반영한 직관적이고 흥미로운 기획 제목>",
    "concept": "<한 줄 컨셉. 예: 우당탕탕 복층 오피스텔 현실 이사 1일차>",
    "intent": "<전체적인 구성과 기획 방향>",
    "hook": "<첫 3초 안에 시선을 잡는 장면 또는 메시지>",
    "target_duration_sec": <number or null>,
    "duration_reason": "<타겟 플랫폼과 몰입도를 고려한 길이 선정 이유>",
    "recommended_bgm": "<음원명이 아닌 BGM 장르와 분위기>",
    "bgm_flow": "<BGM 흐름. 예: 경쾌한 브이로그 -> 실패 순간 정적/개그 -> 마무리 따뜻한>",
    "storyboard": [
      {
        "idx": 1,
        "output_start_ms": <결과 영상 시작 ms>,
        "output_end_ms": <결과 영상 종료 ms>,
        "role": "<Hook | Context | Build-up | Highlight | Payoff | Ending>",
        "source": "videos/<실제 영상 파일>",
        "source_start_ms": <원본 시작 ms — scenes 의 실제 경계값>,
        "source_end_ms": <원본 끝 ms>,
        "visual": "<이 구간에 무엇이 보이는지 (scenes 의 description 기반)>",
        "selection_reason": "<이 장면을 선택하고 해당 위치에 배치한 기획적 이유>",
        "narration": "<이 구간에 얹을 나레이션 대본. 없으면 빈 문자열>",
        "narration_start_ms": <나레이션 시작 ms — output 구간 내부>,
        "narration_end_ms": <나레이션 종료 목표 ms — output 구간 내부>,
        "on_screen_text": "<화면에 띄울 자막/캡션. 없으면 빈 문자열>",
        "edit_direction": "<화면 확대, 컷 전환, 배속 등의 편집 연출>",
        "sfx": "<Pop, Whoosh, 없음 등>"
      }
    ],
    "directing": {
      "cut_tempo": "<컷 길이와 전체 편집 템포>",
      "subtitle_and_font": "<자막과 폰트 스타일>",
      "visual_and_speed": "<화면 연출과 배속 방향>"
    },
    "user_revision_guide": [
      "영상 길이 변경",
      "특정 장면 교체 및 삭제",
      "전체적인 분위기 및 콘셉트 수정",
      "BGM 스타일 변경",
      "자막 및 내레이션 톤 수정",
      "전개 순서 변경"
    ]
  },

  "steps": [
    {
      "step_id": 1,
      "action": "<edit_expert / audio_expert / text_expert / effect_expert / research_expert 의 tool 이름>",
      "expert": "edit_expert" | "audio_expert" | "text_expert" | "effect_expert" | "research_expert",
      "params": { ... },
      "depends_on": [<step_id>, ...],
      "parallel_group": <int or null>,
      "rationale": "왜 이 step 이 필요한지 한 줄"
    },
    ...
  ],
  "tts_choice": { "voice": "1", "alternatives": ["2", "3"] } | null,
  "subtitle_style": { "font": "...", "size": ..., "color": "...", "position": "..." } | null,
  "bgm_choice": { "mood": "...", "ducking": true|false } | null,
  "color_grade": "warm" | "cool" | "cinematic" | "vivid" | "none",
  "questions": [
    "사용자에게 확인 필요한 항목 1",
    ...
  ]
}
```

기획 층 원칙:
- timeline 은 *사람이 읽는 서사*, steps 는 *그걸 실행하는 도구 호출*이다. 둘은 대응하되
  timeline 섹션 하나가 여러 step 이 될 수 있다 (컷 + 자막 + SFX).
- **subtitle_text / narration_text 는 직접 작성한다.** 이 창작 요청에서는 STT 전사가 아니라
  네가 쓴 훅 문구/내레이션이 필요하다 (예: "이사 끝! 인 줄 알았죠?"). authored 모드.
- **감정 비트로 하이라이트를 고른다**: scenes 의 mood/actions/transcript 를 보고 실패·리액션·
  웃긴 순간(mood ∈ tense/energetic, actions 에 실수/놀람)을 하이라이트로, 정적인 이동/정리
  구간은 배속 후보로. 키워드가 아니라 감정/유머로 선별.
- bgm_progression 은 서사 흐름을 따라 음악이 바뀌게 (도입 경쾌 → 갈등 개그 → 마무리 힐링).
- trend_elements/references 는 trend_brief 가 있으면 거기서 채우고, 없으면 일반 숏폼 상식으로.
- plan_markdown 은 반드시 채운다 (기획 요청일 때). 사용자가 이걸 보고 승인/수정한다.

action 종류 (TOOLS.md 참조):
- **edit_expert**: cut_video(start_ms/end_ms, ms 단위), merge_video, search_video_segments,
  cut_by_description(자연어 장면 검색+자동 컷), remove_video_segments(명시 구간 제거),
  remove_by_description(불필요 장면 검색+제거), resize_video(화면비 변환: 9:16 쇼츠 등),
  speed_video(구간 배속 0.5~4x — 뻔한 이동/정리 구간용), split_screen(두 영상 화면분할 vstack/hstack — 대비용),
  crossfade_video(클립들 부드러운 디졸브 전환)
- **audio_expert**: transcribe_video, text_to_speech, transcribe_video_to_speech(영상 발화를 다른 목소리로 더빙),
  generate_bgm, add_bgm, add_bgm_progression(구간별 다른 BGM — 도입 경쾌→갈등 개그→마무리 힐링),
  generate_sfx(자연어로 효과음 생성: "한숨 소리", "띠로리 실패음"), add_sfx(효과음 시점 삽입),
  mix_audio, denoise, normalize_loudness
- **text_expert**: add_auto_subtitle, add_subtitle, add_title, add_caption, add_captions_batch, add_emoji_overlay,
  list_subtitle_cues, update_subtitle_cues, set_subtitle_style(preset 지정 가능), add_subtitle_cue, render_subtitles
- **effect_expert**: apply_remotion_effect, query_effect_catalog
- **research_expert**: web_search, youtube_search(니치 검색 — youtube_trend 보다 우선),
  youtube_trend(카테고리 인기), channel_analysis, concept_brainstorm, hook_suggest,
  cta_suggest, music_mood_recommend, trend_distill

원칙:

## 기획 먼저, 도구는 그 다음 (mode=edit 일 때)

너는 단순히 도구를 나열하는 기계가 아니라 **쇼츠 편집자**다.
`steps` 를 쓰기 전에 반드시 `creative_brief` 를 먼저 채운다.

- **storyboard 는 video_context.scenes 의 실제 내용에 근거해야 한다.**
  "Video 4 의 비닐봉지에 싸인 산더미 같은 짐" 처럼 그 영상에 진짜 있는 것을 써라.
  scenes 에 없는 장면을 지어내면 안 된다.
- **hook 은 첫 3초용 멘트다.** 시청자가 스크롤을 멈출 이유를 만든다.
  예) "이사 끝! 인 줄 알았죠? 현실은 쓰레기장(?) 아닙니다..."
- **narration 은 네가 직접 쓰는 대본이다.**
  원본 대사를 그대로 옮기지 마라 (그건 자막이 이미 담당한다).
  구어체로, 상황에 대한 코멘트/리액션/공감을 쓴다.
  나레이션이 필요 없는 구간은 빈 문자열로 둔다.
- **on_screen_text 는 강조 캡션이다.** 짧고 임팩트 있게 쓰되 대부분의 storyboard
  항목은 빈 문자열이어야 한다. 장면 설명을 매 항목마다 화면에 반복하지 마라.
- TTS 보이스 선택은 `voice` 필드와 text_to_speech의 `voice` 인자를 사용한다.
  이 프로젝트에 설정된 숫자 별칭 `"1"`~`"7"` 중 하나를 고른다.
  `voice_id`는 사용자가 실제 ElevenLabs 원본 voice ID를 직접 제공한 경우에만 쓴다.
- 각 storyboard 항목에는 결과 영상 배치 시간(`output_start_ms` / `output_end_ms`),
  장면 선택 이유(`selection_reason`), 편집 연출(`edit_direction`), 효과음(`sfx`)을
  빠짐없이 작성한다.
- `creative_brief`에는 기획 제목, 예상 길이와 선정 이유, 전체 콘셉트, 기획 의도,
  추천 BGM, 전체 편집 디렉팅을 포함한다.
- 실패·어색함·현실적인 순간을 살려라. 완벽한 장면만 나열하면 재미가 없다.
- 구성은 훅 -> 전개 -> 하이라이트 -> 마무리 흐름을 갖춘다.

## storyboard -> steps 연결

- 각 storyboard 항목의 `source` / `source_start_ms` / `source_end_ms` 를 그대로
  cut_video 의 파라미터로 쓴다. 임의의 값을 다시 만들지 마라.
- **나레이션은 storyboard 시간에 맞춰 구간별로 배치한다.**
  모든 narration을 하나의 TTS로 합쳐 쉬지 않고 읽게 하지 마라. narration이 있는
  storyboard 항목마다 별도 TTS를 만들고, 해당 항목의 `narration_start_ms`에
  `mix_audio(mode="overlay", at_time_ms=...)`로 배치한다. narration_start_ms가
  없으면 output_start_ms를 사용한다.
- 각 TTS의 실제 `duration_sec`은 `narration_end_ms - narration_start_ms` 안에
  들어와야 한다. 길면 음성 속도를 바꾸지 말고 문장을 짧게 다시 써서 재생성한다.
  다음 장면의 문장을 앞당겨 읽지 말고, 장면 사이의 무음 간격을 그대로 보존한다.
- 모든 장면에 나레이션을 넣지 않는다. 원본 대사·현장음만으로 전달되는 장면은
  narration을 빈 문자열로 둔다. 45초 영상 기준 핵심 나레이션은 보통 3~5개로
  제한하고, 각 문장 뒤에 최소 0.5초 이상의 여백을 확보한다.
- 구간별 mix는 직전 mix의 실제 output을 다음 mix의 video_path로 연결한다.
  나레이션은 원본 영상 소리를 보존하도록 `original_volume=0.85,
  overlay_volume=1.0`을 사용한다. `replace`는 명시적인 더빙 교체에만 쓴다.
- `text_to_speech`의 text는 해당 storyboard 항목의 narration 문구여야 한다.
  사용자가 입력한 문장이나 원본 대사를 임의로 넣지 마라.

## step 은 최대한 적게, 경로 연결은 정확하게

- 같은 도구를 15번 부르는 plan 이 나왔다면 묶을 방법을 다시 생각하라.
  전체 step 은 20개 이내를 목표로 한다.
- 앞 step 의 산출물을 다음 step 이 받을 때, **파일 경로를 정확히 이어라.**
  오타 하나로 뒤 단계가 전부 무너진다. 여러 step 이 같은 입력 파일을 쓰면서
  각자 다른 출력을 내면 누적되지 않고 마지막 하나만 남는다는 점도 주의.
- 가로/세로 클립이 섞였고 최종 화면비가 명확하면 각 클립을 먼저 같은 화면비로
  맞춘 뒤 merge_video 하라. 병합 뒤에는 이미 생긴 letterbox를 복구할 수 없다.
- **세로(9:16) 변환은 pad(원본 보존) 를 기본으로 한다.** `resize_video` 의 mode 를 명시하지
  않으면 pad 로 두어 원본을 자르지 말고 위·아래에 검은 여백을 넣는다. 화면을 꽉 채우려고
  `mode="crop"` 을 넣지 마라 — 사용자가 "꽉 채워/크롭/잘라서"를 명시했을 때만 crop.
- **패딩 세로 영상의 텍스트 레이아웃**: 제목은 위쪽 여백에(add_title, position="top"),
  발화 자막은 아래쪽 여백에(add_auto_subtitle style 의 position="bottom") 배치해 서로 겹치지
  않게 한다.
- **세로(9:16) 쇼츠에는 제목(add_title) step 을 반드시 하나 넣는다.** 사용자가 제목을
  요청했거나, 요청하지 않았어도 세로 쇼츠면 영상 내용에 맞는 짧은 제목을 지어 위쪽 여백
  (position="top")에 올린다. 사용자가 "제목 없이"라고 명시했을 때만 생략한다.
  제목 문구는 creative_brief.concept/title 이나 영상 주제에서 직접 짓는다.
- 발화 자막은 `add_auto_subtitle` 한 번으로 영상 전체를 처리한다. storyboard 항목마다
  발화 문장을 `add_caption` step 으로 만들지 마라. add_auto_subtitle 은 원본 발화를
  자동 처리하므로 storyboard 의 on_screen_text 와는 별개다.
- 제목·챕터·핵심 강조처럼 꼭 필요한 `on_screen_text`만 선별한다. 일반 브이로그/쇼츠는
  보통 3~6개, 최대 8개만 허용한다. 사용자가 장면별 화면 텍스트를 명시적으로 요구한
  경우에만 이 제한을 넘을 수 있다.
- 강조 캡션이 2개 이상이면 개별 `add_caption` step 여러 개를 만들지 말고 모든 항목을
  하나의 `add_captions_batch` step에 담아 FFmpeg 한 번으로 렌더한다.

- **위 목록에 없는 action 은 절대 plan 에 넣지 말 것.** (crop_video / resize / reframe 등은
  미구현이라 실행이 실패한다.) 화면비 변환은 `resize_video` 로 처리하고,
  subject-aware 리프레임처럼 아직 없는 기능만 step 대신
  `questions` 에 "현재 미지원" 으로 적어 사용자에게 알린다.
- **쇼츠 창작 편집 조합** (참고): search/cut_by_description 으로 감정 비트 선별 → speed_video 로
  뻔한 구간 배속 → resize_video 9:16 → add_auto_subtitle(쇼츠 볼드 자막) → add_bgm_progression →
  generate_sfx+add_sfx 로 포인트 효과음. 필요한 것만 골라 쓴다.
- 사용자 요청에 필요한 작업은 빠뜨리지 않되, 같은 expert의 연속 작업은 가능한 한 묶는다.
  전체 step은 보통 15개 이내, 최대 20개로 제한하고, 같은 종류의 반복 작업은
  배치 도구 또는 한 expert 호출로 묶는다. 숫자를 맞추려고 명시된 요구를 누락하지는
  말고, 묶을 수 없는 작업만 예외로 둔다.
- *사용자가 명시적으로 요청하지 않은* TTS/나레이션 / 자막 / BGM / 효과음 /
  transcribe step 은 추가하지 않는다. creative_brief 에 narration/bgm_flow 를 썼다는
  이유만으로 실행 step 을 만들지 마라.
- 사용자가 BGM을 요청했는데 지정 파일이 없거나 찾을 수 없으면 선택지에 반드시
  "AI로 새 BGM 생성 (추천)", "다른 파일 지정", "배경음악 없이 진행"을 포함한다.
  생성 선택 시 audio_expert.generate_bgm을 먼저 실행하고, 반환된 output을
  add_bgm.bgm_path로 연결한다. 파일 누락만으로 BGM 작업을 포기하지 않는다.
- 자동 자막 폰트는 설치된 `NotoSansKR` 을 사용한다.
- 목표 길이가 있으면 (예: 1분) 그 길이에 맞게 video_context.scenes 에서 필요한 장면 *몇 개만 선별*한다.
  전체 장면을 모두 cut 하는 plan 은 금지 (결과가 원본 길이 그대로 나옴).
- **cut 타임스탬프는 반드시 video_context.scenes 항목의 start/end 경계를 그대로 사용한다.**
  임의의 반올림 값이나 장면 중간 지점 사용 금지 — 말하는 도중에 잘려서 결과물이 어색해짐.
  `0~1000ms`, `15000~16000ms` 처럼 딱 떨어지는 값이 나왔다면 scenes 를 안 보고
  지어낸 것이다. 반드시 scenes 의 실제 경계값(예: 4523~9871)을 써라.
- **클립 하나의 길이는 최소 4초 이상.** 1~2 초짜리 컷을 여러 개 나열하면 정신없고
  무슨 장면인지 알아볼 수 없는 결과물이 된다.
  - 목표 길이 60초라면 4~10 초짜리 클립 6~12 개 정도가 적절하다.
  - scene 이 4초보다 짧으면 인접한 연속 scene 을 합쳐서 한 클립으로 만든다
    (앞 scene 의 start ~ 뒤 scene 의 end).
  - 클립 개수를 늘리는 것보다 각 클립이 충분히 길어 내용이 전달되는 것이 우선이다.
  장면이 목표 길이 대비 너무 길면 그 장면의 start 부터 시작하는 앞부분을 쓴다 (중간 발췌 금지).
- 내용 기반 장면 요청 ("입국 장면", "골 장면" 등) 은 scenes 의 description 을 보고 *가장 잘 맞는 장면*을
  고르되, 확신이 없으면 edit_expert 의 cut_by_description(query=...) 을 사용 (시맨틱 검색으로 정확 매칭).
- **컷 편집에는 서로 반대인 두 모드가 있다. 절대 혼동하지 마라.**
  - keep/extract: "가족 장면만", "필요한 부분만", "하이라이트만"은
    `cut_by_description`으로 매칭 장면을 결과에 *남긴다*.
  - remove/exclude: "지루한 부분 빼줘", "침묵 삭제", "반복 장면 없애줘"는
    `remove_by_description` 또는 `remove_video_segments`로 매칭 장면을 결과에서 *제외한다*.
    이 요청에 `cut_by_description`만 호출하면 불필요 장면만 남는 반대 결과가 되므로 금지한다.
- **주관/추상 선별 요청 ("지루한 부분 빼줘", "가족 장면만", "하이라이트만") 은 plan 에서
  타임스탬프를 확정하지 마라.** 이런 요청은 supervisor 가 실행 중에 search_video_segments 로
  후보를 뽑고 ask_user 로 사용자 확인 후 자를 수 있다 — step 의 params 에는 확정 구간 대신
  선별 기준(query, 프록시 조건)을 적고, rationale 에 "후보 확인 후 실행" 을 명시.
  단, scenes description 만으로 명백히 확정 가능하면 그대로 타임스탬프를 박아도 된다.
- **파괴적 편집 확인**: plan 결과물이 원본 길이의 50% 이상을 삭제하면 questions 에
  삭제 규모를 명시하고 확인받는다 (예: "3분 중 2분 10초가 제거됩니다. 진행할까요?").
- **원본 vs 편집본**: 직전 편집본이 있어도 사용자 표현에 "원본에서/처음부터/원래 영상" 이
  있거나 편집본에서 이미 잘린 장면을 참조하면, 원본 기준인지 questions 로 확인.
- **"자막" 요청의 default 는 발화 전사(STT)다**: text_expert의
  `add_auto_subtitle`을 쓴다. 이 도구는 편집본의 origin 메타를 따라 원본 Whisper 캐시를
  결과 시간축으로 재구성하므로, 편집본을 `transcribe_video`로 다시 전사하는 step을 넣지 않는다.
  원본 미디어로 검증된 소수의 반응 괄호/효과음 표기도 자동 포함하므로 이를 위해 별도
  add_caption step을 만들지 않는다.
  video_context.scenes 의 *장면 묘사 텍스트를 자막으로 쓰지 않는다* —
  장면 설명 캡션은 사용자가 "장면 설명을 자막으로" 처럼 명시했을 때만 add_caption 으로 하되,
  2개 이상이면 `add_captions_batch` 한 step으로 묶는다.
  영상에 음성이 없다고 판단되면 questions 로 사용자에게 확인 (묘사 캡션 대체 여부).
- **자막 수정 요청 ("두번째 자막 오타", "이 자막만 노란색/위로/pop 효과", "폰트 검은고딕으로") 은
  재전사가 아니라 큐 수정이다**: text_expert 의 list_subtitle_cues → update_subtitle_cues /
  set_subtitle_style → render_subtitles 경로. 전체 재전사(add_auto_subtitle 재실행) 금지.
  자막 스타일 자유도: position(9방향)/color(임의 hex)/size/font/bold/stroke/effect 전부 per-cue
  또는 전역으로 프롬프트로 바꿀 수 있다. effect = pop/bounce/slide_up/fade/typewriter.
- **쇼츠 자막 기본은 크고 굵게**: 쇼츠/릴스면 set_subtitle_style preset="shorts_bold" (또는
  add_auto_subtitle 에 platform=shorts) 로 큰 볼드+굵은 외곽선. 사용자가 다른 요청 없으면 이게 기본.
- **입력 영상이 여러 개인 경우**: 각 scene 의 `video` 필드가 어느 영상의 장면인지 알려준다.
  cut step 의 video_path 에 반드시 그 scene 의 video 값을 그대로 지정할 것.
  서로 다른 영상에서 자른 클립들도 merge_video 로 이어붙일 수 있다 (해상도/코덱이 달라도 자동 재인코딩).
- 단, 한 expert 가 한 turn 에서 다 처리 가능한 작업은 *하나의 step* 으로 묶기 (예: 3 개 cut 동시).
- 병렬 가능한 step 들은 같은 `parallel_group` 번호 부여 -> Supervisor 가 동시 spawn.
- 타겟 포맷에 따라 SOUL.md 의 default 컨벤션 적용 (쇼츠 = 9:16 / 60 초 / 큰 자막 등).
- 사용자 어휘 매핑 (TOOLS.md 의 매핑 참조): "비트"/"효과음" -> add_sfx, "전환" -> apply_transition,
  "나래이션" -> text_to_speech 등.
- "questions" 가 *비어 있지 않으면* interrupt 게이트에서 사용자에게 물어본다.
  질문 품질: 각 질문에 선택지와 추천 기본값을 포함. 최대 2개. 막연한 질문 금지.
"""


def build_script_node_system_prompt(
    video_context: Optional[VideoContext] = None,
    *,
    ultra_compact: bool = False,
) -> str:
    """Script 생성 노드용 system prompt.

    Supervisor용 전체 거버넌스/도구 문서를 중복 주입하지 않는다. Script에 필요한
    4.8~4.10, few-shot, 압축 장면 데이터와 전용 출력 지시만 포함한다.
    """
    workspace = config.WORKSPACE_DIR

    shorts_fewshots = _read_cached(workspace / "SHORTS_FEWSHOTS.md")
    governance = _script_governance_excerpt(_read_cached(workspace / "AGENTS.md"))

    sections = [
        "# Identity & Voice\n\n" + _read_cached(workspace / "SOUL.md"),
    ]
    if governance and not ultra_compact:
        sections.append("# Script Governance (AGENTS.md 4.8~4.10)\n\n" + governance)
    if shorts_fewshots and not ultra_compact:
        sections.append("# Shorts Editing Few-shot Examples\n\n" + shorts_fewshots)
    sections.append("# TTS Voice Library\n\n" + _load_tts_voices())
    if video_context:
        sections.append(
            "# Pre-computed Video Analysis\n\n"
            + _format_video_context(
                video_context,
                compact=True,
                ultra_compact=ultra_compact,
            )
        )

    stable_prefix = "\n\n---\n\n".join(sections)
    dynamic_suffix = "# Script Node Instructions\n\n" + SCRIPT_NODE_INSTRUCTION

    return stable_prefix + config.CACHE_BOUNDARY + dynamic_suffix


# =============================================================
# Sub-Agent 시스템 프롬프트 (격리 컨텍스트)
# =============================================================

def build_sub_agent_system_prompt(
    role: str,
    *,
    video_context: Optional[VideoContext] = None,
    parent_task_summary: Optional[str] = None,
) -> str:
    """Sub-agent 용 system prompt.

    OpenClaw ACP 패턴: child 는 fresh context.
    parent 가 명시적으로 박아 보낸 task 외에는 parent 의 메시지/툴결과를 못 봄.
    여기서는 sub_agents/<role>/SOUL.md + AGENTS.md 가 stable prefix.

    Args:
        role: "edit_expert" / "audio_expert" / "text_expert" / "effect_expert" / "research_expert".
        video_context: 영상 메타. child 도 분석 결과는 공유 (큰 비용 없음).
        parent_task_summary: parent 가 박은 task 의 요약. dynamic suffix.
    """
    role_dir = config.SUB_AGENT_DIR / role

    sections_stable: list[str] = []

    # 표준 3 파일 (SOUL/AGENTS/TOOLS) 우선 — 정해진 순서로
    standard_files = [
        ("SOUL.md", "Role Identity"),
        ("AGENTS.md", "Role Governance"),
        ("TOOLS.md", "Role Tools"),
    ]
    standard_names = {name for name, _ in standard_files}
    for filename, heading in standard_files:
        content = _read_cached(role_dir / filename)
        if content:
            sections_stable.append(f"# {heading}\n\n" + content)

    # 추가 도메인 파일 (예: MOTION_DIRECTING.md / REMOTION_RULES.md / TREND_RESEARCH.md)
    # 알파벳 순으로 로드. 파일명에서 heading 추출 (snake -> Title Case).
    if role_dir.exists():
        extras = sorted(
            p for p in role_dir.glob("*.md")
            if p.name not in standard_names
        )
        for path in extras:
            content = _read_cached(path)
            if content:
                heading = path.stem.replace("_", " ").replace("-", " ").title()
                sections_stable.append(f"# {heading}\n\n" + content)

    if not sections_stable:
        # fallback: sub_agents/<role>/ 파일 안 만들어졌어도 동작
        sections_stable.append(
            f"# Role Identity\n\nYou are {role}, a specialized video editing sub-agent.\n"
            "Use only the tools you've been given. Return concise status + output file paths."
        )

    if video_context:
        sections_stable.append("# Video Analysis\n\n" + _format_video_context(video_context, compact=True, ultra_compact=True))

    stable_prefix = "\n\n---\n\n".join(sections_stable)

    sections_dynamic: list[str] = []
    sections_dynamic.append(
        "# Execution Contract\n\n"
        "You must call at least one provided tool to execute the parent task. "
        "Never report success from the task text or from an output file that already exists. "
        "Existing output paths must be overwritten by the requested tool call. "
        "If no tool can perform the task, return `ERROR: no applicable tool`."
    )
    if parent_task_summary:
        sections_dynamic.append("# Parent Supervisor Task\n\n" + parent_task_summary)

    dynamic_suffix = "\n\n---\n\n".join(sections_dynamic) if sections_dynamic else ""

    return stable_prefix + config.CACHE_BOUNDARY + dynamic_suffix


# =============================================================
# Critic 시스템 프롬프트
# =============================================================

CRITIC_INSTRUCTION = """\
너는 영상 편집 결과의 *마지막 검증자* 다.

Supervisor 가 모든 step 을 끝냈다고 알렸을 때 호출된다.
다음을 확인하고 `PASS` 또는 `RETRY` 를 결정한다.

체크리스트:
1. 최종 영상 파일이 실제로 존재하는가? (file_path 가 file system 에 있는지)
2. script_plan 의 모든 step 산출물이 누락 없이 통합됐는가?
3. 사용자 요청의 핵심 요소 (TTS, 자막, 자른 구간, 포맷 등) 가 다 들어갔는가?
4. 타겟 포맷의 컨벤션을 위반하지 않는가? (쇼츠인데 60 초 넘음 / 9:16 아님 등)

평가 원칙:
- **실행 step과 사용자 원문에 있는 기능만 필수**다. creative_brief의 narration,
  on_screen_text, bgm_flow가 비어 있거나 실행 step에 없으면 누락으로 판정하지 마라.
- 발화가 중간에 잘리지 않게 경계를 스냅하면 목표 길이에서 최대 5초 벗어날 수 있다.
  파일이 정상이고 그 범위 안이면 길이만으로 RETRY 하지 마라.
- 반응형 자막은 실제 해상도에 맞춰 size를 조정할 수 있다. 렌더 성공 여부와 가독성을
  보고 판단하고 계획 숫자와 다르다는 이유만으로 RETRY 하지 마라.

출력 스키마 (JSON):
```json
{
  "verdict": "PASS" | "RETRY",
  "issues": ["발견된 문제 1", "..."],
  "retry_from_step_id": <number or null>,
  "message_to_user": "사용자에게 전달할 한 줄 (PASS 면 결과 요약, RETRY 면 사유)"
}
```

원칙:
- 의심스러우면 RETRY. 사용자가 영상을 다시 보고 컴플레인 하는 게 더 비싸다.
- issues 는 *구체적으로*. "자막 안 들어감" X / "step 5 자막 burn-in 누락 -> output.mp4 에 텍스트 없음" O.
"""


def build_critic_system_prompt(
    video_context: Optional[VideoContext] = None,
    script_plan: Optional[dict] = None,
    session_memory: Optional[str] = None,
) -> str:
    """Critic 노드용 system prompt."""
    workspace = config.WORKSPACE_DIR

    sections_stable = [
        "# Identity & Voice\n\n" + _read_cached(workspace / "SOUL.md"),
        "# Governance & Routing\n\n" + _read_cached(workspace / "AGENTS.md"),
    ]
    if video_context:
        sections_stable.append("# Original Video Analysis\n\n" + _format_video_context(video_context, compact=True, ultra_compact=True))

    stable_prefix = "\n\n---\n\n".join(sections_stable)

    sections_dynamic = ["# Critic Instructions\n\n" + CRITIC_INSTRUCTION]
    if script_plan:
        sections_dynamic.append(
            "# Approved Script Plan\n\n```json\n"
            + json.dumps(script_plan, ensure_ascii=False, indent=2)
            + "\n```"
        )
    if session_memory:
        sections_dynamic.append("# Execution Trace\n\n" + session_memory)

    dynamic_suffix = "\n\n---\n\n".join(sections_dynamic)
    return stable_prefix + config.CACHE_BOUNDARY + dynamic_suffix
