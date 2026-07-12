"""Audio replacement and overlay tool for audio_expert."""

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
def mix_audio(
    video_path: str,
    audio_path: str,
    mode: str = "overlay",
    output_path: str = "",
) -> str:
    """Mix audio into video using replace or overlay mode.

    Args:
        video_path: Input video path.
        audio_path: Audio track path.
        mode: replace or overlay.
        output_path: Optional output video path.
    """
    try:
        video = resolve_input_path(video_path)
        audio = resolve_input_path(audio_path)
        output = resolve_output_path(output_path, "mixed_audio", video.suffix)
        ensure_parent(output)

        if mode == "replace":
            run_ffmpeg(
                "-i", str(video), "-i", str(audio),
                "-map", "0:v?", "-map", "1:a",
                "-c:v", "copy", "-shortest", "-y", str(output),
            )
        elif mode == "overlay":
            run_ffmpeg(
                "-i", str(video), "-i", str(audio),
                "-filter_complex",
                "[0:a][1:a]amix=inputs=2:duration=first:normalize=0[mix]",
                "-map", "0:v?", "-map", "[mix]",
                "-c:v", "copy", "-y", str(output),
            )
        else:
            raise ValueError("mode must be replace or overlay")

        return json.dumps(
            {"status": "success", "output": str(output), "mode": mode},
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [mix_audio]
