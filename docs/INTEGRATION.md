# 통합 가이드 (Integration Guide)

성민이 만든 *main 파이프라인 + effect_expert + research_expert* 의 I/O 명세.
다른 팀원이 본인 sub-agent 를 이 파이프라인에 *어떻게 연결* 하는지 알 수 있게 작성.

작성: 성민 (2026-06)


## 0. 한 줄 요약

사용자 자연어 한 마디 → 사전 분석 → plan 생성 → 사용자 승인 → Supervisor 가 sub-agent 들을
ReAct 루프로 호출 → 결과 통합 → critic 검증 → mp4 산출.

각 sub-agent 는 *완전히 격리된 컨텍스트* 에서 자기 도구만 써서 자기 임무 수행 후 결과 string 반환.
parent (Supervisor) 의 message history 는 못 본다.


## 1. 전체 파이프라인 (그래프 토폴로지)

```
START
  ↓
[analysis_node]      ← video_context (사전 분석 결과) 채움
  ↓
[script_node]        ← 사용자 요청 → 단계별 plan JSON
  ↓
[interrupt_gate]     ← 사용자 승인 / 수정 피드백 (LangGraph interrupt())
  │
  ├─ feedback 있음 → [script_node] 재생성
  └─ OK
     ↓
[supervisor_node]    ← ReAct 루프, sub-agent 5 종을 tool 처럼 spawn
  ↓
[critic_node]        ← PASS / RETRY 검증
  │
  ├─ PASS → END (final_output_path = mp4)
  └─ RETRY → [supervisor_node] 다시
```

구현: `agent/graph.py`. 7 노드 LangGraph StateGraph.

상태는 `AgentState` 라는 단일 TypedDict 가 모든 노드 사이 전달됨. 각 노드는 *부분 dict* 반환해서
state 를 patch.


## 2. State TypedDict (모든 노드가 보는 공용 데이터)

`agent/state.py` 참고. 핵심 필드:

| 필드 | 타입 | 누가 채움 | 누가 읽음 |
|------|------|-----------|-----------|
| `user_request` | str | 호출자 (graph 진입 시) | script_node |
| `video_paths` | list[str] | 호출자 | analysis_node |
| `video_context` | VideoContext \| None | analysis_node | script_node, supervisor_node, sub-agents |
| `script_plan` | ScriptPlan \| None | script_node | interrupt_gate, supervisor_node, critic_node |
| `script_feedback` | str \| None | interrupt_gate | script_node (재생성 trigger) |
| `script_revision` | int | script_node | script_node (loop guard) |
| `execution_trace` | list[ExecutionStep] | supervisor_node | critic_node |
| `final_output_path` | str \| None | supervisor_node | critic_node |
| `critic_verdict` | CriticVerdict \| None | critic_node | END |
| `messages` | list (langgraph reducer) | 모두 | 모두 |
| `spawn_depth` | int | 초기값 0 | sub_agent.py (recursion guard) |
| `session_id` | str | 호출자 | sub-agents (추적용) |

### VideoContext (analysis_node 출력 형식)

```python
class VideoContext(TypedDict):
    file_path: str
    duration: float
    scenes: list[Scene]         # PySceneDetect / Gemini Vision
    transcript: list[Transcript]  # Whisper

class Scene(TypedDict):
    start: float        # seconds
    end: float
    description: str

class Transcript(TypedDict):
    start: float
    end: float
    text: str
```

### ScriptPlan (script_node 출력 형식)

```python
class ScriptPlan(TypedDict, total=False):
    target_format: str          # "shorts" | "youtube" | "reels" | "general"
    target_aspect_ratio: str    # "9:16" | "16:9" | "1:1" | "original"
    target_duration_sec: Optional[float]
    steps: list[dict]           # 각 step 의 {step_id, action, expert, params, depends_on, parallel_group, rationale}
    tts_choice: Optional[dict]
    subtitle_style: Optional[dict]
    bgm_choice: Optional[dict]
    color_grade: Optional[str]
    questions: list[str]        # 비어있지 않으면 interrupt 게이트가 사용자에게 물음
```

### ExecutionStep (supervisor_node 가 누적)

