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

        # 각 프레임에 타임스탬프를 새겨서 전송 -> Gemini 가 이미지 순서를 세다
        # 어긋나는 정렬 오차 방지 (이미지에 적힌 시간을 직접 읽음)
        total_s = timestamp_ms // 1000
        label = f"[{total_s // 60:02d}:{total_s % 60:02d}]"
        cv2.putText(frame, label, (16, 56), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 10)
        cv2.putText(frame, label, (16, 56), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 255, 255), 4)

        _, buffer = cv2.imencode(".jpg", frame)
        frames.append((timestamp_ms, buffer.tobytes()))
        frame_idx += frame_step

    cap.release()
    return duration_sec, frames


def _build_prompt(timestamps_ms: list[int], interval_sec: float, chunk_end_ms: int) -> str:
    segments_desc = []
    for i, ts in enumerate(timestamps_ms):
        end_ms = timestamps_ms[i + 1] if i + 1 < len(timestamps_ms) else chunk_end_ms
        segments_desc.append(f"  이미지 {i + 1}번째: {ts}ms ~ {end_ms}ms")

    return f"""아래 이미지들은 영상의 {timestamps_ms[0]}ms ~ {chunk_end_ms}ms 구간에서
{interval_sec}초 간격으로 추출한 프레임입니다.

**각 이미지 좌상단에 노란색 [mm:ss] 타임스탬프가 새겨져 있습니다.
장면의 시간을 판단할 때는 반드시 이미지에 새겨진 그 값을 기준으로 하십시오.**

이미지 순서와 타임스탬프 목록:
{chr(10).join(segments_desc)}

각 구간을 분석해서 아래 JSON 형식으로만 응답해줘. 다른 텍스트는 포함하지 말 것.
start_ms / end_ms 는 반드시 위에 적힌 타임스탬프 값만 사용할 것 (임의 값 생성 금지).
이미지에 새겨진 [mm:ss] 와 목록의 ms 값이 일치하는지 확인하며 진행할 것.
모든 이미지 구간을 빠짐없이 커버할 것.

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
  "summary": "<이 구간 한 줄 요약>"
}}"""


def _parse_gemini_response(text: str) -> dict:
    match = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    json_str = match.group(1) if match else text.strip()
    return json.loads(json_str)


# 청크당 최대 프레임 수. 이미지가 너무 많으면 Gemini가 이미지-타임스탬프
# 정렬을 잃고 출력도 잘림 (533장 단일 호출에서 실측 확인). 청크 분할로 방지.
CHUNK_FRAMES = int(os.getenv("ANALYZE_CHUNK_FRAMES", "100"))


@tool
def analyze_video(video_path: str, interval_sec: float = 3.0) -> str:
    """영상을 interval_sec 간격으로 프레임 샘플링하여 시각적 내용 분석 후 JSON 반환.

    각 구간의 장면 설명, 주요 객체, 분위기, 장면 전환 여부를 포함한다.
    프레임이 많으면 청크(기본 100장)로 나눠 Gemini Vision을 여러 번 호출.

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

        n_chunks = (len(frames) + CHUNK_FRAMES - 1) // CHUNK_FRAMES
        logger.info(f"프레임 추출 완료 - {len(frames)}장, 영상 길이 {duration_sec:.1f}s, 청크 {n_chunks}개")

        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            return json.dumps({"error": "GOOGLE_API_KEY 환경변수가 설정되지 않았습니다."}, ensure_ascii=False)

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.5-flash")

        all_segments: list = []
        chunk_summaries: list[str] = []

        for ci in range(0, len(frames), CHUNK_FRAMES):
            chunk = frames[ci:ci + CHUNK_FRAMES]
            timestamps_ms = [ts for ts, _ in chunk]
            # 청크 끝 = 다음 청크 첫 프레임 시각, 마지막 청크면 영상 끝
            if ci + CHUNK_FRAMES < len(frames):
                chunk_end_ms = frames[ci + CHUNK_FRAMES][0]
            else:
                chunk_end_ms = int(duration_sec * 1000)

            prompt = _build_prompt(timestamps_ms, interval_sec, chunk_end_ms)
            parts = [{"mime_type": "image/jpeg", "data": img} for _, img in chunk]
            parts.append(prompt)

            chunk_no = ci // CHUNK_FRAMES + 1
            logger.info(
                f"청크 {chunk_no}/{n_chunks} 분석 중 ({timestamps_ms[0]}ms ~ {chunk_end_ms}ms, {len(chunk)}장)"
            )
            try:
                response = model.generate_content(parts)
                parsed = _parse_gemini_response(response.text)
                all_segments.extend(parsed.get("segments", []))
                if parsed.get("summary"):
                    chunk_summaries.append(parsed["summary"])
            except Exception as e:
                logger.warning(f"청크 {chunk_no} 분석 실패, 건너뜀: {e}")

        if not all_segments:
            return json.dumps({"error": "모든 청크 분석 실패"}, ensure_ascii=False)

        all_segments.sort(key=lambda s: s.get("start_ms", 0))
        scene_changes = [s["start_ms"] for s in all_segments if s.get("scene_change")]

        result = {
            "video_path": video_path,
            "duration": round(duration_sec, 3),
            "frame_count": len(frames),
            "interval_sec": interval_sec,
            "segments": all_segments,
            "scene_changes": scene_changes,
            "summary": " / ".join(chunk_summaries),
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
