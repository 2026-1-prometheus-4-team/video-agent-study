# 1회차 스터디 - LangGraph ReAct 에이전트 풀버전

## 파일 구조

```
agent.py      - 에이전트 핵심 로직 (State, Tool, Graph)
server.py     - FastAPI 서버 (REST + WebSocket)
requirements.txt
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
python agent.py

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

### 백엔드 2명
agent.py에 Tool 하나 추가해서 graph에 붙여오기

### ML 하던 애
faster-whisper로 샘플 영상 자막 + 타임스탬프 JSON 뽑아오기
이 결과가 다음주 VideoContext.transcript 필드 베이스 됨
