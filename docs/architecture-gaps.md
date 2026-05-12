# 현재 아키텍처의 문제점과 해결 방향

현재 Supervisor + Sub-Agent 구조에서 실제 사용자 시나리오를 돌려보면 동작하지 않는 케이스가 있다.
이 문서는 문제점, 왜 문제인지, 그리고 2026년 5월 기준 프로덕션에서 어떻게 해결하는지를 정리한다.

---

## 1. Agent 간 데이터 전달

### 문제 시나리오

```
사용자: "사람이 말하는 부분만 찾아서 그 구간만 잘라줘"
```

이상적인 흐름:
```
Supervisor -> analysis_expert -> "말하는 구간: 3~7초, 15~22초" 반환
Supervisor -> edit_expert -> cut_video(3, 7), cut_video(15, 22) 실행
```

실제로 일어나는 일:
```
Supervisor -> analysis_expert -> "말하는 구간 찾았습니다" (텍스트 메시지)
Supervisor -> edit_expert -> "어떤 구간을 잘라야 하나요?" (타임스탬프 유실)
```

### 왜 문제인가

현재 agent 간 데이터 전달이 **LLM 메시지(자연어 텍스트)** 로만 이루어진다.
analysis_expert가 반환한 `[3.0, 7.0, 15.0, 22.0]` 같은 구조화된 데이터가
supervisor를 거치면서 LLM이 **의역, 반올림, 누락** 할 수 있다.

파일 경로도 마찬가지다. audio_expert가 `transcript_output.json` 을 만들어도
text_expert에게 전달될 때 경로가 정확하게 넘어가는 보장이 없다.

### 프로덕션에서의 해결: Shared State

프로덕션 agent 시스템에서는 **typed shared state** 를 사용한다.
모든 agent가 같은 state 객체를 읽고 쓴다.
구조화된 데이터(타임스탬프, 파일 경로)는 메시지가 아니라 **state 필드** 에 저장한다.

```python
class EditState(TypedDict):
    messages: Annotated[list, add_messages]
    video_context: VideoContext
    # 중간 결과물을 state에 직접 저장
    detected_segments: list[dict]       # analysis -> edit 전달용
    transcript_path: Optional[str]      # audio -> text 전달용
    current_output: Optional[str]       # 최신 편집 결과 파일 경로
```

이렇게 하면 analysis_expert가 `detected_segments` 에 쓰고,
edit_expert가 같은 필드를 읽는다. LLM이 중간에서 데이터를 건드리지 않는다.

대용량 바이너리(영상 파일)는 state에 직접 넣지 않고 **경로만 참조(reference-by-path)** 한다.
실제 파일은 디스크나 S3에 두고, state에는 `"/tmp/run_42/trim_v1.mp4"` 같은 경로만 저장.

---

## 2. 편집 후 확인 (Human-in-the-Loop)

### 문제 시나리오

```
사용자: "인트로 잘라줘"
(결과 확인하고 싶음)
"좀 더 짧게"
(다시 확인)
"OK 이대로"
```

현재 구조에서는 한 번 실행하면 끝까지 가버린다.
사용자가 **중간에 확인하고 피드백** 할 수 없다.

### 왜 문제인가

영상 편집은 본질적으로 **반복적** 이다.
한 번에 완벽한 결과가 나오는 경우는 거의 없다.
"잘라줘" -> "좀 더 짧게" -> "OK" 이 루프가 핵심 UX인데
현재 구조에서는 이 루프가 없다.

Claude Code를 생각해봐도, 코드 수정 후 "이렇게 할까요?" 확인을 받잖아.
영상 편집도 마찬가지다.

### 프로덕션에서의 해결: LangGraph interrupt()

LangGraph의 `interrupt()` 함수가 이 문제를 해결한다.
그래프 실행 중간에 멈추고, 사용자 응답을 받은 후 이어서 실행한다.

```python
from langgraph.types import interrupt, Command

def preview_node(state):
    # 편집 결과 미리보기를 사용자에게 보여주고 멈춤
    decision = interrupt({
        "preview_path": state["current_output"],
        "message": "이렇게 편집했습니다. 승인하시겠습니까?",
        "options": ["승인", "수정 요청", "취소"]
    })

    if decision == "승인":
        return {"status": "approved"}
    elif decision == "취소":
        return {"status": "cancelled"}
    else:
        # 수정 요청이면 다시 edit agent로
        return {"revision_feedback": decision}
```

동작 방식:
1. `interrupt()` 호출 시점에 그래프 실행이 **정지**
2. 전체 state가 checkpointer에 저장됨
3. 사용자가 응답하면 `Command(resume="승인")` 으로 재개
4. 몇 시간 후에 재개해도 state가 완전히 복원됨

2026년 프로덕션 패턴에서는 **adaptive interrupt** 를 쓴다.
모든 편집마다 묻지 않고, confidence score가 낮을 때만 묻는다.
"3초에서 7초 잘라줘" 같은 명확한 요청은 바로 실행하고,
"멋있게 만들어줘" 같은 모호한 요청은 계획을 보여주고 확인받는다.