```python
class ExecutionStep(TypedDict, total=False):
    step_id: int
    expert: str             # "edit_expert" 등
    action: str             # "cut_video" 등
    status: str             # "ok" | "error"
    summary: str
    output_paths: list[str]
    duration_sec: float
```

### CriticVerdict

```python
class CriticVerdict(TypedDict, total=False):
    verdict: str            # "PASS" | "RETRY"
    issues: list[str]
    retry_from_step_id: Optional[int]
    message_to_user: str
```


## 3. Main 파이프라인 노드 I/O 명세

### 3.1 analysis_node

**파일**: `agent/graph.py` 의 `analysis_node()`

| 항목 | 내용 |
|------|------|
| 입력 (state) | `video_paths`, `video_context` (있으면 skip) |
| 출력 (state patch) | `{"video_context": VideoContext}` |
| 동작 | video_paths[0] 영상 분석 → scenes + transcript → VideoContext |
| 실패 시 | video_paths 가 비면 그냥 skip (logging warning) |

현재는 빈 스켈레톤만 채움 — 실제 분석 호출은 ML 영역 PR 에서 채워짐.

### 3.2 script_node

**파일**: `agent/nodes/script_node.py`

| 항목 | 내용 |
|------|------|
| 입력 (state) | `user_request`, `video_context`, `video_paths`, (재생성 시) `script_plan` + `script_feedback`, `script_revision` |
| 출력 (state patch) | `{"script_plan": ScriptPlan, "script_revision": +1, "script_feedback": None}` |
| 모델 | Gemini 3.1 Pro Preview |
| 동작 | LLM 에게 plan JSON 생성 요청 → `_extract_json` 으로 파싱 |
| 실패 시 | `questions` 필드에 에러 박아서 interrupt 게이트로 |

plan 의 *스키마* 는 `agent/prompt_builder.py` 의 `SCRIPT_NODE_INSTRUCTION` 에 명시. LLM 이 이 스키마 따라 출력.

### 3.3 interrupt_gate

**파일**: `agent/graph.py` 의 `interrupt_gate()`

| 항목 | 내용 |
|------|------|
| 입력 (state) | `script_plan` |
| 출력 (state patch) | `{"script_feedback": None}` (승인) 또는 `{"script_feedback": "..."}` (수정 요청) |
| 동작 | LangGraph `interrupt({...})` 호출 → 그래프 멈춤 → 클라이언트가 `Command(resume=...)` 로 재개 |
| resume value | `{"approved": True}` 또는 `{"approved": False, "feedback": "..."}` |
| 라우팅 | feedback 있음 → script_node 재생성, 없음 → supervisor_node |

### 3.4 supervisor_node

**파일**: `agent/graph.py` 의 `supervisor_node()`

| 항목 | 내용 |
|------|------|
| 입력 (state) | `script_plan`, `video_context`, `execution_trace` |
| 출력 (state patch) | `{"execution_trace": [...누적], "final_output_path": "..."}` |
| 모델 | Gemini 3.1 Pro Preview |
| 동작 | `create_agent(model, spawn_tools, system_prompt)` 로 ReAct mini-graph 생성 → invoke. 내부에서 자체 ReAct 루프 (Think → Act → Observe) 돌며 5 sub-agent 를 tool 처럼 호출 |
| 종료 조건 | 마지막 메시지에 `FINAL_OUTPUT: <path>` 박혀 있으면 종료 |

Supervisor 가 받은 tool 목록 (sub-agent 5 종):
- `edit` — edit_expert 격리 spawn
- `audio` — audio_expert 격리 spawn
- `text` — text_expert 격리 spawn
- `effect` — effect_expert 격리 spawn
- `research` — research_expert 격리 spawn

각 spawn tool 의 시그니처:
```python
spawn(task: str, allowed_tools: Optional[list[str]] = None) -> str
# returns: "[role] status=ok ... outputs: ..." 형태의 다중 라인 string
```

### 3.5 critic_node

**파일**: `agent/nodes/critic_node.py`

