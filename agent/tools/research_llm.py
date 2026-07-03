"""
Research expert — LLM-only tools.

외부 API 없이 *Gemini 호출만으로* 작동하는 기획 도구.
- concept_brainstorm
- storyboard_from_concept
- hook_suggest
- cta_suggest
- music_mood_recommend

system prompt 는 research_expert 의 CONCEPT_PATTERNS.md / HOOKS_LIBRARY.md / TREND_RESEARCH.md
가 이미 sub-agent stable prefix 에 들어가 있으므로, tool 안에서 *간결한 user prompt* 만 박으면
양질 출력 나옴 (캐시 친화).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool

from agent.llm import make_llm

logger = logging.getLogger(__name__)


# =============================================================
# JSON 추출 헬퍼
# =============================================================

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


def _llm_json(system: str, user: str, *, role: str = "sub_agent") -> dict | list:
    """LLM 호출 + JSON 추출 + 에러 처리."""
    llm = make_llm(role)
    try:
        ai = llm.invoke([SystemMessage(content=system), HumanMessage(content=user)])
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}

    raw = ai.content
    if isinstance(raw, list):
        raw = " ".join((p.get("text", "") if isinstance(p, dict) else str(p)) for p in raw)
    raw = str(raw)

    m = _JSON_BLOCK.search(raw)
    payload = m.group(1) if m else raw
    if not m:
        # bracket span fallback
        start = min((i for i in [payload.find("{"), payload.find("[")] if i != -1), default=-1)
        end = max(payload.rfind("}"), payload.rfind("]"))
        if start != -1 and end != -1:
            payload = payload[start : end + 1]
    try:
        return json.loads(payload)
    except json.JSONDecodeError as e:
        return {"_error": f"json_parse: {e}", "_raw": payload[:500]}


# =============================================================
# concept_brainstorm
# =============================================================

@tool
def concept_brainstorm(
    topic: str,
    target_format: str = "shorts",
    audience: str = "한국 일반 청중",
    count: int = 3,
) -> str:
    """주제 + 포맷 + 청중을 받아 영상 컨셉 N 개 생성.

    Args:
        topic: 사용자가 만들고 싶은 주제 키워드 (예: "여행", "프로그래밍 학습").
        target_format: "shorts" | "youtube" | "reels" | "general".
        audience: 대상 청중 (예: "MZ 직장인", "30대 부모").
        count: 생성할 컨셉 수 (1-5 권장).

    Returns:
        JSON: {"concepts": [{title, story_pattern, story_arc, target_format, estimated_duration_sec, audience, differentiation, risk}]}

    CONCEPT_PATTERNS.md 의 12 가지 스토리텔링 패턴 중 하나에 정확히 매핑.
    """
    count = max(1, min(count, 5))
    system = (
        "너는 영상 기획 PD다. CONCEPT_PATTERNS.md 의 12 가지 스토리텔링 패턴 중 하나에 정확히 매핑된 "
        "컨셉을 만든다. 환각 금지. 트렌드 데이터 없으면 *일반화 가능한* 컨셉만 만든다."
    )
    user = f"""주제: {topic}
타겟 포맷: {target_format}
청중: {audience}
생성할 컨셉 수: {count}

다음 JSON 스키마로만 출력 (마크다운 코드블록 안에):

```json
{{
  "concepts": [
    {{
      "title": "구체적이고 후킹 있는 제목 (10-20 자)",
      "story_pattern": "problem-solution | before-after | listicle | tutorial | transformation | day-in-life | challenge | journey | mystery | fail-success | comparison | demonstration 중 하나",
      "story_arc": "Hook -> Build -> Reveal -> CTA",
      "target_format": "{target_format}",
      "estimated_duration_sec": <number>,
      "audience": "{audience}",
      "differentiation": "이 컨셉의 차별점 (1 줄)",
      "risk": "잠재 리스크 / 저작권 / 민감 주제 (없으면 'none')"
    }}
  ]
}}
```

서로 *명확히 다른* story_pattern 으로 {count} 개 만들어라.
"""
    return json.dumps(_llm_json(system, user), ensure_ascii=False)


# =============================================================
# storyboard_from_concept
# =============================================================

@tool
def storyboard_from_concept(
    concept_title: str,
    story_pattern: str,
    target_duration_sec: float = 60.0,
    scenes_count: int = 5,
) -> str:
    """컨셉을 받아 씬별 스토리보드 (시간 / 비주얼 / 자막 / 음성 / 후킹) 생성.

    Args:
        concept_title: 컨셉 제목.
        story_pattern: 12 가지 스토리텔링 패턴 중 하나.
        target_duration_sec: 전체 영상 길이.
        scenes_count: 분할 씬 수 (3-10 권장).

    Returns:
        JSON: {"scenes": [{idx, start_sec, end_sec, visual, on_screen_text, voiceover, music_cue, effect_hint}]}
    """
    scenes_count = max(3, min(scenes_count, 10))
    system = (
        "너는 영상 스토리보드 작가다. CONCEPT_PATTERNS.md 의 story_arc 룰을 따라 씬을 분할한다. "
        "각 씬은 *구체적으로 무엇이 화면에 보이는지* 명시. effect_hint 는 effect_expert 의 카탈로그 "
        "패턴 이름 (BlurSlideIn / ZoomIntoScreen / TypewriterText / FilmGrain / FadeIn 등) 중 적절한 것."
    )
    user = f"""컨셉: {concept_title}