---

## 3. 파일/결과물 관리

### 문제 시나리오

```
사용자: "자막 뽑아서 영상에 입혀줘"
```

이상적인 흐름:
```
audio_expert -> transcribe_video -> /tmp/transcript.json 생성
text_expert -> add_subtitle(/tmp/transcript.json) -> /tmp/subtitled.mp4 생성
```

현재 구조에서는 이 파일들을 **관리하는 시스템이 없다**.
어디에 저장하는지, 이전 버전은 어떻게 되는지, 임시 파일은 언제 정리하는지 정의되지 않았다.

### 왜 문제인가

- audio_expert가 만든 파일을 text_expert가 찾을 수 없다
- 같은 편집을 두 번 하면 파일이 덮어씌워진다
- 세션 종료 후 임시 파일이 남는다
- "아까 자른 영상"이 어디 있는지 추적 불가

### 프로덕션에서의 해결: Artifact Store

프로덕션에서는 **세션별 작업 디렉토리 + 버전 관리** 패턴을 쓴다.

```python
# 세션별 작업 디렉토리
workspace = f"/tmp/sessions/{session_id}/"

# 버전이 붙은 파일명
artifacts = {
    "trimmed_clip": "/tmp/sessions/abc123/trim_v1.mp4",
    "transcript": "/tmp/sessions/abc123/transcript_v1.json",
    "subtitled": "/tmp/sessions/abc123/subtitled_v1.mp4",
}
```

규칙:
- 원본 파일은 절대 수정하지 않는다 (immutable source)
- 모든 편집 결과는 새 파일로 생성한다 (`_v1`, `_v2`, ...)
- state에 artifact 레지스트리를 두고, 다음 agent가 최신 버전을 참조한다
- 세션 종료 시 작업 디렉토리를 정리한다

```python
class ArtifactRef(TypedDict):
    path: str
    version: int
    created_by: str    # 어떤 agent가 만들었는지

class EditState(TypedDict):
    messages: Annotated[list, add_messages]
    artifacts: dict[str, ArtifactRef]
```

---

## 4. 되돌리기 (Undo)

### 문제 시나리오

```
사용자: "인트로 10초 잘라줘"
에이전트: (실행 완료)
사용자: "아 아까 자른 거 원래대로 돌려줘"
에이전트: ??? (원본이 없음)
```

### 왜 문제인가

현재 `edit_history` 에 "cut_video: 성공" 이라는 텍스트만 기록한다.
**원본 파일을 보존하지 않으므로** 되돌릴 방법이 없다.
영상 편집에서 Undo는 기본 중의 기본 기능이다.

### 프로덕션에서의 해결

#### 방법 A: LangGraph Time-Travel (내장)

LangGraph의 checkpointer는 **매 step마다 전체 state를 자동 저장** 한다.
이전 checkpoint로 돌아가면 그 시점부터 다시 실행할 수 있다.

```python
# 이전 state 목록 조회
history = list(graph.get_state_history(config={"thread_id": "session-123"}))

# 3단계 전으로 돌아가기
past = history[3]
graph.invoke(None, config=past.config)
```

이게 "대화 이력" 수준의 undo. "아까 자르기 전으로 돌아가줘" 가 가능해진다.

#### 방법 B: Soft Mutation (파일 수준)

원본 파일을 절대 덮어쓰지 않는다. 모든 편집은 새 파일을 만든다.

```
원본: /videos/source.mp4              (불변)
v1:   /sessions/abc/cut_v1.mp4        (인트로 10초 자름)
v2:   /sessions/abc/cut_v2.mp4        (5초만 자름)
```

"원래대로 돌려줘" = state의 `current_output` 을 이전 버전으로 되돌리면 끝.
파일 자체는 다 남아있으니 언제든 복구 가능.

---

## 5. 모호한 요청 처리

### 문제 시나리오

```
사용자: "인트로 좀 멋있게 만들어줘"
```

supervisor가 어떤 agent에게 보내야 할지 판단할 수 없다.
effect? edit? text? research? 전부 다?
"멋있게"의 기준이 없다.

### 왜 문제인가

현재 supervisor prompt에 "불명확한 요청은 사용자에게 되물어라" 라고 적혀 있지만,
이건 **LLM의 판단에 100% 의존** 하는 것이다.

LLM은 모호한 요청에서도 자신있게 행동하는 경향이 있다.
"멋있게" 라는 요청에 임의로 fade + zoom + 자막을 넣어버릴 수 있다.
사용자가 원한 게 그게 아닐 확률이 높다.

### 프로덕션에서의 해결

2026년 프로덕션 패턴은 3단계 접근:

**1단계: 컨텍스트에서 추론**
이전 대화, VideoContext 메타데이터를 보고 의도를 추론한다.
예: 이전에 "유튜브 쇼츠 만들어줘" 했으면 → 쇼츠 트렌드 기반으로 판단.

