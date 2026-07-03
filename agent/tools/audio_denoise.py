"""Noise-reduction tool for audio_expert."""

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
def denoise(audio_path: str, output_path: str = "") -> str:
    """Apply lightweight FFmpeg noise reduction.

    Args:
        audio_path: Input audio or video path.
        output_path: Optional output path.
    """
    try:
        audio = resolve_input_path(audio_path)
        output = resolve_output_path(output_path, "denoised", audio.suffix)
        ensure_parent(output)
        run_ffmpeg("-i", str(audio), "-af", "afftdn=nf=-25", "-y", str(output))
        return json.dumps(
            {"status": "success", "output": str(output)},
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [denoise]