스토리 패턴: {story_pattern}
전체 길이: {target_duration_sec}초
씬 수: {scenes_count}

JSON 스키마:

```json
{{
  "scenes": [
    {{
      "idx": 1,
      "start_sec": 0.0,
      "end_sec": 2.0,
      "visual": "화면에 무엇이 보이는지 구체 (1 줄)",
      "on_screen_text": "자막으로 보일 텍스트 (있으면) 또는 null",
      "voiceover": "나래이션 텍스트 (있으면) 또는 null",
      "music_cue": "BGM 상태 (드롭/빌드업/silent/peak) 또는 null",
      "effect_hint": "추천 effect 패턴 이름 (effect_expert 카탈로그 기준)"
    }}
  ]
}}
```

각 씬의 start_sec / end_sec 합이 정확히 {target_duration_sec} 초.
스토리 패턴 ({story_pattern}) 의 구조를 정확히 따른다.
"""
    return json.dumps(_llm_json(system, user), ensure_ascii=False)


# =============================================================
# hook_suggest
# =============================================================

@tool
def hook_suggest(
    topic: str,
    target_format: str = "shorts",
    count: int = 3,
) -> str:
    """첫 1-3 초 후킹 멘트 N 개 생성.

    HOOKS_LIBRARY.md 의 5 가지 카테고리에서 다양한 후킹 추천.
    """
    count = max(1, min(count, 5))
    system = (
        "너는 후킹 멘트 카피라이터다. HOOKS_LIBRARY.md 의 5 가지 카테고리 (충격 통계 / 의외성 / 질문 / "
        "약속 / 5W1H) 에서 *서로 다른 카테고리* 의 후킹을 만든다. 한국어. 클릭베이트 X — 본문이 검증 "
        "가능한 약속만. 구체적 숫자를 박을 때는 *현실적인 범위* 만."
    )
    user = f"""주제: {topic}
타겟 포맷: {target_format}
생성 수: {count}

JSON:

```json
{{
  "hooks": [
    {{
      "text": "후킹 멘트 (10-25 자, 한국어)",
      "category": "shock_stat | unexpected | question | promise | 5w1h",
      "rationale": "왜 이 후킹이 이 주제에 잘 맞는지 (1 줄)"
    }}
  ]
}}
```

서로 *명확히 다른* category 로 {count} 개. 동일 카테고리 X.
"""
    return json.dumps(_llm_json(system, user), ensure_ascii=False)


# =============================================================
# cta_suggest
# =============================================================

@tool
def cta_suggest(topic: str, goal: str = "channel_growth", count: int = 3) -> str:
    """영상 마지막 Call-to-Action 멘트 N 개 생성.

    Args:
        topic: 영상 주제.
        goal: "channel_growth" | "lead_gen" | "product_sale" | "engagement" | "education".
        count: 생성 수.
    """
    count = max(1, min(count, 5))
    system = (
        "너는 CTA 카피라이터다. 영상 마지막 2-5 초 멘트. 한국어. goal 에 정확히 맞춤. "
        "강요 X, 가치 명확. 쇼츠는 짧고 강하게 (5-15 자), 유튜브는 자연스럽게 (15-30 자)."
    )
    user = f"""주제: {topic}
목적: {goal}
생성 수: {count}

JSON:

```json
{{
  "ctas": [
    {{
      "text": "CTA 멘트",
      "placement": "where to place (마지막 5초 / 영상 중간 인서트 / 화면 자막)",
      "rationale": "왜 이 CTA 가 효과적인지 (1 줄)"
    }}
  ]
}}
```
"""
    return json.dumps(_llm_json(system, user), ensure_ascii=False)


# =============================================================
# music_mood_recommend
# =============================================================

@tool
def music_mood_recommend(concept: str, target_format: str = "shorts") -> str:
    """컨셉 + 포맷에 맞는 BGM 무드 추천 (실제 음원 찾기는 별도).

    Returns:
        JSON: {"mood": "...", "keywords": [...], "tempo_bpm": [min, max], "energy": "low|mid|high",
               "ducking": bool, "license_warning": "..."}
    """
    system = (
        "너는 영상 사운드 디렉터다. 컨셉과 포맷에 맞는 BGM 무드를 결정한다. "
        "구체 곡 제목 X (저작권). 무드 키워드 + tempo 범위 + 에너지 레벨로 표현. "
        "TREND_RESEARCH.md 의 음악 / BGM 섹션 룰 따름."
    )
    user = f"""컨셉: {concept}
타겟 포맷: {target_format}

JSON:

```json
{{
  "mood": "Lo-fi / Cinematic / EDM / Acoustic / K-pop / Indie / Ambient 중 하나",
  "keywords": ["검색에 쓸 키워드 3-5 개 (영문 권장, 예: 'soft acoustic', 'cinematic build', 'lo-fi chill')"],
  "tempo_bpm": [<min>, <max>],
  "energy": "low | mid | high",
  "ducking": <bool, 발화 위 BGM 자동 감쇠 권장 여부>,
  "license_warning": "저작권 주의사항 (1 줄) 또는 'none'"
}}
```
"""
    return json.dumps(_llm_json(system, user), ensure_ascii=False)


TOOLS = [concept_brainstorm, storyboard_from_concept, hook_suggest, cta_suggest, music_mood_recommend]
