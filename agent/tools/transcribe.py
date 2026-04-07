"""
음성 -> 자막 추출 Tool (은서)

TODO
- faster-whisper 로 실제 transcribe 구현
- 결과를 VideoContext.transcript 형식으로 반환
"""

import json
import logging
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


@tool
def transcribe_video(file_path: str) -> str:
    """영상 파일의 음성을 텍스트로 변환하고 타임스탬프 자막을 반환.

    Args:
        file_path: 영상 파일 경로
    """
    logger.info(f"transcribe_video 호출 - {file_path}")
    # TODO: faster-whisper 로 교체
    return json.dumps({
        "file_path": file_path,
        "transcript": [
            {"start": 0.0, "end": 3.5, "text": "더미 자막입니다"},
            {"start": 3.5, "end": 7.0, "text": "여기를 진짜 결과로 교체하세요"},
        ],
    }, ensure_ascii=False)


TOOLS = [transcribe_video]