**2단계: 계획 먼저 제시**
바로 실행하지 않고, "이렇게 할 계획입니다" 를 먼저 보여준다.

```python
def plan_node(state):
    plan = llm.invoke("다음 요청에 대한 편집 계획을 세워라: " + state["user_input"])

    approval = interrupt({
        "plan": plan,
        "message": "이 계획대로 진행할까요?"
    })

    return {"approved_plan": plan if approval == "승인" else None}
```

**3단계: 타겟 질문**
추론도 안 되고 계획도 못 세울 만큼 모호하면, 가장 효과적인 질문 하나만 한다.
"어떤 스타일을 원하세요?" 가 아니라
"페이드 인 + 타이틀 텍스트, 아니면 줌 인 + BGM 중 어떤 쪽?" 처럼 구체적 선택지를 준다.

```python
interrupt({
    "question": "인트로 스타일을 골라주세요",
    "options": [
        "페이드 인 + 타이틀 텍스트",
        "줌 인 + BGM",
        "직접 설명할게요"
    ]
})
```

---

## 6. 순차 파이프라인 (의존성 있는 작업)

### 문제 시나리오

```
사용자: "자막 뽑고, 그 자막 기반으로 하이라이트 구간 찾아서 잘라줘"
```

이상적인 흐름:
```
1. audio_expert -> transcribe_video -> transcript 생성
2. analysis_expert -> transcript 읽고 하이라이트 구간 탐지
3. edit_expert -> 해당 구간 cut
```

각 단계가 **이전 단계의 결과에 의존** 한다.
현재 supervisor는 "누구한테 보낼지"만 판단하고,
**어떤 순서로, 어떤 데이터를 넘기면서** 보낼지는 보장하지 않는다.

### 왜 문제인가

supervisor가 LLM이기 때문에:
- 순서를 잘못 잡을 수 있다 (edit 먼저 하려고 시도)
- 1단계 결과를 2단계에 정확히 넘기지 못할 수 있다
- 3단계를 까먹고 끝낼 수 있다

### 프로덕션에서의 해결

#### 방법 A: Supervisor가 state flag 기반으로 라우팅

단순하고 효과적인 방법. supervisor 노드가 state를 보고
"아직 안 된 단계" 로 보내는 방식.

```python
def supervisor(state):
    if not state.get("transcript_done"):
        return Command(goto="audio_expert")
    if not state.get("highlights_found"):
        return Command(goto="analysis_expert")
    if not state.get("cuts_done"):
        return Command(goto="edit_expert")
    return Command(goto=END)
```

LLM 판단이 아니라 **state 조건** 으로 라우팅하니까 순서가 보장된다.

#### 방법 B: Plan-and-Execute

먼저 LLM이 전체 계획(DAG)을 세우고, executor가 순서대로 실행한다.

```python
# Planner가 생성하는 DAG
plan = [
    {"id": 1, "agent": "audio_expert", "task": "transcribe", "depends_on": []},
    {"id": 2, "agent": "analysis_expert", "task": "find_highlights", "depends_on": [1]},
    {"id": 3, "agent": "edit_expert", "task": "cut_segments", "depends_on": [2]},
]

# Executor가 depends_on 해결되면 순서대로 실행
```

#### 방법 C: LLMCompiler

2026년 기준 가장 발전된 패턴. Planner가 DAG를 만들고,
Task Fetching Unit이 **의존성 없는 작업은 병렬로** 실행한다.

```
[transcribe]  [get_video_info]   <- 동시 실행 (의존성 없음)
      |              |
      v              v
  [find_highlights]               <- 위 두 개 끝나면 실행
      |
      v
  [cut_segments]                  <- 위 끝나면 실행
```

---

## 우리 프로젝트에 적용 우선순위

| 순위 | 문제 | 해결책 | 난이도 |
|------|------|--------|--------|
| 1 | Agent 간 데이터 전달 | Shared State에 중간 결과 필드 추가 | 낮음 |
| 2 | 파일 관리 | 세션별 workspace + 버전 파일명 | 낮음 |
| 3 | 되돌리기 | Soft Mutation + LangGraph time-travel | 중간 |
| 4 | Human-in-the-loop | interrupt()로 preview 노드 추가 | 중간 |
| 5 | 순차 파이프라인 | state flag 기반 라우팅 | 중간 |
| 6 | 모호한 요청 | 계획 먼저 제시 + interrupt() | 높음 |

---

## 참고 자료

- LangGraph Human-in-the-Loop: https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- LangGraph interrupt() 패턴: https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt/
- LangGraph Time Travel: https://docs.langchain.com/oss/python/langgraph/persistence
- Multi-Agent Orchestration 2026: https://www.codebridge.tech/articles/mastering-multi-agent-orchestration-coordination-is-the-new-scale-frontier
- LLMCompiler DAG 패턴: https://blog.langchain.com/planning-agents/
- AI Agent Rollback: https://aipatternbook.com/rollback