| 항목 | 내용 |
|------|------|
| 입력 (state) | `final_output_path`, `script_plan`, `execution_trace`, `video_context` |
| 출력 (state patch) | `{"critic_verdict": CriticVerdict}` |
| 모델 | Gemini 3.1 Pro Preview |
| 동작 | 1) 객관 가드: `os.path.exists(final_output_path)` 체크. 없으면 즉시 RETRY. 2) LLM 검증: trace + plan vs 사용자 요청 매칭 |
| 라우팅 | PASS → END, RETRY → supervisor_node |


## 4. Sub-Agent Spawn 계약 (모든 sub-agent 공통)

`agent/sub_agent.py` 가 *모든 sub-agent 의 공용 spawn 메커니즘*. OpenClaw ACP 패턴.
다른 팀원의 sub-agent 도 이 계약을 따른다.

### 4.1 SubAgentEnvelope (parent → child)

```python
@dataclass
class SubAgentEnvelope:
    role: str                              # "edit_expert" | "audio_expert" | ...
    task: str                              # child 가 받는 *유일한* 채널
    inherited_tool_allowlist: list[str] | None = None
    inherited_tool_denylist: list[str] = []
    video_context: VideoContext | None = None
    model_override: str | None = None
    spawn_depth: int = 0                   # parent.depth + 1, max 2
    parent_session_id: str | None = None
```

**중요**: child 는 parent 의 message history 못 본다. `task` string 에 *반드시*:
- 입력 파일 경로 (절대 경로 또는 videos/ 상대)
- 출력 파일 경로 (또는 패턴)
- 타임스탬프 (start/end, 초 단위)
- 이전 step 산출물 경로
- 사용자 제약 (포맷, 비율, 길이)

명시. 박지 않으면 child 가 모름.

### 4.2 SubAgentResult (child → parent)

```python
@dataclass
class SubAgentResult:
    role: str
    status: str             # "ok" | "error" | "needs_user"
    summary: str            # 한 줄 요약 (Supervisor 가 보고 다음 결정)
    output_paths: list[str] # 산출 파일 경로들
    detail: str             # 긴 설명 (디버깅용)
    error: str | None
    duration_sec: float
```

`as_tool_result_text()` 메서드가 다중 라인 string 으로 변환 → Supervisor 의 tool_result 로 들어감.

### 4.3 Spawn 시 적용되는 룰

`agent/config.py` 의 `SUB_AGENT_LIMITS`:
- `max_spawn_depth = 2`: recursion 가드
- `max_children_per_agent = 5`: 동시 spawn 제한
- `max_tool_calls_per_spawn = 12`: child 내부 ReAct 루프 최대 turn

### 4.4 시스템 프롬프트 자동 조립

`agent/prompt_builder.py` 의 `build_sub_agent_system_prompt(role, ...)` 가 다음을 자동 합침:

1. `agent/sub_agents/<role>/SOUL.md` (정체성)
2. `agent/sub_agents/<role>/AGENTS.md` (정책 / 워크플로우)
3. `agent/sub_agents/<role>/TOOLS.md` (보유 도구 명세)
4. 그 외 *.md 알파벳순 (MOTION_DIRECTING.md, REMOTION_RULES.md, TREND_RESEARCH.md, ...)
5. `<!-- VIDEO_AGENT_CACHE_BOUNDARY -->` 마커
6. `# Parent Supervisor Task` (dynamic suffix)

cache boundary 위쪽 = Gemini implicit cache 노림 / 아래쪽 = 매번 변함.

**다른 팀원이 알아야 할 것**: 본인 `agent/sub_agents/<role>/` 폴더에 *.md 만 박으면 자동으로 본인 sub-agent 의 system prompt 에 포함됨. 추가 코드 변경 없음.


## 5. effect_expert (성민 구현)

**위치**: `agent/sub_agents/effect_expert/`

**역할**: Remotion 기반 모션 효과 (20 패턴 카탈로그).

### 5.1 보유 도구

| 도구 | 시그니처 |
|------|----------|
| `apply_remotion_effect(clip_path, pattern_id, effect_params, effect_mode, text_overlay, brand_energy, target_format, duration_sec, output_path)` | subprocess `npx remotion render` |
| `query_effect_catalog(pattern_id, category)` | `agent/effects/registry.json` 조회 (메타 / 카테고리) |

