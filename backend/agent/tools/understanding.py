"""
Video frame understanding tool.

Usage:
    python understanding.py path/to/video.mp4 --output result.json

Requirements:
    pip install openai opencv-python

Environment:
    set OPENAI_API_KEY=your_api_key
"""

from __future__ import annotations
from dotenv import load_dotenv

import argparse
import base64
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env")
DEFAULT_MODEL = "gpt-4.1-mini"


@dataclass(frozen=True)
class FrameSample:
    frame_index: int
    timestamp_sec: float
    image_base64: str


def import_cv2() -> Any:
    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - user environment guard
        raise RuntimeError(
            "opencv-python 패키지가 필요합니다. `pip install opencv-python` 실행 후 다시 시도하세요."
        ) from exc
    return cv2


def import_openai_client() -> Any:
    try:
        from openai import OpenAI
    except ImportError as exc:  # pragma: no cover - user environment guard
        raise RuntimeError(
            "openai 패키지가 필요합니다. `pip install openai` 실행 후 다시 시도하세요."
        ) from exc
    return OpenAI


def encode_frame_to_jpeg_base64(frame: Any, jpeg_quality: int) -> str:
    cv2 = import_cv2()
    encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_quality]
    ok, buffer = cv2.imencode(".jpg", frame, encode_params)
    if not ok:
        raise ValueError("프레임을 JPEG로 인코딩하지 못했습니다.")
    return base64.b64encode(buffer.tobytes()).decode("utf-8")


def sample_video_frames(
    video_path: Path,
    every_seconds: float,
    max_frames: int | None,
    jpeg_quality: int,
) -> tuple[list[FrameSample], dict[str, Any]]:
    cv2 = import_cv2()

    if not video_path.exists():
        raise FileNotFoundError(f"영상 파일을 찾을 수 없습니다: {video_path}")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise ValueError(f"영상 파일을 열 수 없습니다: {video_path}")

    fps = capture.get(cv2.CAP_PROP_FPS) or 0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration_sec = frame_count / fps if fps else 0

    if fps <= 0:
        capture.release()
        raise ValueError("영상 FPS 정보를 읽을 수 없어 프레임 샘플링을 진행할 수 없습니다.")

    step_frames = max(1, int(round(fps * every_seconds)))
    samples: list[FrameSample] = []

    frame_index = 0
    while True:
        if max_frames is not None and len(samples) >= max_frames:
            break

        capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
        ok, frame = capture.read()
        if not ok:
            break

        timestamp_sec = frame_index / fps
        samples.append(
            FrameSample(
                frame_index=frame_index,
                timestamp_sec=round(timestamp_sec, 3),
                image_base64=encode_frame_to_jpeg_base64(frame, jpeg_quality),
            )
        )
        frame_index += step_frames

        if frame_count and frame_index >= frame_count:
            break

    capture.release()

    metadata = {
        "file_name": video_path.name,
        "fps": round(fps, 3),
        "frame_count": frame_count,
        "duration_sec": round(duration_sec, 3),
        "width": width,
        "height": height,
        "sample_every_seconds": every_seconds,
        "sampled_frame_count": len(samples),
    }
    return samples, metadata


def parse_json_response(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        stripped = "\n".join(lines[1:-1]).strip()
    return json.loads(stripped)


class VideoUnderstandingTool:
    def __init__(self, model: str = DEFAULT_MODEL) -> None:
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError("OPENAI_API_KEY 환경 변수가 설정되어 있지 않습니다.")
        openai_client = import_openai_client()
        self.client = openai_client()
        self.model = model

    def describe_frame(self, sample: FrameSample) -> dict[str, Any]:
        prompt = f"""
아래 영상 프레임을 한국어로 분석하세요.

반드시 JSON 객체 하나만 반환하세요. 마크다운, 설명 문장, 코드블록은 쓰지 마세요.
추측은 최소화하고, 보이는 내용만 작성하세요.

필수 JSON 형식:
{{
  "frame_index": {sample.frame_index},
  "timestamp_sec": {sample.timestamp_sec},
  "description_ko": "프레임 전체 상황을 1~3문장으로 설명",
  "scene_ko": "장소나 배경",
  "objects_ko": ["보이는 주요 사물 또는 인물"],
  "actions_ko": ["보이는 행동이나 움직임"],
  "text_ko": ["프레임 안에 보이는 글자. 없으면 빈 배열"],
  "visual_details_ko": ["색상, 구도, 표정, 상태 등 중요한 시각 정보"],
  "confidence": 0.0
}}

confidence는 0부터 1 사이 숫자로 작성하세요.
""".strip()

        response = self.client.responses.create(
            model=self.model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {
                            "type": "input_image",
                            "image_url": f"data:image/jpeg;base64,{sample.image_base64}",
                        },
                    ],
                }
            ],
        )
        return parse_json_response(response.output_text)

    def describe_video(
        self,
        video_path: Path,
        every_seconds: float,
        max_frames: int | None,
        jpeg_quality: int,
    ) -> dict[str, Any]:
        samples, metadata = sample_video_frames(
            video_path=video_path,
            every_seconds=every_seconds,
            max_frames=max_frames,
            jpeg_quality=jpeg_quality,
        )
        frames = [self.describe_frame(sample) for sample in samples]
        return {
            "video": metadata,
            "frames": frames,
        }


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("0보다 큰 숫자를 입력하세요.")
    return parsed


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("0보다 큰 정수를 입력하세요.")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="영상을 샘플링해 각 프레임 내용을 한국어 JSON으로 설명합니다."
    )
    parser.add_argument("video", type=Path, help="분석할 영상 파일 경로")
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="결과 JSON 저장 경로. 생략하면 표준 출력으로 출력합니다.",
    )
    parser.add_argument(
        "--every-seconds",
        type=positive_float,
        default=1.0,
        help="몇 초마다 프레임을 하나씩 분석할지 지정합니다. 기본값: 1.0",
    )
    parser.add_argument(
        "--max-frames",
        type=positive_int,
        default=None,
        help="분석할 최대 프레임 수. 생략하면 끝까지 샘플링합니다.",
    )
    parser.add_argument(
        "--jpeg-quality",
        type=positive_int,
        default=85,
        help="모델에 보낼 프레임 JPEG 품질. 기본값: 85",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"사용할 비전 지원 모델. 기본값: {DEFAULT_MODEL}",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    if args.jpeg_quality > 100:
        raise SystemExit("--jpeg-quality는 1부터 100 사이여야 합니다.")

    try:
        tool = VideoUnderstandingTool(model=args.model)
        result = tool.describe_video(
            video_path=args.video,
            every_seconds=args.every_seconds,
            max_frames=args.max_frames,
            jpeg_quality=args.jpeg_quality,
        )
    except Exception as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1

    json_text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json_text + "\n", encoding="utf-8")
        print(f"결과를 저장했습니다: {args.output}")
    else:
        print(json_text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())