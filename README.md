<<<<<<< HEAD
# 1회차 스터디 - LangGraph ReAct 에이전트 풀버전

## 파일 구조

```
agent/
  __init__.py        패키지 export
  state.py           AgentState, VideoContext 등 공용 스키마
  llm.py             Gemini LLM 인스턴스
  graph.py           LangGraph 그래프 / 노드 정의
  tools/
    __init__.py      tool 자동 수집
    scene.py         search_scene, get_video_info (참고용 더미)
    cut.py           영상 자르기 Tool
    transcribe.py    음성 -> 자막 Tool
    tts.py           텍스트 -> 음성 Tool
main.py              CLI 진입점
server.py            FastAPI 서버 (REST + WebSocket)
requirements.txt
```

## 팀원 작업 분담

각자 본인 파일만 수정하면 머지 충돌 없음.

| 담당  | 작업                              | 건드릴 파일                   |
| ----- | --------------------------------- | ----------------------------- |
| 성민  | 에이전트 graph 설계               | `agent/graph.py`              |
| 병건  | 타임스탬프 받아서 영상 자르는 Tool| `agent/tools/cut.py`          |
| 은서  | faster-whisper 자막 + 타임스탬프  | `agent/tools/transcribe.py`   |
| 은채  | 텍스트 -> 음성 TTS                | `agent/tools/tts.py`          |

### 절대 건드리지 말 것 (공용)

- `agent/state.py` - State 스키마, 모든 모듈이 import 함
- `agent/llm.py` - LLM 인스턴스, 모델 교체할 때만 수정
- `agent/tools/scene.py` - 참고용 더미. `@tool` 작성 예시로 보면 됨

### 가끔 같이 건드림 (PR 머지 시 주의)

- `agent/tools/__init__.py` - 새 tool 파일 추가하면 여기 import 한 줄, 리스트에 한 줄 추가됨

### 새 Tool 추가하는 법

1. `agent/tools/내이름.py` 생성
2. `@tool` 데코레이터로 함수 정의 (docstring 자세히 - LLM이 이걸로 판단함)
3. 파일 마지막에 `TOOLS = [내함수1, 내함수2]` 노출
4. `agent/tools/__init__.py` 에 import 한 줄 + `tools` 리스트에 한 줄 추가

`agent/tools/scene.py` 가 살아있는 예시.

### 작업 흐름

```bash
git checkout -b feature/병건-cut-tool
# 본인 파일 수정
python main.py    # 동작 확인
git add agent/tools/cut.py
git commit -m "feat: implement ffmpeg cut_video tool"
git push -u origin feature/병건-cut-tool
# GitHub 에서 main 으로 PR
```

## 설치 및 실행

### 1. 가상환경 생성 및 패키지 설치

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. API 키 설정

