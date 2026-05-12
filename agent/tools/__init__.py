<<<<<<< HEAD
"""
Tool 자동 수집 모듈

새 tool 파일 추가하는 방법
1. agent/tools/내이름.py 생성
2. 해당 파일 안에서 @tool 데코레이터로 함수 정의
3. 파일 마지막에 TOOLS = [내함수1, 내함수2] 리스트 노출
4. 이 파일 아래 IMPORTS 섹션에 한 줄 추가

이 파일에서 충돌 가능성이 있으니 PR 시 주의
"""

# ===== IMPORTS (각자 본인 파일만 추가) =====
from agent.tools.scene import TOOLS as scene_tools
from agent.tools.cut import TOOLS as cut_tools
from agent.tools.transcribe import TOOLS as transcribe_tools
from agent.tools.tts import TOOLS as tts_tools
# ===========================================

tools = [
    *scene_tools,
    *cut_tools,
    *transcribe_tools,
    *tts_tools,
]

tool_map = {t.name: t for t in tools}
=======
"""
Tool 자동 수집 모듈

새 tool 파일 추가하는 방법
1. agent/tools/내이름.py 생성
2. 해당 파일 안에서 @tool 데코레이터로 함수 정의
3. 파일 마지막에 TOOLS = [내함수1, 내함수2] 리스트 노출
4. 이 파일 아래 IMPORTS 섹션에 한 줄 추가

이 파일에서 충돌 가능성이 있으니 PR 시 주의
"""

# ===== IMPORTS (각자 본인 파일만 추가) =====
from agent.tools.scene import TOOLS as scene_tools
from agent.tools.cut import TOOLS as cut_tools
from agent.tools.transcribe import TOOLS as transcribe_tools
from agent.tools.tts import TOOLS as tts_tools
from agent.tools.video_analysis import TOOLS as video_analysis_tools
from agent.tools.video_understanding_eun import TOOLS as video_understanding_tools
# ===========================================

# --- 전체 tool 리스트 (하위 호환) ---
tools = [
    *scene_tools,
    *cut_tools,
    *transcribe_tools,
    *tts_tools,
    *video_analysis_tools,
    *video_understanding_tools,
]

tool_map = {t.name: t for t in tools}

# --- Agent 도메인별 그룹 ---
# graph.py 에서 각 sub-agent 에 할당할 때 사용
# 새 도메인 tool 추가 시 해당 그룹에 등록
tool_groups = {
    "edit": [*cut_tools],
    "audio": [*transcribe_tools, *tts_tools],
    "text": [],       # TODO: subtitle, caption tool 추가 시
    "effect": [],     # TODO: fade, transition tool 추가 시
    "analysis": [*scene_tools, *video_understanding_tools],
    "research": [],   # TODO: web_search, trend tool 추가 시
}
>>>>>>> main
