"""Sound-effect tool for audio_expert."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

from langchain_core.tools import tool

from agent.tools.audio_common import (
    ensure_parent,
    resolve_input_path,
    resolve_output_path,
    run_ffmpeg,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT.parent / ".env")
load_dotenv(PROJECT_ROOT / ".env")
SFX_URL = "https://api.elevenlabs.io/v1/sound-generation"


@tool
def generate_sfx(
    text: str,
    duration_seconds: float = 1.5,
    loop: bool = False,
    prompt_influence: float = 0.5,
    output_path: str = "",
) -> str:
    """Generate a sound-effect file with ElevenLabs, then use add_sfx to place it."""
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return json.dumps(
            {"status": "error", "output": None, "error": "ELEVENLABS_API_KEY is required"},
            ensure_ascii=False,
        )
    output = Path(output_path) if output_path else (
        PROJECT_ROOT / "audio_files" / "sfx" / f"generated_sfx_{time.time_ns()}.mp3"
    )
    if not output.is_absolute():
        output = PROJECT_ROOT / output
    output = output.resolve()
    ensure_parent(output)
    payload = {
        "text": text,
        "duration_seconds": min(30.0, max(0.5, float(duration_seconds))),
        "loop": bool(loop),
        "prompt_influence": min(1.0, max(0.0, float(prompt_influence))),
        "model_id": "eleven_text_to_sound_v2",
    }
    try:
        response = requests.post(
            SFX_URL,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            params={"output_format": "mp3_44100_128"},
            json=payload,
            timeout=120,
        )
        if response.status_code >= 400:
            return json.dumps(
                {
                    "status": "error",
                    "output": None,
                    "error": "ElevenLabs sound generation failed",
                    "status_code": response.status_code,
                    "response": response.text[:1200],
                },
                ensure_ascii=False,
            )
        output.write_bytes(response.content)
        return json.dumps(
            {"status": "success", "output": str(output), "description": text},
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps(
            {"status": "error", "output": None, "error": str(error)},
            ensure_ascii=False,
        )


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
        return json.dumps(
            {"status": "success", "output": str(output), "at_time": at_time},
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [generate_sfx, add_sfx]
