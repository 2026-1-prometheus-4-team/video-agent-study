"""Background-music tool for audio_expert."""

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
def add_bgm(
    video_path: str,
    bgm_path: str,
    volume: float = 0.22,
    ducking: bool = True,
    output_path: str = "",
    target_lufs: float = -14.0,
) -> str:
    """Add looping BGM and duck it automatically while speech is present.

    Args:
        video_path: Input video path.
        bgm_path: Background-music audio path.
        volume: BGM volume before ducking.
        ducking: Apply speech-aware attenuation. Defaults to true.
        output_path: Optional output video path.
        target_lufs: Final loudness target. Use -16 for shorts.
    """
    try:
        video = resolve_input_path(video_path)
        bgm = resolve_input_path(bgm_path)
        output = resolve_output_path(output_path, "bgm", video.suffix)
        ensure_parent(output)

        if ducking:
            audio_filter = (
                f"[1:a]volume={volume}[bgm];"
                "[bgm][0:a]sidechaincompress="
                "threshold=0.04:ratio=10:attack=20:release=350[ducked];"
                "[0:a][ducked]amix=inputs=2:duration=first:normalize=0,"
                f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11[mix]"
            )
        else:
            audio_filter = (
                f"[1:a]volume={volume}[bgm];"
                "[0:a][bgm]amix=inputs=2:duration=first:normalize=0,"
                f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11[mix]"
            )

        run_ffmpeg(
            "-i", str(video),
            "-stream_loop", "-1", "-i", str(bgm),
            "-filter_complex", audio_filter,
            "-map", "0:v?", "-map", "[mix]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest", "-y", str(output),
        )
        lufs = measure_lufs(output)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "LUFS": lufs,
                "ducking_applied": ducking,
                "report": (
                    f"output: {output}, LUFS: {lufs}, "
                    f"ducking_applied: {str(ducking).lower()}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [add_bgm]
