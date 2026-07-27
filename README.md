# Video Agent Studio

자연어 지시로 영상을 편집하는 AI 에이전트. Claude Code 스타일의 대화형 인터페이스로 업로드 · 계획 승인 · 실시간 스트리밍 · 편집 완료까지 한 화면에서.

Prometheus 2026-1 4팀 스터디 · 데모 프로젝트.

---

## 스택 · 아키텍처 요약

**Backend** — FastAPI + WebSocket + LangGraph Supervisor 그래프 + Gemini
- 그래프: `analysis` → `script` → `interrupt_gate` → `supervisor` (ReAct + spawn 서브에이전트) → `critic` → `summary` → END
- Sub-agents: `edit_expert`, `text_expert`, `audio_expert`, `effect_expert`, `research_expert`
- Memory: rolling summary + 세션 간 이월 `user_memories`
- Persistence: PostgreSQL (sessions/messages/artifacts/interrupts) via SQLAlchemy async

**Frontend** — Next.js 15 (App Router) + React 19 + Zustand + Motion
- `/` 스튜디오 (대화 rail + 스테이지 + 타임라인 실시간)
- `/motion` 모션 에디터 (자막 · 이팩트 편집)
- WebSocket 스트리밍 (interrupt · phase 카드 · tool_call · final)

**Infra** — Docker Compose (로컬 postgres:16)

---

## 저장소 구조

```
video-agent-study/
├── backend/                    FastAPI + LangGraph
│   ├── venv/                   Python 가상환경 (팀원 각자 생성 · gitignored)
│   ├── agent/                  그래프 · 노드 · 툴 · 프롬프트
│   │   ├── graph.py            메인 그래프 (supervisor_node · build_graph)
│   │   ├── nodes/              analysis / script / critic / summary
│   │   ├── tools/              edit · text · audio · effect · research · memory
│   │   ├── sub_agent.py        make_spawn_tools (격리 서브에이전트)
│   │   ├── prompt_builder.py   supervisor / script system prompt
│   │   └── config.py           모델명 · 온도 · 경로
│   ├── db/                     SQLAlchemy async (sessions · messages · artifacts · interrupts · user_memories)
│   ├── server.py               FastAPI (REST + WebSocket)
│   ├── docker-compose.yml      로컬 postgres:16
│   ├── requirements.txt
│   ├── scripts/                cli.py (단독 실행) · tools_demo.py (툴 테스트)
│   └── videos/                 입력 영상 · 편집 결과 · 자막 (.gitignore)
│
├── frontend/                   Next.js Video Agent Studio
│   ├── src/
│   │   ├── app/                / 스튜디오, /motion 모션에디터
│   │   ├── studio-v2/          스튜디오 UI (대화 rail · 스테이지 · 타임라인 · 백엔드 WS)
│   │   └── motion-editor/      모션 에디터 shell
│   ├── remotion/               Remotion 렌더 엔진 (spec 기반 이팩트)
│   └── public/
│
├── docs/                       설계 · 아키텍처 · 이관 노트
├── CLAUDE.md                   프로젝트 규칙 (에이전트용)
├── CONTRIBUTING.md             팀 협업 규칙
├── DESIGN.md                   디자인 시스템
└── README.md
```

---

# 세팅 가이드 (Mac & Windows)

**요구사항 요약**

| | Mac | Windows |
|---|---|---|
| Python | 3.10+ | 3.10+ |
| Node.js | 20+ | 20+ |
| pnpm | 8+ | 8+ |
| ffmpeg | `brew install ffmpeg` | `choco install ffmpeg` |
| Docker Desktop | brew · 또는 dmg | msi installer |
| Git | preinstalled | git-scm.com |

---

## 1. 저장소 클론 & 브랜치 만들기

```bash
git clone https://github.com/2026-1-prometheus-4-team/video-agent-study.git
cd video-agent-study
git switch -c <이름>/<작업설명>        # 예: git switch -c seongmin/timeline-sync
```

---

## 2. 백엔드 세팅

### 2-1. Python venv (backend/ 안에서)

**Mac / Linux**
```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Windows (PowerShell)**
```powershell
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> 처음에 `실행 정책 오류` 뜨면 관리자 PowerShell 에서 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` 한 번.

### 2-2. Docker Postgres 기동

세션 · 메시지 · 아티팩트 · 사용자 기억 로그가 여기 저장. Supabase 이관 시 `DATABASE_URL` 만 교체.

```bash
cd backend
docker compose up -d          # postgres:16-alpine · 5433 포트
docker compose ps             # video-agent-postgres · Up · healthy 확인
```

**Docker Desktop 이 미설치라면**
- Mac: https://www.docker.com/products/docker-desktop → dmg 설치
- Windows: 위 사이트에서 msi 다운 → 설치 후 WSL2 활성화 (설치 마법사가 안내)

### 2-3. 환경변수

```bash
# Mac / Linux
cp backend/.env.example backend/.env

