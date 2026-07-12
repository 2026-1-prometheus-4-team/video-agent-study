# Frontend - Video Editor UI

Scene24 motion-editor 를 이식한 비디오 편집 에디터.
backend/ 의 LangGraph 편집 파이프라인과 연결해 "채팅으로 영상 편집" E2E 를 담당한다.

## 구조

```
frontend/
├── motion-editor/    # Next.js 15 에디터 앱 (타임라인 / 인스펙터 / 캔버스 / AI 챗)
└── remotion/         # 프리뷰 + 렌더 엔진 (VideoSpec 기반, @engine/* alias 로 참조)
```

두 폴더는 형제 관계를 유지해야 한다. motion-editor 가 `../remotion` 상대 경로로
엔진 소스, spec 파일, 폰트를 직접 참조한다 (tsconfig paths + webpack alias).

## 실행

```bash
cd frontend/motion-editor
pnpm install
cd ../remotion
pnpm install            # 렌더(export) 기능에 필요

cd ../motion-editor
pnpm dev                # http://localhost:3001
```

주의: webpack 모드 필수. `--turbopack` 붙이면 엔진의 require.context 가 깨진다.

## 폰트 (General Sans)

`frontend/remotion/public/fonts/` 는 라이선스 폰트(General Sans)라 gitignore 상태.
클론 직후에는 폰트 없이 뜨고 폴백 폰트로 렌더된다. 원본 폰트가 필요하면 성민에게
받아서 `frontend/remotion/public/fonts/GeneralSans_Complete/` 에 넣으면 된다.
Google Fonts (Familjen Grotesk, Syne, Geist) 는 @remotion/google-fonts 로 자동 로드.

## 환경변수

`frontend/motion-editor/.env.local` (gitignore):

```
ELEVENLABS_API_KEY=...   # AI 패널의 Music / SFX / Voice 생성 (없으면 해당 기능만 비활성)
```

## 백엔드 연결

FastAPI 서버 (backend/server.py, http://localhost:8000) 와 WebSocket 으로 통신한다.
에이전트 채팅 → 편집 파이프라인 실행 → 결과 영상 프리뷰 흐름은 에디터 좌측 AI 탭에서.
