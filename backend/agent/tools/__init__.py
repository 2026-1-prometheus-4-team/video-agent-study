"""Tool registry for the main agent and sub-agents.

새 tool 파일 추가하는 방법
1. agent/tools/내이름.py 생성
2. 해당 파일 안에서 @tool 데코레이터로 함수 정의
3. 파일 마지막에 TOOLS = [내함수1, 내함수2] 리스트 노출
4. 이 파일 아래 IMPORTS 섹션에 한 줄 추가

PR 시 충돌 가능성 큰 파일이므로 본인 import 줄만 깔끔하게 추가.
"""

# ===== IMPORTS (각자 본인 파일만 추가) =====
from agent.tools.scene import TOOLS as scene_tools
from agent.tools.edit import TOOLS as edit_tools
from agent.tools.generate_bgm import TOOLS as generate_bgm_tools
from agent.tools.audio_denoise import TOOLS as audio_denoise_tools
from agent.tools.audio_mix import TOOLS as audio_mix_tools
from agent.tools.audio_normalize import TOOLS as audio_normalize_tools
from agent.tools.bgm import TOOLS as bgm_tools
from agent.tools.sfx import TOOLS as sfx_tools
from agent.tools.transcribe import TOOLS as transcribe_tools
from agent.tools.tts import TOOLS as tts_tools
from agent.tools.video_analysis import TOOLS as video_analysis_tools
from agent.tools.video_understanding_eun import TOOLS as video_understanding_tools
from agent.tools.remotion_render import TOOLS as remotion_tools
from agent.tools.research_llm import TOOLS as research_llm_tools
from agent.tools.research_external import TOOLS as research_external_tools
from agent.tools.subtitle import TOOLS as subtitle_tools
from agent.tools.subtitle_cues import TOOLS as subtitle_cues_tools
# ===========================================


tools = [
    *scene_tools,
    *edit_tools,
    *transcribe_tools,
    *tts_tools,
    *generate_bgm_tools,
    *bgm_tools,
    *sfx_tools,
    *audio_mix_tools,
    *audio_denoise_tools,
    *audio_normalize_tools,
    *video_analysis_tools,
    *video_understanding_tools,
    *remotion_tools,
    *research_llm_tools,
    *research_external_tools,
    *subtitle_tools,
    *subtitle_cues_tools,
]

tool_map = {t.name: t for t in tools}

tool_groups = {
    "edit": [*edit_tools],
    "audio": [
        *transcribe_tools,
        *tts_tools,
        *generate_bgm_tools,
        *bgm_tools,
        *sfx_tools,
        *audio_mix_tools,
        *audio_denoise_tools,
        *audio_normalize_tools,
    ],
    "text": [*subtitle_tools, *subtitle_cues_tools],
    "effect": [*remotion_tools],
    "analysis": [
        *scene_tools,
        *video_understanding_tools,
        *video_analysis_tools,
    ],
    "research": [
        *research_llm_tools,
        *research_external_tools,
    ],
}