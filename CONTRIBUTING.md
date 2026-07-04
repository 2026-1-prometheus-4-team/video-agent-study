# CONTRIBUTING — 팀 작업 가이드

이 문서는 팀원이 *자기 브랜치에서 독립적으로 작업* 하기 위한 가이드다.
충돌 가능 영역을 명확히 가르고, 본인 영역만 만지면 머지 충돌 거의 없다.

업데이트: 2026-05-25 (성민 작성)

---

## 1. 팀 구성 & Owner 분담

CLAUDE.md 의 team composition 을 sub-agent 구조에 매핑한 결과 (스택 기반).

| 팀원   | 책임 영역                                                            | 작업 폴더 / 파일                                                                 |
|--------|----------------------------------------------------------------------|----------------------------------------------------------------------------------|
| 성민   | Supervisor + Script + Critic + graph 골조 + research_expert + UI    | `agent/{graph,prompt_builder,sub_agent,config,llm,state}.py`, `agent/nodes/`, `agent/workspace/`, `agent/sub_agents/research_expert/`, `agent/tools/research_llm.py`, `agent/tools/research_external.py`, Next.js |
| 병건   | edit_expert + effect_expert (FFmpeg + Remotion)                      | `agent/sub_agents/edit_expert/`, `agent/sub_agents/effect_expert/`, `agent/tools/cut.py` 외 신규 FFmpeg tool, `agent/tools/remotion_render.py`, `agent/effects/`, `remotion/` |
| 은서   | audio_expert (Whisper + TTS + BGM + SFX) + 영상 사전 분석           | `agent/sub_agents/audio_expert/`, `agent/tools/transcribe.py`, `tts.py`, `video_understanding_eun.py`, `video_analysis.py` |
| 은채   | text_expert (자막/타이틀/캡션) + audio_expert.tts 보조              | `agent/sub_agents/text_expert/`, 자막 관련 신규 tool, `agent/tools/tts.py` 협업 |

규칙: **본인 폴더만 만진다.** 다른 사람 폴더 수정이 필요하면 PR comment 로 요청.

---

## 2. 시작하기

```bash
# 1. clone
git clone <repo-url>
cd video-agent-study

# 2. venv (이미 만들어져 있으면 skip)
python3 -m venv venv
source venv/bin/activate

# 3. 의존성
pip install -r requirements.txt

# 4. .env 설정 (각자 본인 키)
cp .env.example .env
# .env 안에 GOOGLE_API_KEY 채우기

# 5. smoke test
python -c "from agent.graph import build_graph; build_graph(); print('OK')"
```

`.env` 는 **절대 commit 하지 않는다.** `.gitignore` 에 등록됨.

---

## 3. 브랜치 규칙 (팀 모드)