### 5.2 카탈로그

- `agent/effects/INDEX.md` — 카테고리별 패턴 요약 (20 개)
- `agent/effects/registry.json` — 패턴별 메타 (combines_well_with, avoid, default_params, brand_energy_behavior, typical_duration_frames)

### 5.3 실제 Remotion 컴포넌트

- `remotion/src/effects/*.tsx` — 19 패턴 (FadeIn, ZoomIntoScreen, TypewriterText, NumberTicker, BlurSlideIn/Out, ConfettiExplosion, DeviceMockup, ColorSweep, LiquidMorph, HandCursor, CheckmarkDraw, ProgressBar, BreathingDots, TextReveal, KineticWordSwap, Hold, HardCut, FadeOut)
- `remotion/src/atoms/layer-effects.tsx` — atom 효과 (FilmGrain, Vignette, OuterGlow, BreathingWrapper)
- `remotion/src/atoms/spring-config.ts` — BrandEnergy 별 spring preset
- `remotion/src/ClipEffect.tsx` — 클립 + effect 1 개 합성 wrapper

### 5.4 effect_mode 3 종

| mode | 설명 | 적용 패턴 예 |
|------|------|--------------|
| `overlay` | 영상 위에 absolute fill | FilmGrain, ConfettiExplosion, CheckmarkDraw, HandCursor, BreathingDots |
| `wrap` | 영상을 children 으로 감싸 transform | ZoomIntoScreen, BlurSlideIn, FadeIn, Hold |
| `replace` | 영상 없이 효과만 (인서트 컷) | TypewriterText, NumberTicker, TextReveal, KineticWordSwap |

### 5.5 spawn task 예시

```
videos/clips/merged.mp4 의 첫 3 초에 ZoomIntoScreen 효과를 brand_energy=high 로 입혀서
videos/clips/zoomed.mp4 로 저장.
effect_mode: wrap. targetScale: 3.0, focusX/Y: 0.5/0.5.
타겟 포맷: shorts.
```

### 5.6 산출물

- mp4 파일 경로 (`videos/effects/<ts>_<pattern>.mp4` 또는 명시 경로)
- `SubAgentResult.output_paths` 에 포함되어 Supervisor 에게 반환

### 5.7 셋업 요구

- `cd remotion && pnpm install` 한 번 필요
- `apply_remotion_effect` 가 자동 점검 후 친절한 에러 반환 (`remotion_not_setup`)


## 6. research_expert (성민 구현)

**위치**: `agent/sub_agents/research_expert/`

**역할**: 영상 기획 + 트렌드 리서치. *기획 없이 와도 end-to-end* 가능.

### 6.1 3 모드 (task 의 구체성으로 자동 판별)

| mode | trigger | 출력 |
|------|---------|------|
| **A — concept_generation** | 사용자 기획 없음 ("쇼츠 만들고 싶은데 뭐 만들지 모름") | 트렌드 + 컨셉 3 개 + 후킹 + CTA + 음악 |
| **B — concept_enrichment** | 사용자 컨셉 있음, 보강 필요 | 유사 영상 분석 + 차별화 포인트 + 스토리보드 |
| **C — trend_research** | 순수 리서치 | 트렌드 / 채널 분석 5 줄 인사이트 |

### 6.2 보유 도구 — LLM-only (외부 API 없이 작동)

| 도구 | 시그니처 |
|------|----------|
| `concept_brainstorm(topic, target_format, audience, count)` | 컨셉 N 개 생성 |
| `storyboard_from_concept(concept_title, story_pattern, target_duration_sec, scenes_count)` | 씬별 스토리보드 |
| `hook_suggest(topic, target_format, count)` | 후킹 멘트 N 개 (5 카테고리: 충격통계 / 의외성 / 질문 / 약속 / 5W1H) |
| `cta_suggest(topic, goal, count)` | CTA 멘트 N 개 |
| `music_mood_recommend(concept, target_format)` | BGM 무드 키워드 + tempo |

### 6.3 보유 도구 — External API

