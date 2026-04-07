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
