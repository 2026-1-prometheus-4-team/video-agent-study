# 로컬 환경 세팅 가이드

## 저장소 구조 (모노레포)

```
video-agent-study/
├── backend/            # FastAPI + LangGraph 에이전트 (Python)
│   ├── agent/          # 그래프, 노드, 툴
│   ├── server.py       # REST + WebSocket 서버
│   ├── remotion/       # 이펙트 렌더 엔진 (npx remotion render)
│   ├── videos/         # 입력 영상 + 분석 캐시
│   └── requirements.txt
├── frontend/           # Next.js 비디오 에디터 UI (motion-editor)
└── docs/
```

## 1. Git 클론

```bash
git clone https://github.com/2026-1-prometheus-4-team/video-agent-study.git
cd video-agent-study
```

## 2. 백엔드 세팅

```bash
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
```

## 3. 환경변수 설정

프로젝트 루트에 `.env` 파일 생성 (`.env.example` 참고)

```
GOOGLE_API_KEY=...          # 필수 (Gemini - 그래프/분석/임베딩)
ELEVENLABS_API_KEY=...      # TTS + BGM 생성
TAVILY_API_KEY=...          # 트렌드 리서치
YOUTUBE_API_KEY=...         # 유튜브 트렌드
```

`.env` 파일은 절대 Git에 올리면 안됨
`.gitignore` 에 이미 추가되어 있음

## 4. 실행

### FastAPI 서버 실행

```bash
cd backend
python server.py
```

서버 실행 후 http://localhost:8000/docs 에서 API 확인 가능

### 파이프라인 단독 테스트 (그래프 직접 실행)

```bash
cd backend
python test_pipeline.py "숏츠로 편집해줘"       # 대화형 (계획 승인 포함)
python test_pipeline.py --auto                  # 자동 승인
```

### 단위 테스트

```bash
cd backend
python -m pytest tests/ -q
```

## 5. 프론트엔드 세팅

frontend/README.md 참고 (pnpm 필요)

```bash
cd frontend/motion-editor
pnpm install
pnpm dev        # http://localhost:3001
```

## 6. 각자 작업 방식

### 브랜치 전략

```bash
# 각자 브랜치 만들어서 작업
git checkout -b feature/이름-기능명

# 예시
git checkout -b feature/minsu-cut-tool
git checkout -b feature/jiyeon-whisper-pipeline
```

### 작업 후 PR

```bash
git add .
git commit -m "feat: cut_video tool 추가"
git push origin feature/minsu-cut-tool
```

GitHub에서 main 브랜치로 PR 올리기

## 7. 숙제 제출 방식

각자 브랜치에서 작업 후 PR 올리면 됨
머지는 성민이가 리뷰 후 진행

## 주의사항

- `.env` 절대 커밋 금지
- `venv/`, `node_modules/` 폴더 커밋 금지
- PR 올리기 전에 `cd backend && python -m pytest tests/ -q` 돌려서 동작 확인
