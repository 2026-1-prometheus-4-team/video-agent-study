# 로컬 환경 세팅 가이드

## 1. Git 클론

```bash
git clone https://github.com/danlee-dev/video-edit-agent.git
cd video-edit-agent
```

## 2. 가상환경 세팅

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 3. 환경변수 설정

프로젝트 루트에 `.env` 파일 생성

```env
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` 파일은 절대 Git에 올리면 안 됩니다.
`.gitignore`에 이미 추가되어 있습니다.

## 4. 폰트 다운로드

자막 렌더링에 필요한 한국어 폰트를 다운로드합니다.

```bash
python scripts/download_fonts.py
```

`assets/fonts/`에 6개의 폰트가 저장됩니다. 이미 존재하는 폰트는 건너뜁니다.

## 5. 실행

### 에이전트 단독 실행

```bash
python agent.py
```

### FastAPI 서버 실행

```bash
python server.py
```

서버 실행 후 http://localhost:8000/docs 에서 API를 확인할 수 있습니다.

## 6. 각자 작업 방식

### 브랜치 전략

```bash
# 각자 브랜치를 만들어 작업
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

GitHub에서 `main` 브랜치로 PR을 올립니다.

## 7. 숙제 제출 방식

각자 브랜치에서 작업 후 PR을 올리면 됩니다.
머지는 성민이가 리뷰 후 진행합니다.

## 주의사항

- `.env` 절대 커밋 금지
- `venv/` 폴더 커밋 금지
- PR 올리기 전에 `python agent.py`를 실행하여 정상 동작을 확인