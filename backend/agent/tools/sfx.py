"""Sound-effect tools for audio_expert.

add_sfx: 기존 효과음 파일을 특정 시점에 삽입.
generate_sfx: ElevenLabs Sound Effects API 로 자연어 설명을 효과음 mp3 로 생성.
생성된 파일은 generate_bgm 과 동일하게 PROJECT_ROOT/bgm_files 아래 저장된다.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from langchain_core.tools import tool

from agent.tools.audio_common import (
    copy_video_sidecars,
    ensure_parent,
    resolve_input_path,
    resolve_output_path,
    run_ffmpeg,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT.parent / ".env")
load_dotenv(PROJECT_ROOT / ".env")
ELEVENLABS_SFX_URL = "https://api.elevenlabs.io/v1/sound-generation"
_SFX_TIMEOUT_SEC = 120


def _sfx_json_error(message: str, **extra: Any) -> str:
    return json.dumps(
        {"status": "error", "output": None, "error": message, **extra},
        ensure_ascii=False,
    )


def _resolve_sfx_output_path(output_path: str) -> Path:
    if output_path:
        candidate = Path(output_path)
        if not candidate.is_absolute():
            candidate = PROJECT_ROOT / candidate
        return candidate.resolve()
    return PROJECT_ROOT / "bgm_files" / f"sfx_{time.time_ns()}.mp3"


@tool
def add_sfx(
    video_path: str,
    sfx_path: str,
    at_time: float,
    output_path: str = "",
) -> str:
    """Insert a sound effect at a timestamp.

    Args:
        video_path: Input video path.
        sfx_path: Sound-effect audio path.
        at_time: Insert time in seconds.
        output_path: Optional output video path.
    """
    try:
        video = resolve_input_path(video_path)
        sfx = resolve_input_path(sfx_path)
        output = resolve_output_path(output_path, "sfx", video.suffix)
        ensure_parent(output)
        delay_ms = max(0, round(at_time * 1000))
        audio_filter = (
            f"[1:a]adelay={delay_ms}|{delay_ms}[sfx];"
            "[0:a][sfx]amix=inputs=2:duration=first:normalize=0[mix]"
        )
        run_ffmpeg(
            "-i", str(video), "-i", str(sfx),
            "-filter_complex", audio_filter,
            "-map", "0:v?", "-map", "[mix]",
            "-c:v", "copy", "-y", str(output),
        )
        copy_video_sidecars(video, output)
        return json.dumps(
            {"status": "success", "output": str(output), "at_time": at_time},
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


@tool
def generate_sfx(
    description: str,
    output_path: str = "",
    duration_seconds: float | None = None,
    loop: bool = False,
    prompt_influence: float = 0.5,
) -> str:
    """자연어 설명으로 효과음 mp3 를 생성한다 (ElevenLabs Sound Effects API).

    "한숨 소리", "샤라랑 반짝임", "띠로리 실패음", "삐끗" 같은 설명을 mp3 효과음으로
    만든다. 생성된 효과음은 add_sfx(video, sfx_path, at_time) 로 특정 시점에 삽입한다.

    Args:
        description: 만들 효과음의 자연어 설명.
        output_path: 선택. 결과 mp3 경로. 비우면 bgm_files 아래 sfx_<ts>.mp3 로 저장.
        duration_seconds: 선택. 효과음 길이(초). None 이면 API 가 자동 결정.
        loop: 선택. 루프 가능한 효과음으로 생성.
        prompt_influence: 선택. 0~1. 높을수록 설명을 문자 그대로 따른다.
    """
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return _sfx_json_error("ELEVENLABS_API_KEY is required in .env")

    text = (description or "").strip()
    if not text:
        return _sfx_json_error("description is required")

    output = _resolve_sfx_output_path(output_path)
    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    payload: dict[str, Any] = {
        "text": text,
        "loop": bool(loop),
        "prompt_influence": min(1.0, max(0.0, float(prompt_influence))),
        "model_id": "eleven_text_to_sound_v2",
    }
    if duration_seconds is not None:
        payload["duration_seconds"] = min(30.0, max(0.5, float(duration_seconds)))

    try:
        response = requests.post(
            ELEVENLABS_SFX_URL,
            headers=headers,
            json=payload,
            timeout=_SFX_TIMEOUT_SEC,
        )
        if response.status_code >= 400:
            return _sfx_json_error(
                "ElevenLabs Sound Effects API request failed",
                status_code=response.status_code,
                response=response.text,
            )

        ensure_parent(output)
        output.write_bytes(response.content)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "description": text,
                "duration_seconds": duration_seconds,
                "report": (
                    f"output: {output}, description: {text}, "
                    f"duration_seconds: {duration_seconds}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return _sfx_json_error(str(error))


TOOLS = [add_sfx, generate_sfx]
