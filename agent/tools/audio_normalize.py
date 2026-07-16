"""Loudness-normalization tool for audio_expert."""

from __future__ import annotations

import json

from langchain_core.tools import tool

from agent.tools.audio_common import (
    ensure_parent,
    measure_lufs,
    resolve_input_path,
    resolve_output_path,
    run_ffmpeg,
)


@tool
def normalize_loudness(
    path: str,
    target_lufs: float = -14.0,
    output_path: str = "",
) -> str:
    """Normalize loudness. Use -14 LUFS normally and -16 LUFS for shorts.

    Args:
        path: Input audio or video path.
        target_lufs: Target integrated loudness.
        output_path: Optional output path.
    """
    try:
        source = resolve_input_path(path)
        output = resolve_output_path(output_path, "normalized", source.suffix)
        ensure_parent(output)
        run_ffmpeg(
            "-i", str(source),
            "-af", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
            "-y", str(output),
        )
        lufs = measure_lufs(output)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "LUFS": lufs,
                "target_lufs": target_lufs,
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [normalize_loudness]
