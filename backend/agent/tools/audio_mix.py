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
    at_time_ms: int = 0,
    original_volume: float = 0.85,
    overlay_volume: float = 1.0,
) -> str:
    """Mix audio into video using replace or overlay mode.

    Args:
        video_path: Input video path.
        audio_path: Audio track path.
        mode: replace or overlay.
        output_path: Optional output video path.
        at_time_ms: Overlay mode only - delay the audio track by this many
            milliseconds so it starts at that point in the video (adelay).
            Ignored in replace mode.
        original_volume: Original video audio gain in overlay mode (0.0-2.0).
        overlay_volume: Added narration/audio gain in overlay mode (0.0-2.0).
    """
    try:
        video = resolve_input_path(video_path)
        audio = resolve_input_path(audio_path)
        output = resolve_output_path(output_path, "mixed_audio", video.suffix)
        ensure_parent(output)

        # A narration track must never silently erase the source video's sound.
        # Older plans sometimes emitted mode="replace" for narration.mp3.
        if mode == "replace" and "narration" in audio.stem.lower():
            mode = "overlay"

        if mode == "replace":
            run_ffmpeg(
                "-i", str(video), "-i", str(audio),
                "-map", "0:v?", "-map", "1:a",
                "-c:v", "copy", "-shortest", "-y", str(output),
            )
        elif mode == "overlay":
            delay = max(0, int(at_time_ms))
            source_gain = min(2.0, max(0.0, float(original_volume)))
            added_gain = min(2.0, max(0.0, float(overlay_volume)))
            if delay > 0:
                # all=1: 채널 수와 무관하게 모든 채널을 같은 값으로 지연.
                # "{delay}|{delay}" 형태는 앞 2채널만 지연시켜 5.1 등 다채널
                # 오디오에서 나머지 채널이 어긋난다.
                audio_filter = (
                    f"[0:a]volume={source_gain}[src];"
                    f"[1:a]volume={added_gain},adelay={delay}:all=1[ovl];"
                    "[src][ovl]amix=inputs=2:duration=first:normalize=0,"
                    "alimiter=limit=0.95[mix]"
                )
            else:
                audio_filter = (
                    f"[0:a]volume={source_gain}[src];"
                    f"[1:a]volume={added_gain}[ovl];"
                    "[src][ovl]amix=inputs=2:duration=first:normalize=0,"
                    "alimiter=limit=0.95[mix]"
                )
            run_ffmpeg(
                "-i", str(video), "-i", str(audio),
                "-filter_complex", audio_filter,
                "-map", "0:v?", "-map", "[mix]",
                "-c:v", "copy", "-y", str(output),
            )
        else:
            raise ValueError("mode must be replace or overlay")

        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "mode": mode,
                "at_time_ms": max(0, int(at_time_ms)) if mode == "overlay" else 0,
                "original_volume": source_gain if mode == "overlay" else 0,
                "overlay_volume": added_gain if mode == "overlay" else 1,
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [mix_audio]