Google AI Studio 에서 API 키 발급 : [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

프로젝트 루트에 `.env` 파일 생성 후 아래 내용 작성

```
GOOGLE_API_KEY=발급받은_키
```

### 3. 실행

```bash
# 에이전트 단독 실행 (CLI 테스트)
python main.py

# FastAPI 서버 실행 (REST + WebSocket)
python server.py
```

## 사용 모델

- Gemini 2.5 Flash (`gemini-2.5-flash`)

## 추가된 것들

### 1. VideoContext - 영상 상태 관리
```python
class VideoContext(TypedDict):
    file_path: str
    duration: float
    scenes: list[Scene]
    transcript: list[Transcript]
```
나중에 Whisper 결과, PySceneDetect 결과 여기에 채워짐

### 2. 에러 핸들링
Tool 실패해도 에이전트가 죽지 않고
실패 내용 edit_history에 기록하고 계속 진행

### 3. 스트리밍
graph.stream() 으로 각 노드 실행마다 실시간 출력
Claude Code랑 같은 방식

### 4. FastAPI WebSocket
프론트에서 ws://localhost:8000/ws/edit 연결하면
에이전트 실행 중간 과정 실시간으로 받을 수 있음

WebSocket 메시지 타입
- ai_message  : LLM 응답
- tool_call   : Tool 선택 + args
- tool_result : Tool 실행 결과
- edit_history: 편집 기록
- done        : 완료

## 숙제

위 작업 분담표 참고. 각자 본인 파일에 `@tool` 하나씩 구현해서 PR.
=======
# 2회차 스터디 - Supervisor + Sub-Agent 아키텍처

## 아키텍처

```mermaid
flowchart TD
    User([User]) --> Supervisor[Supervisor]

    Supervisor --> Edit[edit_expert]
    Supervisor --> Audio[audio_expert]
    Supervisor --> Text[text_expert]
    Supervisor --> Effect[effect_expert]
    Supervisor --> Analysis[analysis_expert]
    Supervisor --> Research[research_expert]

    Edit --> EditTools["cut, trim, split, merge\nspeed, reverse, crop, resize"]
    Audio --> AudioTools["tts, stt, bgm\ndenoise, volume, voice clone"]
    Text --> TextTools["subtitle, title\ncaption, overlay"]
    Effect --> EffectTools["fade, zoom, blur\ncolor grade, transition"]
    Analysis --> AnalysisTools["scene detect, face detect\nobject track, video info"]
    Research --> ResearchTools["web search, trend\nreference"]

    classDef emphasisClass fill:#1a7a6d,stroke:#145f55,stroke-width:2px,color:#fff,rx:15,ry:15
    classDef normalClass fill:#fff,stroke:#2d9f93,stroke-width:1.5px,color:#1a3a36,rx:15,ry:15
    classDef processClass fill:#e8f6f4,stroke:#7ecac1,stroke-width:1px,color:#2c5c56,rx:10,ry:10

    class User,Supervisor emphasisClass
    class Edit,Audio,Text,Effect,Analysis,Research normalClass
    class EditTools,AudioTools,TextTools,EffectTools,AnalysisTools,ResearchTools processClass
```

각 Sub-Agent는 `create_agent`로 생성되며 내부에 ReAct 루프가 내장되어 있음.
Supervisor는 `langgraph-supervisor`의 `create_supervisor`로 생성, handoff tool을 자동 생성함.

### 요청 처리 흐름

```mermaid
flowchart LR
    Input([프롬프트 입력]) --> Sup[Supervisor LLM]
    Sup --> |handoff| Agent[Sub-Agent LLM]
    Agent --> |tool call| Tool[Tool 실행]
    Tool --> |result| Agent
    Agent --> |transfer back| Sup
    Sup --> Output([최종 응답])

    classDef emphasisClass fill:#1a7a6d,stroke:#145f55,stroke-width:2px,color:#fff,rx:15,ry:15
    classDef normalClass fill:#fff,stroke:#2d9f93,stroke-width:1.5px,color:#1a3a36,rx:15,ry:15
    classDef processClass fill:#e8f6f4,stroke:#7ecac1,stroke-width:1px,color:#2c5c56,rx:10,ry:10

    class Input,Output emphasisClass
    class Sup,Agent normalClass
    class Tool processClass
```

## 파일 구조

```text
agent/
  __init__.py        패키지 export
  state.py           VideoContext 등 도메인 스키마
  llm.py             Gemini LLM 인스턴스
  graph.py           Supervisor + Sub-Agent 그래프 정의
  tools/
    __init__.py      tool 자동 수집 + 도메인별 그룹 (tool_groups)
    scene.py         search_scene, get_video_info (더미)
    cut.py           영상 자르기 Tool (더미)
    transcribe.py    음성 -> 자막 Tool (더미)
    tts.py           텍스트 -> 음성 Tool (더미)
server.py            FastAPI 서버 (세션 기반 REST + WebSocket)
requirements.txt
```

## 팀원 작업 분담

각자 본인 파일만 수정하면 머지 충돌 없음.

| 담당  | 작업                              | 건드릴 파일                   |
| ----- | --------------------------------- | ----------------------------- |
| 성민  | Supervisor + graph 설계           | `agent/graph.py`, `server.py` |
| 병건  | 타임스탬프 받아서 영상 자르는 Tool| `agent/tools/cut.py`          |
| 은서  | faster-whisper 자막 + 타임스탬프  | `agent/tools/transcribe.py`   |
| 은채  | 텍스트 -> 음성 TTS                | `agent/tools/tts.py`          |

### 건드리지 말 것 (공용)

- `agent/state.py` - 도메인 스키마, 모든 모듈이 import 함
- `agent/llm.py` - LLM 인스턴스
- `agent/graph.py` - Supervisor 구조 (성민 담당)

### 가끔 같이 건드림 (PR 머지 시 주의)

- `agent/tools/__init__.py` - 새 tool 추가 시 import + tool_groups 등록

### 새 Tool 추가하는 법

1. `agent/tools/내이름.py` 생성
2. `@tool` 데코레이터로 함수 정의 (docstring 자세히 - LLM이 이걸로 판단함)
3. 파일 마지막에 `TOOLS = [내함수1, 내함수2]` 노출
4. `agent/tools/__init__.py` 에 import 한 줄 + `tool_groups`에 해당 도메인에 등록

`agent/tools/scene.py` 가 살아있는 예시.

## 설치 및 실행

### 1. 가상환경 생성 및 패키지 설치

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. API 키 설정

Google AI Studio 에서 API 키 발급 : [aistudio.google.com/apikey](https://aistudio.google.com/apikey)

프로젝트 루트에 `.env` 파일 생성 후 아래 내용 작성

```text
GOOGLE_API_KEY=발급받은_키
```

### 3. 실행

```bash
# FastAPI 서버 실행
python server.py
# Swagger UI: http://localhost:8000/docs
```

## API 엔드포인트

### 세션 기반 (연속 대화)

```text
POST   /session          - 새 세션 생성 (video_context 넘기면 이후 자동 참조)
POST   /chat             - session_id + message 로 대화 (이력 유지)
GET    /session/{id}     - 세션 정보 조회
DELETE /session/{id}     - 세션 종료
```

### 단발성 (테스트용)

```text
POST   /edit             - video_context + user_input 한 번에 실행
```

### WebSocket (프론트엔드 스트리밍)

```text
WS     /ws/chat/{session_id}  - 실시간 스트리밍
       전송: {"message": "3초에서 7초 잘라줘"}
       수신: {"type": "message"|"tool_call"|"done", ...}
```

## 사용 기술

- LangGraph 1.1+ (`create_agent` - 내장 ReAct 루프)
- langgraph-supervisor (`create_supervisor` - handoff 기반 multi-agent)
- Gemini 2.5 Flash (LLM)
- FastAPI + MemorySaver (세션 기반 대화 유지)

## 성민 작업 내역 (2회차)

- 기존 수동 ReAct 루프를 `create_agent` + `create_supervisor`로 교체
- 6개 도메인 sub-agent 구조 설계 (edit, audio, text, effect, analysis, research)
- `tool_groups` 딕셔너리로 agent별 tool 그룹 분리
- 세션 기반 API 설계 (MemorySaver로 대화 이력 유지)
- video_context를 supervisor + 모든 sub-agent에 동적 주입

## 숙제

각자 본인 tool 파일의 더미 구현을 실제로 교체해서 PR.

- 병건: `cut.py` - FFmpeg subprocess로 실제 영상 cut
- 은서: `transcribe.py` - faster-whisper로 실제 자막 추출
- 은채: `tts.py` - TTS 엔진 연동 (ElevenLabs / OpenAI TTS 등)
>>>>>>> main
