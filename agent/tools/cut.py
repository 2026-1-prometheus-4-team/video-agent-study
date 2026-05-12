<<<<<<< HEAD
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
=======
"""
영상 자르기 Tool (병건)

FFmpeg 로 특정 구간(start ~ end 초)을 crop 해서 새 파일로 저장.
영상 파일은 프로젝트 루트의 videos/ 폴더에 위치한다고 가정.
"""

import json
import logging
import os
import subprocess
from langchain_core.tools import tool

logger = logging.getLogger(__name__)

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "videos")

SCENE_MAP = {
    "minecraft.mp4": {
        "space1": (1, 12),
        "space2": (12, 30),
        "space3": (30, 53),
        "space4": (53, 60),
    }
}


@tool
def cut_video(file_path: str, start: float, end: float) -> str:
    """영상 파일에서 특정 구간(start ~ end 초)을 잘라내 새 파일로 저장.

    사용자가 "6초부터 12초 구간 잘라줘" 또는 "자기소개 부분 컷해줘" 처럼
    시작/끝 타임스탬프를 주면 그 구간만 새 파일로 추출.

    Args:
        file_path: 원본 영상 파일명 (예: sample.mp4). videos/ 폴더 기준.
        start: 시작 시간(초)
        end: 끝 시간(초)
    """
    try:
        input_path = os.path.join(VIDEOS_DIR, file_path)

        if not os.path.exists(input_path):
            return json.dumps({"error": f"파일을 찾을 수 없음: {input_path}"}, ensure_ascii=False)

        if start < 0 or end <= start:
            return json.dumps({"error": f"잘못된 타임스탬프: start={start}, end={end}"}, ensure_ascii=False)

        name, ext = os.path.splitext(file_path)
        output_name = f"{name}_cut_{int(start)}_{int(end)}{ext}"
        output_path = os.path.join(VIDEOS_DIR, output_name)

        duration = end - start

        cmd = [
            "ffmpeg", "-y",
            "-i", input_path,
            "-ss", str(start),
            "-t", str(duration),
            "-c", "copy",
            output_path,
        ]

        logger.info(f"cut_video 호출 - {file_path} [{start} ~ {end}]")

        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")

        if result.returncode != 0:
            return json.dumps({"error": result.stderr}, ensure_ascii=False)

        return json.dumps({
            "input": file_path,
            "start": start,
            "end": end,
            "duration": duration,
            "output": output_name,
            "status": "success",
        }, ensure_ascii=False)

    except FileNotFoundError:
        return json.dumps({"error": "FFmpeg 가 설치되어 있지 않습니다. https://ffmpeg.org 에서 설치하세요."}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"cut_video 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@tool
def cut_scene(file_path: str, scene_name: str) -> str:
    """영상에서 장면 이름으로 해당 구간을 잘라내 새 파일로 저장.

    사용자가 "space1 잘라줘", "space2 구간 뽑아줘" 처럼 장면 이름으로 요청할 때 호출.

    Args:
        file_path: 원본 영상 파일명 (예: minecraft.mp4). videos/ 폴더 기준.
        scene_name: 장면 이름 (예: space1, space2, space3, space4)
    """
    try:
        scenes = SCENE_MAP.get(file_path)
        if not scenes:
            return json.dumps({"error": f"{file_path} 의 장면 정보가 없습니다."}, ensure_ascii=False)

        scene = scenes.get(scene_name.lower())
        if not scene:
            available = list(scenes.keys())
            return json.dumps({"error": f"'{scene_name}' 장면을 찾을 수 없습니다. 사용 가능: {available}"}, ensure_ascii=False)

        start, end = scene
        logger.info(f"cut_scene 호출 - {file_path} [{scene_name}] ({start} ~ {end})")
        return cut_video.invoke({"file_path": file_path, "start": start, "end": end})

    except Exception as e:
        logger.error(f"cut_scene 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [cut_video, cut_scene]
>>>>>>> main
