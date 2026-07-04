"""Sound-effect tool for audio_expert."""

from __future__ import annotations

import json

from langchain_core.tools import tool

from agent.tools.audio_common import (
    ensure_parent,
    resolve_input_path,
    resolve_output_path,
    run_ffmpeg,
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


TOOLS = [add_sfx]
