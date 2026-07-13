# Frontend - Video Agent Studio

채팅으로 영상을 편집하는 제품 UI. backend/ 의 LangGraph 편집 파이프라인과
WebSocket 으로 연결되어 업로드 → 자연어 지시 → 계획 승인 → 편집 실행 → 결과
프리뷰까지 엔드투엔드로 동작한다.

## 화면 구성

- `/` — **Video Agent Studio** (메인 제품 화면)
  - 좌: 채팅 레일 (에이전트 대화, 계획 승인 카드, 툴 실행 표시)
  - 우: 영상 프리뷰 (버전 필로 원본/편집본 전환) + 씬/자막 타임라인
- `/motion` — **모션 에디터** (Scene24 이식본, 심화 편집용)
  - 결과 카드의 "모션 에디터에서 다듬기"로 넘어오면 결과 영상 + 편집 가능한
    자막 텍스트 요소가 타임라인에 올라온 채로 열린다 (`?spec=` 딥링크)

## 구조

```
frontend/                    # Next.js 15 앱 (video-agent-studio)
├── src/
│   ├── studio/              # Video Agent Studio (제품 UI, / 라우트)
│   ├── editor/              # 모션 에디터 (타임라인 / 인스펙터 / 캔버스)
│   │   └── agent/           # 백엔드 에이전트 WS 클라이언트 + 스토어
│   └── app/                 # 라우트: / (studio), /motion (editor), /api/*
├── remotion/                # 프리뷰 + 렌더 엔진 (VideoSpec 기반, @engine/* alias)
└── package.json             # cd frontend && pnpm dev
```

Next.js 앱과 Remotion 엔진이 sibling 관계. 앱이 `./remotion` 상대 경로로
엔진 소스, spec 파일, 폰트를 직접 참조한다 (tsconfig paths + webpack alias).

## 실행

```bash
cd frontend
pnpm install

cd remotion
pnpm install            # 렌더(export) 기능에 필요

cd ..
pnpm dev                # http://localhost:3001
```

백엔드도 함께 떠 있어야 한다: `cd backend && python server.py` (port 8000).

주의: webpack 모드 필수. `--turbopack` 붙이면 엔진의 require.context 가 깨진다.

## 폰트 (General Sans)

`frontend/remotion/public/fonts/` 는 라이선스 폰트(General Sans)라 gitignore 상태.
클론 직후에는 폰트 없이 뜨고 폴백 폰트로 렌더된다. 원본 폰트가 필요하면 성민에게
받아서 `frontend/remotion/public/fonts/GeneralSans_Complete/` 에 넣으면 된다.
Google Fonts (Familjen Grotesk, Syne, Geist) 는 @remotion/google-fonts 로 자동 로드.

## 환경변수

`frontend/.env.local` (gitignore):

```
NEXT_PUBLIC_AGENT_API=http://localhost:8000   # 생략 시 이 값이 기본
ELEVENLABS_API_KEY=...   # AI 패널의 Music / SFX / Voice 생성 (없으면 해당 기능만 비활성)
```

## WebSocket 프로토콜

`backend/server.py` 상단 docstring 이 소스 오브 트루스.

```
client -> server : {type:"chat", message} | {type:"resume", approved, feedback?}
server -> client : {type:"message"|"tool_call"|"interrupt"|"final"|"done"|"error", ...}
```
