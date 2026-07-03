"""
영상 시각 분석 Tool

OpenCV 로 N초 간격 프레임 추출 -> Gemini Vision 배치 호출 -> 타임스탬프 기반 세그멘테이션 JSON 반환.
텍스트/오디오 분석은 별도 Tool에서 추가 예정.
"""

import json
import logging
import os
import re

import cv2
import google.generativeai as genai
from dotenv import load_dotenv
from langchain_core.tools import tool

load_dotenv()

logger = logging.getLogger(__name__)

VIDEOS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "videos")


def _extract_frames(video_path: str, interval_sec: float) -> tuple[float, list[tuple[int, bytes]]]:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / fps if fps > 0 else 0.0

    frame_step = max(1, int(fps * interval_sec))
    frames = []

    frame_idx = 0
    while frame_idx < total_frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            break
        timestamp_ms = int((frame_idx / fps) * 1000)
        _, buffer = cv2.imencode(".jpg", frame)
        frames.append((timestamp_ms, buffer.tobytes()))
        frame_idx += frame_step

    cap.release()
    return duration_sec, frames


def _build_prompt(timestamps_ms: list[int], interval_sec: float, duration_sec: float) -> str:
    segments_desc = []
    for i, ts in enumerate(timestamps_ms):
        end_ms = timestamps_ms[i + 1] if i + 1 < len(timestamps_ms) else int(duration_sec * 1000)
        segments_desc.append(f"  프레임 {i + 1}: {ts}ms ~ {end_ms}ms")

    return f"""아래 이미지들은 영상에서 {interval_sec}초 간격으로 추출한 프레임입니다.
총 영상 길이: {duration_sec:.1f}초

각 프레임의 구간:
{chr(10).join(segments_desc)}

각 구간을 분석해서 아래 JSON 형식으로만 응답해줘. 다른 텍스트는 포함하지 말 것.

{{
  "segments": [
    {{
      "start_ms": <시작 ms>,
      "end_ms": <끝 ms>,
      "description": "<장면 설명 한국어>",
      "objects": ["<주요 객체>"],
      "scene_change": <true/false>,
      "mood": "<calm|energetic|tense|neutral 중 하나>"
    }}
  ],
  "scene_changes": [<scene_change가 true인 start_ms 목록>],
  "summary": "<전체 영상 한 줄 요약>"
}}"""


def _parse_gemini_response(text: str) -> dict:
    match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    json_str = match.group(1) if match else text.strip()
    return json.loads(json_str)


@tool
def analyze_video(video_path: str, interval_sec: float = 3.0) -> str:
    """영상을 interval_sec 간격으로 프레임 샘플링하여 시각적 내용 분석 후 JSON 반환.

    각 구간의 장면 설명, 주요 객체, 분위기, 장면 전환 여부를 포함한다.
    Gemini Vision에 전체 프레임을 한 번에 배치로 전송하므로 API 호출은 1회.

    Args:
        video_path: 영상 파일명 (예: london.mp4). videos/ 폴더 기준.
        interval_sec: 프레임 샘플링 간격(초). 기본값 3.0. 짧은 영상은 0.5 권장.
    """
    try:
        input_path = os.path.join(VIDEOS_DIR, video_path)
        if not os.path.exists(input_path):
            return json.dumps({"error": f"파일을 찾을 수 없음: {input_path}"}, ensure_ascii=False)

        logger.info(f"analyze_video 호출 - {video_path} (interval={interval_sec}s)")

        duration_sec, frames = _extract_frames(input_path, interval_sec)

        if not frames:
            return json.dumps({"error": "프레임 추출 실패"}, ensure_ascii=False)

        logger.info(f"프레임 추출 완료 - {len(frames)}장, 영상 길이 {duration_sec:.1f}s")

        timestamps_ms = [ts for ts, _ in frames]
        prompt = _build_prompt(timestamps_ms, interval_sec, duration_sec)

        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            return json.dumps({"error": "GOOGLE_API_KEY 환경변수가 설정되지 않았습니다."}, ensure_ascii=False)

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")

        parts = []
        for _, img_bytes in frames:
            parts.append({"mime_type": "image/jpeg", "data": img_bytes})
        parts.append(prompt)

        response = model.generate_content(parts)
        parsed = _parse_gemini_response(response.text)

        result = {
            "video_path": video_path,
            "duration": round(duration_sec, 3),
            "frame_count": len(frames),
            "interval_sec": interval_sec,
            "segments": parsed.get("segments", []),
            "scene_changes": parsed.get("scene_changes", []),
            "summary": parsed.get("summary", ""),
        }

        name = os.path.splitext(video_path)[0]
        output_path = os.path.join(VIDEOS_DIR, f"{name}_analysis.json")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        result["saved_to"] = output_path
        logger.info(f"analyze_video 완료 - segments: {len(result['segments'])}개, 저장: {output_path}")
        return json.dumps(result, ensure_ascii=False)

    except json.JSONDecodeError as e:
        logger.error(f"Gemini 응답 파싱 실패: {e}")
        return json.dumps({"error": f"Gemini 응답 파싱 실패: {e}"}, ensure_ascii=False)
    except Exception as e:
        logger.error(f"analyze_video 오류: {e}")
        return json.dumps({"error": str(e)}, ensure_ascii=False)


TOOLS = [analyze_video]