| 도구 | 시그니처 | 의존 |
|------|----------|------|
| `web_search(query, max_results)` | 일반 웹 검색 | Tavily API |
| `youtube_trend(category, region, count)` | 트렌딩 영상 | YouTube Data API v3 |
| `youtube_search(query, sort_by, count)` | 키워드 검색 | YouTube Data API v3 |
| `channel_analysis(channel_id, recent_n)` | 채널 최근 영상 패턴 추출 | YouTube Data API v3 |

### 6.4 `.env` 키 필요

```
TAVILY_API_KEY=tvly-...       # https://app.tavily.com (월 1000 검색 무료)
YOUTUBE_API_KEY=AIza...       # Google Cloud Console > YouTube Data API v3 (일 10k unit 무료)
```

없으면 LLM-only 도구는 그대로 동작, External API 도구만 `missing_api_key` 친절한 에러 반환.

### 6.5 카탈로그 자산 (sub-agent system prompt 에 자동 포함)

- `TREND_RESEARCH.md` — 한국 시장 특수성 (후킹 / 자막 / BGM 트렌드)
- `CONCEPT_PATTERNS.md` — 12 가지 스토리텔링 패턴 (problem-solution, before-after, listicle, tutorial, transformation, day-in-life, challenge, journey, mystery, fail-success, comparison, demonstration)
- `HOOKS_LIBRARY.md` — 5 가지 후킹 카테고리 + 한국 시장 팁

### 6.6 spawn task 예시

```
사용자가 "여행 영상 만들고 싶은데 컨셉 모름" 이라고 함. Mode A 로 진행.
20-30대 한국 직장인 대상 쇼츠 3 컨셉 + 각각 후킹 + CTA + BGM 무드 추천.
```

### 6.7 산출물 (Mode A 기준)

```json
{
  "mode": "concept_generation",
  "trend_summary": "...",
  "concepts": [
    {
      "title": "1박 2일 강릉 카페 5곳",
      "story_pattern": "listicle",
      "story_arc": "Hook -> 5 places -> CTA",
      "hook": "한국 사람만 모르는 강릉 카페 5곳",
      "cta": "다음 영상은 다른 지역 갈게요",
      "music_mood": {"mood": "Lo-fi", "tempo_bpm": [85, 100], "energy": "low"},
      "storyboard": [...]
    }
  ],
  "sources": ["url1", "url2"]
}
```


## 7. 사용 시나리오 (effect / research 호출 예시)

### 7.1 시나리오 — "기획 없음, 컨셉 추천" (research_expert 활용)

사용자: *"쇼츠 만들고 싶은데 뭐 만들지 모름. 여행 주제로"*

```
1. analysis_node → video_paths 없음 → skip
2. script_node → user_request 모호 → 첫 step 으로 research_expert 박은 plan 산출:
   steps: [{1, research_expert, concept_generation, params: {topic: "여행", format: "shorts", audience: "20-30대"}}]
   questions: ["컨셉 3 개 중 어느 걸 진행하시겠어요?"]
3. interrupt_gate → 사용자가 "1번 진행" 응답 → script_feedback="컨셉 1 진행"
4. script_node 재생성 → 선택된 컨셉으로 본격 plan
5. supervisor_node 가 후속 step 진행 ...
```

### 7.2 시나리오 — "이 영상에 효과만" (effect_expert 활용)

사용자: *"이 영상 첫 3 초에 줌인 효과 넣어줘"*

```
1. analysis → video_context (이미 있다고 가정)
2. script_node → steps: [{1, effect_expert, apply_remotion_effect, params: {pattern_id: "ZoomIntoScreen", ...}}]
3. interrupt → OK
4. supervisor → spawn(effect, "videos/raw/v1.mp4 첫 3초에 ZoomIntoScreen wrap 모드, brand_energy=moderate")
   - effect_expert 가 query_effect_catalog 로 default_params 조회
   - apply_remotion_effect 호출 → subprocess `npx remotion render`
   - videos/effects/<ts>_ZoomIntoScreen.mp4 산출
5. critic → PASS
```


## 8. 통합 테스트 가이드

### 8.1 effect / research 단독 테스트