현재 머지 흐름: `main ← <작업 브랜치>` (각자 브랜치 → main 직접 PR, #8~#12 관행)

- **main** : 통합 브랜치. 직접 push 금지, PR 로만.
- **작업 브랜치** : main 에서 분기, 각자 작업 후 main 으로 PR.

> dev (staging) 브랜치 도입은 2026-06-02 회의에서 검토 예정.
> 도입되면 `main ← dev ← 작업브랜치` 로 전환하고 이 문서 갱신.

### 브랜치명 규칙

```
<type>/<owner>-<short-desc>
```

예시:
- `feat/byeonggun-merge-tool` — 병건이 merge_video tool 구현
- `feat/eunseo-bgm-mixer` — 은서가 BGM mixer 구현
- `feat/eunchae-auto-subtitle` — 은채가 자동 자막 구현
- `feat/seongmin-streaming-api` — 성민이 WebSocket 스트리밍
- `fix/<owner>-<desc>` — 버그 수정
- `refactor/<owner>-<desc>` — 리팩터
- `chore/<owner>-<desc>` — 잡일

### 작업 시작

```bash
git checkout main
git pull origin main
git checkout -b feat/<본인>-<설명>
# 작업 ...
git add <본인 파일들>
git commit -m "feat: ..."
git push -u origin feat/<본인>-<설명>
# GitHub 에서 PR (base=main) 만들고 다른 팀원에게 review 요청
```

### Commit 메시지

영어, Conventional Commits.

- `feat: add merge_video tool`
- `fix: handle empty transcript in audio_expert`
- `refactor: split prompt_builder helpers`
- `docs: update edit_expert AGENTS.md`

---

## 4. 신규 Tool 추가 흐름 (충돌 회피의 핵심)

`agent/tools/__init__.py` 가 가장 충돌나기 쉬운 파일이다. 다음 룰 지켜라.

### Step 1 — 본인 tool 파일 만들기

```python
# agent/tools/<본인이름>_<기능>.py
from langchain_core.tools import tool

@tool
def my_new_tool(arg: str) -> str:
    """tool 설명 (LLM 이 읽음)."""
    return "result"

TOOLS = [my_new_tool]  # 파일 끝에 노출
```

### Step 2 — `agent/tools/__init__.py` 의 **본인 줄만** 추가

```python
# ===== IMPORTS (각자 본인 파일만 추가) =====
from agent.tools.scene import TOOLS as scene_tools
from agent.tools.cut import TOOLS as cut_tools
from agent.tools.transcribe import TOOLS as transcribe_tools
from agent.tools.tts import TOOLS as tts_tools
from agent.tools.video_analysis import TOOLS as video_analysis_tools
from agent.tools.video_understanding_eun import TOOLS as video_understanding_tools
from agent.tools.<본인_파일> import TOOLS as <본인>_tools  # ← 이 한 줄만 추가
# ===========================================
```

그리고 본인의 sub-agent group 에 등록.

```python
tool_groups = {
    "edit": [*cut_tools, *<병건의 새 tools>],
    "audio": [*transcribe_tools, *tts_tools, *<은서/은채의 새 tools>],
    ...
}
```

### Step 3 — 본인 sub_agents/<role>/TOOLS.md 업데이트

해당 tool 의 시그니처 / 설명을 추가. Supervisor 가 이걸 읽고 위임 판단.

---

## 5. Sub-Agent 본인 영역 작업

각 sub-agent 의 *system prompt* 는 다음 3 파일에서 자동 조립됨.

```
agent/sub_agents/<role>/
  SOUL.md     ← 페르소나
  AGENTS.md   ← 행동 룰
  TOOLS.md    ← 보유 도구
```

수정하면 *다음 graph build 부터 즉시 반영*. 캐시 mtime 기반이라 자동 invalidate.

### 자기 sub-agent 디버그

```python
from agent.sub_agent import SubAgentEnvelope, spawn_sub_agent

env = SubAgentEnvelope(
    role="edit_expert",  # 본인 role
    task="videos/raw/sample.mp4 의 5~10 초를 cut 해서 videos/out/clip.mp4 로 저장",
)
result = spawn_sub_agent(env)
print(result.as_tool_result_text())
```

---

## 6. PR 흐름

1. 본인 브랜치에서 작업 + commit + push.
2. GitHub 에서 PR 만듦 (base = `main`).
3. PR 본문에 `Closes #<이슈번호>` (있으면).
4. **다른 팀원 1 명 이상 review** — 솔로 self-approve X.
5. 머지 후 본인 브랜치 삭제 (`git branch -d feat/...`, `git push origin --delete feat/...`).

### PR 본문 템플릿

```markdown
## 변경 사항
- ...

## 테스트 방법
- ...

## 영향 범위
- 본인 sub_agents/<role>/ + tools/<본인 파일>
- (있으면) agent/tools/__init__.py 의 본인 import 줄

## 체크리스트
- [ ] 본인 폴더만 수정
- [ ] smoke test 통과
- [ ] TOOLS.md 갱신 (새 tool 추가 시)
```

---

## 7. 충돌 가능 zone (주의)

| 파일 / 폴더                       | 충돌 위험 | 룰                                                    |
|-----------------------------------|-----------|-------------------------------------------------------|
| `agent/tools/__init__.py`         | **높음**  | 본인 import 줄만. tool_groups 본인 그룹만.            |
| `agent/workspace/*.md`            | 중간      | 성민 우선. 수정 필요하면 PR comment 로 요청.          |
| `agent/graph.py`                  | 중간      | 성민 영역. sub-agent owner 는 수정 X.                 |
| `agent/prompt_builder.py`         | 낮음      | 성민 영역.                                            |
| `agent/sub_agents/<자기>/*`       | **0**     | 본인만 만짐.                                          |
| `agent/tools/<자기>_*.py`         | **0**     | 본인만 만짐.                                          |
| `agent/effects/`                  | 낮음      | 병건 owner (effect 카탈로그). 새 패턴 추가는 PR.       |
| `remotion/`                       | 낮음      | 병건 owner. Remotion 컴포넌트는 `src/effects/*.tsx`.   |
| `assets/tts_voices.json`          | 낮음      | 은서 owner. 새 voice 추가는 PR.                       |

---

## 8. 자주 묻는 질문

**Q. 다른 사람 sub-agent 의 tool 을 내 작업에서 쓰고 싶다.**
A. 그 sub-agent 를 *spawn 으로 부르면 된다*. 직접 import 하지 말 것. (격리 원칙)

**Q. 내 sub-agent 에 새 tool 을 등록하고 싶은데 다른 사람 폴더의 tool 을 같이 묶고 싶다.**
A. `tool_groups` 는 그룹 단위 정의. 다른 사람 tool 을 본인 그룹에 끌어오는 건 *피하기*.
필요하면 PR 로 협의.

**Q. graph 흐름을 바꾸고 싶다.**
A. 성민에게 PR comment / Issue. 본인이 직접 graph.py 수정 X.

**Q. 모델을 바꾸고 싶다 (Gemini → Claude 같은).**
A. `agent/config.py` 의 `MODEL_*` 환경변수. 본인 로컬은 자유, 팀 default 변경은 PR.

---

## 9. 다음 마일스톤 (이 문서 시점 기준)

- **2026-05-31** : 각자 sub-agent 1차 구현 완료 (smoke test 통과 수준)
- **2026-06-02 16:30** : 디스코드 비대면 회의 — 통합 데모 + 문제 공유
- 이후 일정: CLAUDE.md 의 Phase 2 / Phase 3 일정 참조
