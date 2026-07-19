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


def _format_video_context(ctx: Optional[VideoContext]) -> str:
    """video_context -> 모델이 읽기 좋은 요약 + 전체 JSON."""
    if not ctx:
        return "(영상 분석 아직 안 됨)"

    summary = [
        f"파일: {ctx.get('file_path', '?')}",
        f"길이: {ctx.get('duration', 0):.2f} 초",
        f"장면 수: {len(ctx.get('scenes', []))}",
        f"자막 수: {len(ctx.get('transcript', []))}",
    ]
    return (
        "## Video Analysis 요약\n"
        + "\n".join(summary)
        + "\n\n## Full analysis.json\n```json\n"
        + json.dumps(ctx, ensure_ascii=False, indent=2)
        + "\n```"
    )


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
        sections_stable.append("# Pre-computed Video Analysis\n\n" + _format_video_context(video_context))

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

출력 스키마:
```json
{
  "mode": "edit" | "chat",
  "reply": "<mode=chat 일 때만: 사용자에게 보낼 답변>",
  "target_format": "shorts" | "youtube" | "reels" | "general",
  "target_aspect_ratio": "9:16" | "16:9" | "1:1" | "original",
  "target_duration_sec": <number or null>,
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
  "tts_choice": { "voice_id": "...", "alternatives": ["...", "..."] } | null,
  "subtitle_style": { "font": "...", "size": ..., "color": "...", "position": "..." } | null,
  "bgm_choice": { "mood": "...", "ducking": true|false } | null,
  "color_grade": "warm" | "cool" | "cinematic" | "vivid" | "none",
  "questions": [
    "사용자에게 확인 필요한 항목 1",
    ...
  ]
}
```

action 종류 (TOOLS.md 참조):
- **edit_expert**: cut_video(start_ms/end_ms, ms 단위), merge_video, search_video_segments, cut_by_description(자연어 장면 검색+자동 컷), resize_video(화면비 변환: 9:16 쇼츠 등)
- **audio_expert**: transcribe_video, text_to_speech, add_bgm, add_sfx, mix_audio, denoise, normalize_loudness
- **text_expert**: add_subtitle, add_auto_subtitle, add_title, add_caption, add_emoji_overlay
- **effect_expert**: apply_remotion_effect, query_effect_catalog
- **research_expert**: web_search, youtube_trend

원칙:
- **위 목록에 없는 action 은 절대 plan 에 넣지 말 것.** (crop_video / resize / reframe 등은
  미구현이라 실행이 실패한다.) 화면비 변환·속도 조절 등이 필요하면 step 대신
  `questions` 에 "현재 미지원" 으로 적어 사용자에게 알린다.
- step 수 제한 없음. 사용자 요청에 필요한 모든 작업 다 plan 에 박는다.
- *사용자가 명시적으로 요청하지 않은* 자막 / BGM / 효과음 / transcribe step 은 추가하지 않는다.
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
- **주관/추상 선별 요청 ("지루한 부분 빼줘", "가족 장면만", "하이라이트만") 은 plan 에서
  타임스탬프를 확정하지 마라.** 이런 요청은 supervisor 가 실행 중에 search_video_segments 로
  후보를 뽑고 ask_user 로 사용자 확인 후 자를 수 있다 — step 의 params 에는 확정 구간 대신
  선별 기준(query, 프록시 조건)을 적고, rationale 에 "후보 확인 후 실행" 을 명시.
  단, scenes description 만으로 명백히 확정 가능하면 그대로 타임스탬프를 박아도 된다.
- **파괴적 편집 확인**: plan 결과물이 원본 길이의 50% 이상을 삭제하면 questions 에
  삭제 규모를 명시하고 확인받는다 (예: "3분 중 2분 10초가 제거됩니다. 진행할까요?").
- **원본 vs 편집본**: 직전 편집본이 있어도 사용자 표현에 "원본에서/처음부터/원래 영상" 이
  있거나 편집본에서 이미 잘린 장면을 참조하면, 원본 기준인지 questions 로 확인.
- **"자막" 요청의 default 는 발화 전사(STT)다**: audio_expert transcribe_video → text_expert
  add_auto_subtitle 경로를 쓴다. video_context.scenes 의 *장면 묘사 텍스트를 자막으로 쓰지 않는다* —
  장면 설명 캡션은 사용자가 "장면 설명을 자막으로" 처럼 명시했을 때만 add_caption 으로.
  영상에 음성이 없다고 판단되면 questions 로 사용자에게 확인 (묘사 캡션 대체 여부).
- **자막 수정 요청 ("두번째 자막 오타", "이 자막만 노란색", "자막 전부 위로") 은 재전사가 아니라
  큐 수정이다**: text_expert 의 list_subtitle_cues → update_subtitle_cues / set_subtitle_style →
  render_subtitles 경로. 전체 재전사(add_auto_subtitle 재실행) 금지 — 기존 수정이 다 날아간다.
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
) -> str:
    """Script 생성 노드용 system prompt."""
    workspace = config.WORKSPACE_DIR

    sections = [
        "# Identity & Voice\n\n" + _read_cached(workspace / "SOUL.md"),
        "# Governance & Routing\n\n" + _read_cached(workspace / "AGENTS.md"),
        "# Tool Catalog\n\n" + _read_cached(workspace / "TOOLS.md"),
        "# TTS Voice Library\n\n" + _load_tts_voices(),
    ]
    if video_context:
        sections.append("# Pre-computed Video Analysis\n\n" + _format_video_context(video_context))

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
        sections_stable.append("# Video Analysis\n\n" + _format_video_context(video_context))

    stable_prefix = "\n\n---\n\n".join(sections_stable)

    sections_dynamic: list[str] = []
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
        sections_stable.append("# Original Video Analysis\n\n" + _format_video_context(video_context))

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
