"""
영상 이해 Tool (은서)

Gemini 멀티모달 API 로 영상 파일을 업로드해 타임스탬프별 장면 설명을 JSON 으로 반환.
"""

import json
import logging
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from langchain_core.tools import tool

# 스크립트 위치 기준으로 프로젝트 루트의 .env 를 찾음
load_dotenv(Path(__file__).parents[2] / ".env")

logger = logging.getLogger(__name__)

_client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
_MODEL = "gemini-2.5-flash"

_PROMPT = """\
이 영상을 처음부터 끝까지 분석해서 장면(scene) 단위로 분할해줘.
각 장면에 대해 아래 JSON 배열 형식으로만 응답해. 다른 텍스트는 절대 포함하지 마.

[
  {"start": <시작 초(float)>, "end": <종료 초(float)>, "description": "<장면 설명>"},
  ...
]

요구사항:
- 장면이 바뀌는 지점(컷, 분위기 전환, 주제 전환)마다 새 항목으로 분리
- description 은 한국어로, 무엇이 보이고 어떤 상황인지 한 문장으로 작성
- 타임스탬프는 소수점 첫째자리까지 (예: 3.2)
- JSON 배열 이외의 출력 금지
"""


@tool
def analyze_video_scenes(file_path: str) -> str:
    """원본 영상을 Gemini 로 분석해 타임스탬프별 장면 정보를 JSON 으로 반환.

    사용자가 "영상 분석해줘", "장면 목록 알려줘", "어떤 장면 있어?" 등을 요청할 때 호출.

    Args:
        file_path: 분석할 영상 파일 경로 (로컬 경로, mp4/mov/avi 등)

    Returns:
        JSON 문자열 - start(초), end(초), description 을 가진 장면 리스트
        예: [{"start": 0.0, "end": 5.3, "description": "인물이 카메라를 향해 걷는 장면"}, ...]
    """
    raw = ""
    try:
        if not os.path.exists(file_path):
            return json.dumps({"error": f"파일을 찾을 수 없음: {file_path}"}, ensure_ascii=False)

        logger.info(f"영상 업로드 시작: {file_path}")
        # 한글 경로 인코딩 문제를 피하기 위해 바이너리로 직접 열어서 전달
        with open(file_path, "rb") as f:
            video_file = _client.files.upload(
                file=f,
                config={"mime_type": "video/mp4", "display_name": Path(file_path).name},
            )

        while video_file.state.name == "PROCESSING":
            time.sleep(3)
            video_file = _client.files.get(name=video_file.name)

        if video_file.state.name != "ACTIVE":
            return json.dumps(
                {"error": f"파일 처리 실패: {video_file.state.name}"},
                ensure_ascii=False,
            )

        logger.info("업로드 완료, Gemini 장면 분석 시작")
        response = _client.models.generate_content(
            model=_MODEL,
            contents=[video_file, _PROMPT],
        )

        raw = response.text.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        scenes = json.loads(raw)
        logger.info(f"분석 완료: {len(scenes)}개 장면")
        return json.dumps(scenes, ensure_ascii=False, indent=2)

    except json.JSONDecodeError as e:
        logger.error(f"JSON 파싱 실패: {e} | 원본 응답: {raw}")
        return json.dumps({"error": "Gemini 응답 파싱 실패", "raw": raw}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"analyze_video_scenes 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [analyze_video_scenes]


if __name__ == "__main__":
    import sys

    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")

    video_path = sys.argv[1] if len(sys.argv) > 1 else r"agent\sample.py\짱구야.mp4"
    print(f"분석 대상: {video_path}\n")

    result = analyze_video_scenes.invoke({"file_path": video_path})
    data = json.loads(result)

    if isinstance(data, list):
        print(f"총 {len(data)}개 장면\n")
        for i, scene in enumerate(data, 1):
            print(f"[{i:02d}] {scene['start']}s ~ {scene['end']}s")
            print(f"      {scene['description']}")
    else:
        print("오류:", data)
