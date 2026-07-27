"""Background-music tool for audio_expert."""

from __future__ import annotations

import json

from langchain_core.tools import tool

from agent.tools.audio_common import (
    copy_video_sidecars,
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
    ducking_source_path: str = "",
    narration_path: str = "",
    narration_volume: float = 1.0,
    ducking_threshold: float = 0.015,
    ducking_ratio: float = 12.0,
    output_path: str = "",
    target_lufs: float = -14.0,
) -> str:
    """Add looping BGM while preserving the original video audio.

    Args:
        video_path: Input video path. The original audio is preserved.
        bgm_path: Background-music audio path.
        volume: BGM volume before ducking.
        ducking: Apply speech-aware attenuation. Defaults to true.
        ducking_source_path: Optional narration/dialogue-only audio path to drive ducking.
            When omitted, narration_path is used if provided; otherwise the input video's
            original audio is used as the sidechain source.
        narration_path: Optional TTS/narration audio path to mix into the final video.
        narration_volume: Narration volume before final mix.
        ducking_threshold: Sidechain threshold. Lower values make ducking react to quieter speech.
        ducking_ratio: Compression ratio for ducking. Higher values lower BGM more strongly.
        output_path: Optional output video path.
        target_lufs: Final loudness target. Use -16 for shorts.
    """
    try:
        video = resolve_input_path(video_path)
        bgm = resolve_input_path(bgm_path)
        narration = resolve_input_path(narration_path) if narration_path else None
        ducking_source = (
            resolve_input_path(ducking_source_path)
            if ducking_source_path
            else narration
        )
        output = resolve_output_path(output_path, "bgm", video.suffix)
        ensure_parent(output)

        ffmpeg_args = [
            "-i",
            str(video),
            "-stream_loop",
            "-1",
            "-i",
            str(bgm),
        ]
        next_input_index = 2
        narration_label = None
        detector_label = "0:a"

        if narration:
            narration_label = f"{next_input_index}:a"
            ffmpeg_args.extend(["-i", str(narration)])
            next_input_index += 1

        if ducking_source:
            if narration and ducking_source == narration:
                detector_label = narration_label or "0:a"
            else:
                detector_label = f"{next_input_index}:a"
                ffmpeg_args.extend(["-i", str(ducking_source)])
                next_input_index += 1

        narration_filter = ""
        if narration_label:
            narration_filter = f"[{narration_label}]volume={narration_volume}[narration];"

        if ducking:
            mix_inputs = "[0:a][ducked]"
            mix_count = 2
            if narration_label:
                mix_inputs += "[narration]"
                mix_count += 1
            audio_filter = (
                f"[1:a]volume={volume}[bgm];"
                f"[bgm][{detector_label}]sidechaincompress="
                f"threshold={ducking_threshold}:"
                f"ratio={ducking_ratio}:"
                "attack=10:release=500[ducked];"
                f"{narration_filter}"
                f"{mix_inputs}amix=inputs={mix_count}:duration=first:normalize=0,"
                f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11[mix]"
            )
        else:
            mix_inputs = "[0:a][bgm]"
            mix_count = 2
            if narration_label:
                mix_inputs += "[narration]"
                mix_count += 1
            audio_filter = (
                f"[1:a]volume={volume}[bgm];"
                f"{narration_filter}"
                f"{mix_inputs}amix=inputs={mix_count}:duration=first:normalize=0,"
                f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11[mix]"
            )

        ffmpeg_args.extend(
            [
                "-filter_complex",
                audio_filter,
                "-map",
                "0:v?",
                "-map",
                "[mix]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                "-shortest",
                "-y",
                str(output),
            ]
        )

        run_ffmpeg(*ffmpeg_args)
        copy_video_sidecars(video, output)
        lufs = measure_lufs(output)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "LUFS": lufs,
                "ducking_applied": ducking,
                "ducking_source": str(ducking_source) if ducking_source else "video_audio",
                "narration_mixed": bool(narration),
                "narration": str(narration) if narration else None,
                "ducking_threshold": ducking_threshold,
                "ducking_ratio": ducking_ratio,
                "report": (
                    f"output: {output}, LUFS: {lufs}, "
                    f"ducking_applied: {str(ducking).lower()}, "
                    f"ducking_source: {ducking_source if ducking_source else 'video_audio'}, "
                    f"narration_mixed: {str(bool(narration)).lower()}, "
                    f"ducking_threshold: {ducking_threshold}, "
                    f"ducking_ratio: {ducking_ratio}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [add_bgm]
