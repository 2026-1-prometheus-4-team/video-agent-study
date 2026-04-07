"""
영상 자르기 Tool (병건)

TODO
- FFmpeg 로 실제 cut 구현
- start, end 시간 받아서 새 파일로 출력
"""

import json
import logging
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


@tool
def cut_video(file_path: str, start: float, end: float) -> str:
    """영상 파일에서 특정 구간(start ~ end 초)을 잘라내 새 파일로 저장.

    Args:
        file_path: 원본 영상 경로
        start: 시작 시간(초)
        end: 끝 시간(초)
    """
    logger.info(f"cut_video 호출 - {file_path} [{start} ~ {end}]")
    # TODO: FFmpeg subprocess 호출로 교체
    return json.dumps({
        "input": file_path,
        "start": start,
        "end": end,
        "output": "cut_dummy.mp4",
        "status": "dummy",
    })


TOOLS = [cut_video]