```bash
source venv/bin/activate
python -c "
from agent.sub_agent import SubAgentEnvelope, spawn_sub_agent

# research_expert 단독 (LLM-only, API 키 없어도 동작)
env = SubAgentEnvelope(
    role='research_expert',
    task='쇼츠 만들고 싶은데 여행 주제로 뭐 만들지 모름. 컨셉 추천해줘',
)
print(spawn_sub_agent(env).as_tool_result_text())

# effect_expert 단독 (Remotion pnpm install 필요)
env = SubAgentEnvelope(
    role='effect_expert',
    task='videos/raw/sample.mp4 의 첫 3초에 ZoomIntoScreen 효과 wrap 모드, brand_energy=moderate. videos/out/zoomed.mp4 로 저장.',
)
print(spawn_sub_agent(env).as_tool_result_text())
"
```

### 8.2 풀 파이프라인 시연

```python
from agent.graph import run_agent_stream

for chunk in run_agent_stream(
    user_request="여행 쇼츠 컨셉 추천해줘",
    video_paths=[],
):
    for node_name, state in chunk.items():
        print(f"\n[{node_name}]")
```

각 노드 출력이 stream 으로 yield 됨.

### 8.3 자주 막히는 부분

| 증상 | 원인 | 해결 |
|------|------|------|
| `apply_remotion_effect` 가 `remotion_not_setup` 반환 | `remotion/node_modules` 없음 | `cd remotion && pnpm install` |
| `web_search` / `youtube_trend` 가 `missing_api_key` 반환 | `.env` 에 키 없음 | `.env` 에 TAVILY/YOUTUBE_API_KEY 추가 |
| LLM 이 plan JSON 파싱 실패 | LLM 출력에 코드블록 없거나 잘못된 JSON | `script_node._extract_json` 의 fallback (bracket span) 작동. 그래도 실패면 `questions` 에 에러 박힘 |
| sub-agent 가 *parent 의 정보 못 봐서 막힘* | parent 가 task string 에 안 박음 | 모든 input 경로 / 산출 경로 / 파라미터를 task string 에 *명시적으로* 박을 것 |


## 9. 다른 sub-agent 와 연결하는 법 (팀원용 한 줄 요약)

본인 sub-agent 가 이 파이프라인에 *연결되는 방식*:

1. `agent/sub_agents/<role>/` 폴더에 SOUL.md / AGENTS.md / TOOLS.md 작성 (기본 골격은 이미 있음 — TODO 채우기)
2. `agent/tools/<본인이름>_<기능>.py` 에 `@tool` 함수 정의, 파일 끝에 `TOOLS = [...]` 노출
3. `agent/tools/__init__.py` 에 본인 import 줄 1 개 + `tool_groups["<role 그룹>"]` 에 본인 tool 추가
4. 끝. Supervisor 가 자동으로 본인 sub-agent 부를 수 있게 됨

본인 sub-agent 의 *system prompt* 는 `build_sub_agent_system_prompt` 가 자동 조립. 본인 폴더의 *.md
박는 게 시스템 프롬프트 작성.

본인 sub-agent 가 받는 *입력* = Supervisor 가 박은 `task` string. 본인 *출력* = `SubAgentResult` —
산출 파일 경로 + summary 가 핵심. 형식만 맞으면 됨.


## 10. 참고 파일

- 그래프 본체: [agent/graph.py](../agent/graph.py)
- 상태 정의: [agent/state.py](../agent/state.py)
- Sub-agent 메커니즘: [agent/sub_agent.py](../agent/sub_agent.py)
- 프롬프트 조립: [agent/prompt_builder.py](../agent/prompt_builder.py)
- 노드: [agent/nodes/](../agent/nodes/)
- Supervisor 거버넌스: [agent/workspace/AGENTS.md](../agent/workspace/AGENTS.md)
- effect_expert: [agent/sub_agents/effect_expert/](../agent/sub_agents/effect_expert/)
- research_expert: [agent/sub_agents/research_expert/](../agent/sub_agents/research_expert/)
- 효과 카탈로그: [agent/effects/INDEX.md](../agent/effects/INDEX.md), [agent/effects/registry.json](../agent/effects/registry.json)
- Remotion 프로젝트: [remotion/](../remotion/)
- 팀 가이드: [CONTRIBUTING.md](../CONTRIBUTING.md)
