"""
테스트 환경 설정

agent.tools.edit 만 import 해도 agent/__init__.py -> agent.graph 체인이
무거운 패키지들을 당겨옴. sys.modules 에 미리 mock 을 박아서 차단.
"""

import os
import sys
from unittest.mock import MagicMock

# 단위 테스트는 오프라인으로: 임베딩 기반 시맨틱 검색 비활성 (키워드 폴백 사용)
os.environ["EDIT_SEMANTIC_SEARCH"] = "0"

# langchain_google_genai 는 google.genai 네임스페이스를 오염시키므로 통째로 mock
_MOCKS = {
    "langchain_google_genai": MagicMock(),
    "openai": MagicMock(),
    "faster_whisper": MagicMock(),
    "edge_tts": MagicMock(),
    "tavily": MagicMock(),
    "yt_dlp": MagicMock(),
}

for _name, _mock in _MOCKS.items():
    if _name not in sys.modules:
        sys.modules[_name] = _mock
        # submodule 도 같은 mock 으로 연결 (langchain_google_genai._enums 등)
        _mock.__spec__ = None