# Windows (PowerShell)
Copy-Item backend\.env.example backend\.env
```

그 다음 `backend/.env` 열어서 실제 키 입력:
- `GOOGLE_API_KEY` — https://aistudio.google.com/apikey (필수)
- `OPENAI_API_KEY` — https://platform.openai.com/api-keys (Whisper 전사)
- `ELEVENLABS_API_KEY` — https://elevenlabs.io (TTS · BGM · 선택)
- `TAVILY_API_KEY` — https://app.tavily.com (트렌드 리서치 · 선택)
- `DATABASE_URL` — Docker 로컬 default 유지

### 2-4. uvicorn 서버 실행

```bash
cd backend
# Mac
source venv/bin/activate
# Windows
.\venv\Scripts\Activate.ps1

uvicorn server:app --reload --port 8000
```

- http://localhost:8000/docs → OpenAPI Swagger
- http://localhost:8000/health → 헬스 체크

---

## 3. 프론트엔드 세팅

### 3-1. pnpm 설치

**Mac**
```bash
brew install pnpm
# 또는
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

**Windows (PowerShell 관리자)**
```powershell
iwr https://get.pnpm.io/install.ps1 -useb | iex
# 또는 winget
winget install pnpm
```

### 3-2. 의존성 설치 + 환경변수

```bash
cd frontend
pnpm install
cp .env.example .env.local            # Mac
# Windows: Copy-Item .env.example .env.local
```

기본값은 로컬 uvicorn (`http://localhost:8000`) 을 가리켜서 대부분 그대로 두면 됨.

### 3-3. 개발 서버

```bash
cd frontend
pnpm dev                              # http://localhost:3001
```

포트가 이미 쓰이는 중이면 Next.js가 사용 가능한 다른 포트를 안내함.

---

## 4. 실행 확인 · 첫 테스트

1. 브라우저 http://localhost:3001
2. 좌측 사이드바 `영상 업로드` → 짧은 mp4 (10~30 초 권장) 업로드
3. 채팅에 `숏츠로 만들어줘` 전송
4. Rail 에 `영상 분석 중 · Xs 경과` phase 카드 · `계획 승인` 카드가 순차 등장
5. 승인 → supervisor 실행 → 편집 완료 → 스테이지가 편집본으로 자동 스위치

**정상 흐름 확인 명령들**

```bash
# 세션 로그 · 메시지 · 아티팩트 조회 (docker 컨테이너에서 직접 psql)
docker exec -it video-agent-postgres \
  psql -U video_agent -d video_agent -c "SELECT id, status, created_at FROM sessions ORDER BY created_at DESC LIMIT 5;"

# 백엔드 로그 실시간 (uvicorn 콘솔에서 확인)
# 프론트 콘솔 (Chrome DevTools) — WebSocket messages 도 확인 가능
```

---

## 5. 단독 실행 · 툴 데모

파이프라인이나 툴 하나만 CLI 로 테스트:

```bash
cd backend
# Mac
source venv/bin/activate
# Windows
.\venv\Scripts\Activate.ps1

python -m scripts.cli              # 그래프 CLI (질문 입력 → 진행)
python -m scripts.tools_demo       # edit_expert 툴 개별 호출
```

---

## 6. 브랜치 · PR

- `main` 은 항상 배포 가능 상태 유지
- 작업은 `<이름>/<작업설명>` 브랜치 (예: `seongmin/timeline-sync`)
- PR 은 main 브랜치로 · 최소 1인 리뷰 후 머지
- 커밋: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`)

자세한 협업 규칙: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 7. 자주 만나는 트러블

**backend uvicorn 이 `429 RESOURCE_EXHAUSTED`**
Gemini 무료 티어 하루 20 req 소진. `backend/.env` 에 다른 팀원 키 추가하거나 유료 티어 전환.

**프론트 WebSocket 이 계속 연결 · 종료 반복**
백엔드 프로세스가 재기동돼서 in-memory 세션이 사라진 상태. 브라우저에서 `sessionStorage.clear()` 후 새로고침, 또는 새 chat 보내면 새 세션 자동 생성됨.

**Postgres 컨테이너가 unhealthy**
```bash
cd backend
docker compose down -v         # 볼륨까지 초기화 (개발 데이터 날아감)
docker compose up -d
```

**`.env` 수정했는데 반영 안 됨**
uvicorn `--reload` 는 `.py` 만 감시. 환경변수 바꾼 뒤엔 `Ctrl+C` → 재실행 필수.

**Windows PowerShell 에서 `python` 이 스토어 앱 여는 문제**
`설정 > 앱 > 앱 별칭` 에서 Python 앱 별칭 끄기. 또는 `py -3 -m venv venv`.

---

## 라이선스

MIT
