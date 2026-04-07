"""
장면 검색 / 영상 메타 조회 (더미)
참고용 예시 - 나중에 Qdrant + ffprobe 로 교체
"""

import json
import logging
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


@tool
def search_scene(query: str) -> str:
    """영상에서 특정 장면을 자연어 쿼리로 검색.

    사용자가 "OO 하는 장면 찾아줘" 라고 할 때 호출.
    Args:
        query: 찾고 싶은 장면을 자연어로 묘사
    """
    logger.info(f"search_scene 호출 - query: {query}")
    return json.dumps({
        "query": query,
        "result": [
            {"start": 10.0, "end": 25.0, "description": f"'{query}' 관련 장면 더미"}
        ]
    }, ensure_ascii=False)


@tool
def get_video_info(file_path: str) -> str:
    """영상 파일의 메타 정보(길이, 해상도, fps)를 조회.

    Args:
        file_path: 영상 파일 경로
    """
    logger.info(f"get_video_info 호출 - file_path: {file_path}")
    return json.dumps({
        "file_path": file_path,
        "duration": 120.0,
        "resolution": "1920x1080",
        "fps": 30,
    })


TOOLS = [search_scene, get_video_info]
