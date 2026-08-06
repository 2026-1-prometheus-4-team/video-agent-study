"""Background-music tool for audio_expert."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from langchain_core.tools import tool

from agent.tools.audio_common import (
    copy_video_sidecars,
    detect_voice_activity,
    ensure_parent,
    measure_lufs,
    measure_lufs_intervals,
    probe_duration,
    resolve_input_path,
    resolve_output_path,
    run_ffmpeg,
)

# add_bgm_progression 이 재사용하는 기본값 (add_bgm 의 기본값과 동일하게 맞춤)
_DEFAULT_BGM_VOLUME = 1.0
_DEFAULT_SPEECH_TARGET_LUFS = -16.0
_DEFAULT_BGM_OFFSET_LU = 6.0
_DEFAULT_DUCK_THRESHOLD = 0.03
_DEFAULT_DUCK_RATIO = 4.0
_DEFAULT_TARGET_LUFS = -16.0
_DEFAULT_FINAL_TOLERANCE_LU = 1.0
_DEFAULT_MAX_CORRECTION_DB = 3.0
_SUBTITLES_DIR = Path(__file__).resolve().parents[2] / "videos" / "subtitles"


def _bounded(value: float, minimum: float, maximum: float, name: str) -> float:
    number = float(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return number


def _mix_verification(output, measured_lufs: float | None) -> tuple[bool, str]:
    verified = output.exists() and output.stat().st_size > 0 and measured_lufs is not None
    if verified:
        return True, "BGM was rendered into the output audio stream and the result was measurable."
    return False, "The output could not be verified as a measurable audio mix."


def _apply_limited_final_correction(
    output: Path,
    *,
    target_lufs: float,
    tolerance_lu: float,
    max_correction_db: float,
) -> tuple[float | None, float]:
    """Measure the mix and apply only a small, bounded gain correction."""
    measured = measure_lufs(output)
    if measured is None:
        return None, 0.0

    requested_gain = float(target_lufs) - measured
    if abs(requested_gain) <= float(tolerance_lu):
        return measured, 0.0

    applied_gain = max(
        -float(max_correction_db),
        min(float(max_correction_db), requested_gain),
    )
    corrected = output.with_name(f"{output.stem}.loudness_tmp{output.suffix}")
    run_ffmpeg(
        "-i", str(output),
        "-map", "0:v?", "-map", "0:a",
        "-c:v", "copy",
        "-af", f"volume={applied_gain:.3f}dB,alimiter=limit=0.95",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart", "-y", str(corrected),
    )
    corrected.replace(output)
    return measure_lufs(output), round(applied_gain, 3)


def _read_transcript_segments(source: Path) -> list[tuple[float, float]]:
    cache = _SUBTITLES_DIR / f"{source.stem}.json"
    try:
        payload = json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return []
    intervals: list[tuple[float, float]] = []
    for segment in payload.get("segments", []):
        try:
            start = max(0.0, float(segment["start"]) - 0.12)
            end = max(start, float(segment["end"]) + 0.18)
        except (KeyError, TypeError, ValueError):
            continue
        if end > start and str(segment.get("text", "")).strip():
            intervals.append((start, end))
    return intervals


def _speech_intervals(video: Path) -> list[tuple[float, float]]:
    direct = _read_transcript_segments(video)
    if direct:
        return direct

    origin_path = Path(f"{video}.origin.json")
    try:
        origin = json.loads(origin_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return []

    mapped: list[tuple[float, float]] = []
    for clip in origin.get("clips", []):
        try:
            source = Path(str(clip["source"]))
            clip_start = float(clip["start_ms"]) / 1000.0
            clip_end = float(clip["end_ms"]) / 1000.0
            output_offset = float(clip["offset_ms"]) / 1000.0
        except (KeyError, TypeError, ValueError):
            continue
        for start, end in _read_transcript_segments(source):
            overlap_start = max(start, clip_start)
            overlap_end = min(end, clip_end)
            if overlap_end > overlap_start:
                mapped.append((
                    output_offset + overlap_start - clip_start,
                    output_offset + overlap_end - clip_start,
                ))

    mapped.sort()
    merged: list[tuple[float, float]] = []
    for start, end in mapped:
        if merged and start <= merged[-1][1] + 0.08:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _ensure_speech_intervals(
    video: Path,
) -> tuple[list[tuple[float, float]], str | None, str]:
    intervals = _speech_intervals(video)
    if intervals:
        return intervals, None, "transcript_timestamps"
    transcription_error: str | None = None
    try:
        from agent.tools.transcribe import transcribe_video

        result = json.loads(transcribe_video.invoke({
            "video_path": str(video),
            "polish": False,
        }))
    except Exception as error:
        result = {}
        transcription_error = f"speech transcription failed: {error}"
    if result.get("status") == "success":
        intervals = []
        for segment in result.get("segments", []):
            try:
                start = max(0.0, float(segment["start"]) - 0.12)
                end = max(start, float(segment["end"]) + 0.18)
            except (KeyError, TypeError, ValueError):
                continue
            if end > start and str(segment.get("text", "")).strip():
                intervals.append((start, end))
        if intervals:
            return intervals, None, "transcript_timestamps"
        transcription_error = "speech transcription returned no intervals"
    else:
        transcription_error = str(
            result.get("error") or result.get("message") or transcription_error
            or "speech transcription failed"
        )

    vad_intervals = detect_voice_activity(video)
    if vad_intervals:
        return vad_intervals, transcription_error, "ffmpeg_voice_vad"
    return [], transcription_error or "No speech activity was detected", "none"


def _complement_intervals(
    intervals: list[tuple[float, float]],
    duration: float,
) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in sorted(intervals):
        start = min(duration, max(0.0, start))
        end = min(duration, max(start, end))
        if start - cursor >= 0.25:
            result.append((cursor, start))
        cursor = max(cursor, end)
    if duration - cursor >= 0.25:
        result.append((cursor, duration))
    return result


def _speech_expression(intervals: list[tuple[float, float]]) -> str:
    return "+".join(
        f"between(t,{start:.3f},{end:.3f})" for start, end in intervals
    ) or "0"


def _render_single_buses(
    *,
    video: Path,
    bgm: Path,
    duration: float,
    speech_intervals: list[tuple[float, float]],
    dialogue_path: Path,
    bgm_bus_path: Path,
    speech_target_lufs: float,
    bgm_target_lufs: float,
    base_gain_db: float,
    duck_gain_db: float,
) -> None:
    non_speech_gain = 10 ** (base_gain_db / 20.0)
    speech_gain = 10 ** ((base_gain_db + duck_gain_db) / 20.0)
    speech_ranges = [
        (max(0.0, start), min(duration, end), True)
        for start, end in speech_intervals if end > 0 and start < duration
    ]
    non_speech_ranges = [
        (start, end, False)
        for start, end in _complement_intervals(speech_intervals, duration)
    ]
    ranges = sorted(speech_ranges + non_speech_ranges, key=lambda item: item[0])
    split_labels = "".join(f"[bed{index}]" for index in range(len(ranges)))
    bgm_prep = (
        f"[1:a]atrim=0:{duration:.3f},asetpts=PTS-STARTPTS,"
        f"loudnorm=I={bgm_target_lufs}:TP=-2:LRA=7"
    )
    if len(ranges) == 1:
        bgm_prep += "[bed0]"
    else:
        bgm_prep += f",asplit={len(ranges)}{split_labels}"
    filters = [
        f"[0:a]loudnorm=I={speech_target_lufs}:TP=-1.5:LRA=11[dialogue]",
        bgm_prep,
    ]
    range_labels: list[str] = []
    for index, (start, end, is_speech) in enumerate(ranges):
        gain = speech_gain if is_speech else non_speech_gain
        delay_ms = max(0, round(start * 1000))
        filters.append(
            f"[bed{index}]atrim=start={start:.3f}:end={end:.3f},"
            f"asetpts=PTS-STARTPTS,volume={gain:.8f},"
            f"adelay={delay_ms}|{delay_ms}[r{index}]"
        )
        range_labels.append(f"[r{index}]")
    if len(range_labels) == 1:
        filters.append(f"{range_labels[0]}anull[bgm_bus]")
    else:
        filters.append(
            f"{''.join(range_labels)}amix=inputs={len(range_labels)}:"
            "duration=longest:normalize=0[bgm_bus]"
        )
    audio_filter = ";".join(filters)
    run_ffmpeg(
        "-i", str(video), "-stream_loop", "-1", "-i", str(bgm),
        "-filter_complex", audio_filter,
        "-map", "[dialogue]", "-c:a", "pcm_s16le", "-y", str(dialogue_path),
        "-map", "[bgm_bus]", "-c:a", "pcm_s16le", "-y", str(bgm_bus_path),
    )


def _closed_loop_bgm_mix(
    *,
    video: Path,
    bgm: Path,
    output: Path,
    duration: float,
    speech_intervals: list[tuple[float, float]],
    speech_target_lufs: float,
    non_speech_gap_target: float = 7.0,
    speech_gap_target: float = 12.0,
) -> dict:
    non_speech_intervals = _complement_intervals(speech_intervals, duration)
    handles = [
        tempfile.NamedTemporaryFile(dir=output.parent, suffix=".dialogue.wav", delete=False),
        tempfile.NamedTemporaryFile(dir=output.parent, suffix=".bgm.wav", delete=False),
    ]
    for handle in handles:
        handle.close()
    dialogue_path, bgm_bus_path = (Path(handle.name) for handle in handles)
    base_gain_db = 0.0
    duck_gain_db = -(speech_gap_target - non_speech_gap_target)
    metrics: dict = {}
    try:
        for attempt in range(2):
            _render_single_buses(
                video=video, bgm=bgm, duration=duration,
                speech_intervals=speech_intervals,
                dialogue_path=dialogue_path, bgm_bus_path=bgm_bus_path,
                speech_target_lufs=speech_target_lufs,
                bgm_target_lufs=speech_target_lufs - non_speech_gap_target,
                base_gain_db=base_gain_db, duck_gain_db=duck_gain_db,
            )
            dialogue_lufs = measure_lufs_intervals(dialogue_path, speech_intervals)
            if dialogue_lufs is None:
                dialogue_lufs = measure_lufs(dialogue_path)
            bgm_speech_lufs = measure_lufs_intervals(bgm_bus_path, speech_intervals)
            bgm_non_speech_lufs = measure_lufs_intervals(bgm_bus_path, non_speech_intervals)
            speech_gap = (
                dialogue_lufs - bgm_speech_lufs
                if dialogue_lufs is not None and bgm_speech_lufs is not None else None
            )
            non_speech_gap = (
                dialogue_lufs - bgm_non_speech_lufs
                if dialogue_lufs is not None and bgm_non_speech_lufs is not None else None
            )
            metrics = {
                "dialogue_lufs": dialogue_lufs,
                "bgm_non_speech_lufs": bgm_non_speech_lufs,
                "bgm_speech_lufs": bgm_speech_lufs,
                "actual_dialogue_bgm_gap": {
                    "non_speech_lu": non_speech_gap,
                    "speech_lu": speech_gap,
                },
                "gain_correction_db": round(base_gain_db, 3),
                "duck_gain_db": round(duck_gain_db, 3),
                "calibration_passes": attempt + 1,
            }
            non_ok = non_speech_gap is None or 6.0 <= non_speech_gap <= 8.0
            speech_ok = speech_gap is not None and 10.0 <= speech_gap <= 14.0
            if non_ok and speech_ok:
                break
            non_delta = 0.0 if non_speech_gap is None else non_speech_gap - non_speech_gap_target
            speech_delta = 0.0 if speech_gap is None else speech_gap - speech_gap_target
            base_gain_db = max(-6.0, min(6.0, base_gain_db + non_delta))
            duck_gain_db = max(-12.0, min(0.0, duck_gain_db + speech_delta - non_delta))

        run_ffmpeg(
            "-i", str(video), "-i", str(dialogue_path), "-i", str(bgm_bus_path),
            "-filter_complex",
            "[1:a][2:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mix]",
            "-map", "0:v?", "-map", "[mix]", "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
            "-shortest", "-y", str(output),
        )
        metrics["mix_lufs"] = measure_lufs(output)
        final_non_gap = metrics["actual_dialogue_bgm_gap"]["non_speech_lu"]
        final_speech_gap = metrics["actual_dialogue_bgm_gap"]["speech_lu"]
        metrics["calibration_passed"] = (
            (final_non_gap is None or 6.0 <= final_non_gap <= 8.0)
            and final_speech_gap is not None
            and 10.0 <= final_speech_gap <= 14.0
        )
        return metrics
    finally:
        for path in (dialogue_path, bgm_bus_path):
            try:
                os.unlink(path)
            except OSError:
                pass


def _render_progression_bed(
    segments: list[dict],
    *,
    output: Path,
    duration: float,
    crossfade: float,
) -> None:
    args: list[str] = []
    filters: list[str] = []
    labels: list[str] = []
    for index, segment in enumerate(segments):
        args.extend(["-stream_loop", "-1", "-i", str(segment["bgm"])])
        length = float(segment["length"])
        start_ms = max(0, round(float(segment["start_sec"]) * 1000))
        chain = f"[{index}:a]atrim=0:{length:.3f},asetpts=PTS-STARTPTS"
        if crossfade > 0 and length > 2 * crossfade:
            chain += (
                f",afade=t=in:st=0:d={crossfade:.3f}"
                f",afade=t=out:st={length - crossfade:.3f}:d={crossfade:.3f}"
            )
        chain += f",adelay={start_ms}|{start_ms}[p{index}]"
        filters.append(chain)
        labels.append(f"[p{index}]")
    if len(labels) == 1:
        filters.append(f"{labels[0]}atrim=0:{duration:.3f}[bed]")
    else:
        filters.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0,"
            f"atrim=0:{duration:.3f}[bed]"
        )
    run_ffmpeg(
        *args, "-filter_complex", ";".join(filters),
        "-map", "[bed]", "-c:a", "pcm_s16le", "-y", str(output),
    )


def _speech_detector_filter(video: Path, source_label: str = "detector_raw") -> tuple[str, str, int]:
    intervals = _speech_intervals(video)
    if intervals:
        active = "+".join(
            f"between(t,{start:.3f},{end:.3f})" for start, end in intervals
        )
        return (
            f"[{source_label}]volume='if(gt({active},0),1,0)':eval=frame[speech_detector]",
            "transcript_timestamps",
            len(intervals),
        )
    # No transcript is available: isolate the main voice band and gate low-level
    # ambience so wind/water/room tone do not continuously trigger ducking.
    return (
        f"[{source_label}]highpass=f=120,lowpass=f=4000,"
        "agate=threshold=0.04:ratio=4:attack=10:release=250[speech_detector]",
        "voice_band_gate_fallback",
        0,
    )


@tool
def add_bgm(
    video_path: str,
    bgm_path: str,
    volume: float = _DEFAULT_BGM_VOLUME,
    ducking: bool = True,
    ducking_source_path: str = "",
    narration_path: str = "",
    narration_volume: float = 1.0,
    ducking_threshold: float = _DEFAULT_DUCK_THRESHOLD,
    ducking_ratio: float = _DEFAULT_DUCK_RATIO,
    output_path: str = "",
    target_lufs: float = _DEFAULT_TARGET_LUFS,
    speech_target_lufs: float = _DEFAULT_SPEECH_TARGET_LUFS,
    bgm_offset_lu: float = _DEFAULT_BGM_OFFSET_LU,
    bgm_target_lufs: float | None = None,
    final_tolerance_lu: float = _DEFAULT_FINAL_TOLERANCE_LU,
    max_correction_db: float = _DEFAULT_MAX_CORRECTION_DB,
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
        target_lufs: Final measured loudness target used only for bounded correction.
        speech_target_lufs: Normalize the original video audio to this level first.
        bgm_offset_lu: Keep BGM this many LU below the speech target by default.
        bgm_target_lufs: Optional explicit BGM target overriding speech_target_lufs - offset.
        final_tolerance_lu: Do not correct the final mix inside this tolerance.
        max_correction_db: Maximum final gain correction in either direction.
    """
    try:
        video = resolve_input_path(video_path)
        bgm = resolve_input_path(bgm_path)
        video_duration = probe_duration(video)
        if not video_duration or video_duration <= 0:
            raise ValueError(f"could not determine video duration: {video}")
        volume = _bounded(volume, 0.05, 1.5, "volume")
        ducking_threshold = _bounded(ducking_threshold, 0.001, 1.0, "ducking_threshold")
        ducking_ratio = _bounded(ducking_ratio, 1.0, 20.0, "ducking_ratio")
        resolved_bgm_target = (
            float(bgm_target_lufs)
            if bgm_target_lufs is not None
            else float(speech_target_lufs) - float(bgm_offset_lu)
        )
        narration = resolve_input_path(narration_path) if narration_path else None
        ducking_source = (
            resolve_input_path(ducking_source_path)
            if ducking_source_path
            else narration
        )
        output = resolve_output_path(output_path, "bgm", video.suffix)
        ensure_parent(output)

        # Standard BGM requests use a closed-loop stem workflow. Speech
        # timestamps are mandatory so we never silently switch to an unrelated
        # amplitude gate and call the result verified.
        if ducking and narration is None and ducking_source is None:
            speech_intervals, speech_error, analysis_mode = _ensure_speech_intervals(video)
            if not speech_intervals:
                return json.dumps(
                    {
                        "status": "error",
                        "error": "speech_analysis_required",
                        "message": speech_error or "No speech intervals were detected",
                        "required_tool": "transcribe_video",
                        "bgm_mixed": False,
                        "mix_verified": False,
                    },
                    ensure_ascii=False,
                )
            metrics = _closed_loop_bgm_mix(
                video=video,
                bgm=bgm,
                output=output,
                duration=video_duration,
                speech_intervals=speech_intervals,
                speech_target_lufs=float(speech_target_lufs),
            )
            copy_video_sidecars(video, output)
            calibration_passed = bool(metrics.get("calibration_passed"))
            return json.dumps(
                {
                    "status": "success" if calibration_passed else "error",
                    "output": str(output),
                    "bgm_source_found": True,
                    "bgm_mixed": True,
                    "mix_verified": calibration_passed,
                    "verification_message": (
                        "Dialogue/BGM stem gaps are within target ranges."
                        if calibration_passed
                        else "BGM was rendered but stem loudness gaps remain outside target ranges."
                    ),
                    "ducking_applied": True,
                    "ducking_mode": analysis_mode,
                    "transcription_warning": speech_error if analysis_mode == "ffmpeg_voice_vad" else None,
                    "speech_interval_count": len(speech_intervals),
                    "target_gap_lu": {"non_speech": [6.0, 8.0], "speech": [10.0, 14.0]},
                    **metrics,
                },
                ensure_ascii=False,
            )

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
        detector_label = "speech_detector"

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

        ducking_mode = "disabled"
        speech_interval_count = 0
        if ducking:
            if detector_label == "speech_detector":
                detector_filter, ducking_mode, speech_interval_count = _speech_detector_filter(video)
                source_filter = (
                    f"[0:a]loudnorm=I={float(speech_target_lufs)}:TP=-1.5:LRA=11,"
                    "asplit=2[speech][detector_raw];"
                    f"{detector_filter};"
                )
            else:
                ducking_mode = "explicit_dialogue_source"
                source_filter = (
                    f"[0:a]loudnorm=I={float(speech_target_lufs)}:TP=-1.5:LRA=11[speech];"
                )
            mix_inputs = "[speech][ducked]"
            mix_count = 2
            if narration_label:
                mix_inputs += "[narration]"
                mix_count += 1
            audio_filter = (
                f"{source_filter}"
                f"[1:a]atrim=0:{video_duration:.3f},asetpts=PTS-STARTPTS,"
                f"loudnorm=I={resolved_bgm_target}:TP=-2:LRA=7,"
                f"volume={volume}[bgm];"
                f"[bgm][{detector_label}]sidechaincompress="
                f"threshold={ducking_threshold}:"
                f"ratio={ducking_ratio}:"
                "attack=10:release=500[ducked];"
                f"{narration_filter}"
                f"{mix_inputs}amix=inputs={mix_count}:duration=first:normalize=0,"
                "alimiter=limit=0.95[mix]"
            )
        else:
            mix_inputs = "[speech][bgm]"
            mix_count = 2
            if narration_label:
                mix_inputs += "[narration]"
                mix_count += 1
            audio_filter = (
                f"[0:a]loudnorm=I={float(speech_target_lufs)}:TP=-1.5:LRA=11[speech];"
                f"[1:a]atrim=0:{video_duration:.3f},asetpts=PTS-STARTPTS,"
                f"loudnorm=I={resolved_bgm_target}:TP=-2:LRA=7,"
                f"volume={volume}[bgm];"
                f"{narration_filter}"
                f"{mix_inputs}amix=inputs={mix_count}:duration=first:normalize=0,"
                "alimiter=limit=0.95[mix]"
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
        lufs, final_correction_db = _apply_limited_final_correction(
            output,
            target_lufs=float(target_lufs),
            tolerance_lu=float(final_tolerance_lu),
            max_correction_db=float(max_correction_db),
        )
        mix_verified, verification_message = _mix_verification(output, lufs)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "LUFS": lufs,
                "bgm_source_found": True,
                "bgm_mixed": True,
                "mix_verified": mix_verified,
                "verification_message": verification_message,
                "volume": volume,
                "speech_target_lufs": float(speech_target_lufs),
                "bgm_target_lufs": resolved_bgm_target,
                "bgm_offset_lu": float(bgm_offset_lu),
                "final_correction_db": final_correction_db,
                "ducking_applied": ducking,
                "ducking_mode": ducking_mode,
                "speech_interval_count": speech_interval_count,
                "ducking_source": str(ducking_source) if ducking_source else "video_audio",
                "narration_mixed": bool(narration),
                "narration": str(narration) if narration else None,
                "ducking_threshold": ducking_threshold,
                "ducking_ratio": ducking_ratio,
                "report": (
                    f"output: {output}, LUFS: {lufs}, bgm_mixed: true, "
                    f"mix_verified: {str(mix_verified).lower()}, volume: {volume}, "
                    f"speech_target_lufs: {speech_target_lufs}, "
                    f"bgm_target_lufs: {resolved_bgm_target}, "
                    f"final_correction_db: {final_correction_db}, "
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


@tool
def add_bgm_progression(
    video_path: str,
    segments: list[dict],
    output_path: str = "",
    target_lufs: float | None = None,
    crossfade: float = 0.5,
    volume: float = _DEFAULT_BGM_VOLUME,
    speech_target_lufs: float = _DEFAULT_SPEECH_TARGET_LUFS,
    bgm_offset_lu: float = _DEFAULT_BGM_OFFSET_LU,
    bgm_target_lufs: float | None = None,
    ducking: bool = True,
    ducking_threshold: float = _DEFAULT_DUCK_THRESHOLD,
    ducking_ratio: float = _DEFAULT_DUCK_RATIO,
    final_tolerance_lu: float = _DEFAULT_FINAL_TOLERANCE_LU,
    max_correction_db: float = _DEFAULT_MAX_CORRECTION_DB,
) -> str:
    """구간별로 다른 BGM 을 시간대에 맞춰 깔아 하나의 영상 오디오로 합친다.

    쇼츠/브이로그처럼 장면 분위기가 바뀔 때 (예: 경쾌한 브이로그 -> 렌치가 안 맞을 때
    정적/개그 -> 밥 먹을 때 힐링) 시간 구간마다 서로 다른 음악을 배치한다.

    처리 방식:
    - 각 구간 BGM 을 atrim 으로 구간 길이만큼 잘라 adelay 로 start_sec 위치에 배치.
    - 배치된 트랙들을 amix 로 하나의 BGM 베드로 합침.
    - 그 베드를 원본 영상 오디오(발화)로 sidechaincompress 더킹 -> 말 위에서 BGM 자동 감쇠.
    - 원본 영상 오디오와 다시 amix 후 loudnorm 으로 라우드니스 정규화.

    Args:
        video_path: 입력 영상 경로. 원본 오디오(발화)는 보존되고 더킹의 기준으로도 쓰인다.
        segments: 구간 리스트. 각 원소는 {"bgm_path": str, "start_sec": float, "end_sec": float}.
            bgm_path 가 없거나 길이가 0 이하인 구간은 건너뛰고 경고에 남긴다.
        output_path: 선택. 결과 영상 경로. 비우면 videos/audio 아래 자동 생성.
        target_lufs: 최종 라우드니스 목표. None 이면 -14 LUFS. 쇼츠는 -16 권장.
        crossfade: 0 보다 크면 각 구간 경계에 afade in/out(초 단위)을 걸어 딱딱한 컷을
            부드럽게 만든다. 겹침으로 인한 볼륨 증폭을 피하기 위해 구간별 페이드로 단순화했다.
    """
    try:
        video = resolve_input_path(video_path)

        if not segments:
            return json.dumps(
                {"status": "error", "error": "segments is empty"},
                ensure_ascii=False,
            )

        lufs_target = _DEFAULT_TARGET_LUFS if target_lufs is None else float(target_lufs)
        volume = _bounded(volume, 0.05, 1.5, "volume")
        ducking_threshold = _bounded(ducking_threshold, 0.001, 1.0, "ducking_threshold")
        ducking_ratio = _bounded(ducking_ratio, 1.0, 20.0, "ducking_ratio")
        resolved_bgm_target = (
            float(bgm_target_lufs)
            if bgm_target_lufs is not None
            else float(speech_target_lufs) - float(bgm_offset_lu)
        )

        valid: list[dict] = []
        warnings: list[str] = []
        for index, segment in enumerate(segments):
            bgm_path = (segment or {}).get("bgm_path", "")
            start_sec = float((segment or {}).get("start_sec", 0.0))
            end_sec = float((segment or {}).get("end_sec", 0.0))
            length = end_sec - start_sec
            if length <= 0:
                warnings.append(
                    f"segment {index}: skipped (non-positive length {length})"
                )
                continue
            if not bgm_path:
                warnings.append(f"segment {index}: skipped (missing bgm_path)")
                continue
            try:
                bgm = resolve_input_path(bgm_path)
            except Exception as resolve_error:
                warnings.append(f"segment {index}: skipped ({resolve_error})")
                continue
            valid.append(
                {
                    "bgm": bgm,
                    "start_sec": start_sec,
                    "length": length,
                }
            )

        if not valid:
            return json.dumps(
                {
                    "status": "error",
                    "error": "no valid bgm segments",
                    "warnings": warnings,
                },
                ensure_ascii=False,
            )

        output = resolve_output_path(output_path, "bgm_progression", video.suffix)
        ensure_parent(output)

        if ducking:
            video_duration = probe_duration(video)
            if not video_duration or video_duration <= 0:
                return json.dumps({"status": "error", "error": "could not determine video duration"})
            speech_intervals, speech_error, analysis_mode = _ensure_speech_intervals(video)
            if not speech_intervals:
                return json.dumps(
                    {
                        "status": "error",
                        "error": "speech_analysis_required",
                        "message": speech_error or "No speech intervals were detected",
                        "required_tool": "transcribe_video",
                        "bgm_mixed": False,
                        "mix_verified": False,
                    },
                    ensure_ascii=False,
                )
            handle = tempfile.NamedTemporaryFile(
                dir=output.parent, suffix=".progression.wav", delete=False
            )
            handle.close()
            progression_bed = Path(handle.name)
            try:
                _render_progression_bed(
                    valid,
                    output=progression_bed,
                    duration=video_duration,
                    crossfade=float(crossfade),
                )
                metrics = _closed_loop_bgm_mix(
                    video=video,
                    bgm=progression_bed,
                    output=output,
                    duration=video_duration,
                    speech_intervals=speech_intervals,
                    speech_target_lufs=float(speech_target_lufs),
                )
            finally:
                try:
                    os.unlink(progression_bed)
                except OSError:
                    pass
            copy_video_sidecars(video, output)
            calibration_passed = bool(metrics.get("calibration_passed"))
            return json.dumps(
                {
                    "status": "success" if calibration_passed else "error",
                    "output": str(output),
                    "bgm_source_found": True,
                    "bgm_mixed": True,
                    "mix_verified": calibration_passed,
                    "verification_message": (
                        "Dialogue/BGM stem gaps are within target ranges."
                        if calibration_passed
                        else "BGM was rendered but stem loudness gaps remain outside target ranges."
                    ),
                    "segments_applied": len(valid),
                    "ducking_applied": True,
                    "ducking_mode": analysis_mode,
                    "transcription_warning": speech_error if analysis_mode == "ffmpeg_voice_vad" else None,
                    "speech_interval_count": len(speech_intervals),
                    "target_gap_lu": {"non_speech": [6.0, 8.0], "speech": [10.0, 14.0]},
                    "warnings": warnings,
                    **metrics,
                },
                ensure_ascii=False,
            )

        ffmpeg_args = ["-i", str(video)]
        for segment in valid:
            # -stream_loop -1: BGM 이 구간보다 짧아도 반복해 채운 뒤 atrim 으로 자름
            ffmpeg_args.extend(["-stream_loop", "-1", "-i", str(segment["bgm"])])

        filter_parts: list[str] = []
        seg_labels: list[str] = []
        for index, segment in enumerate(valid):
            input_index = index + 1
            length = segment["length"]
            start_ms = max(0, round(segment["start_sec"] * 1000))
            chain = (
                f"[{input_index}:a]atrim=0:{length:.3f},asetpts=PTS-STARTPTS,"
                f"loudnorm=I={resolved_bgm_target}:TP=-2:LRA=7,volume={volume}"
            )
            if crossfade > 0 and length > 2 * crossfade:
                fade_out_start = length - crossfade
                chain += (
                    f",afade=t=in:st=0:d={crossfade:.3f}"
                    f",afade=t=out:st={fade_out_start:.3f}:d={crossfade:.3f}"
                )
            chain += f",adelay={start_ms}|{start_ms}[s{index}]"
            filter_parts.append(chain)
            seg_labels.append(f"[s{index}]")

        if len(seg_labels) == 1:
            bed_label = seg_labels[0]
        else:
            filter_parts.append(
                f"{''.join(seg_labels)}amix=inputs={len(seg_labels)}:"
                "duration=longest:normalize=0[bgmbed]"
            )
            bed_label = "[bgmbed]"

        # 더킹: BGM 베드를 원본 영상 오디오(발화)로 사이드체인 압축해 말 위에서 감쇠
        ducking_mode = "disabled"
        speech_interval_count = 0
        if ducking:
            detector_filter, ducking_mode, speech_interval_count = _speech_detector_filter(video)
            filter_parts.append(
                f"[0:a]loudnorm=I={float(speech_target_lufs)}:TP=-1.5:LRA=11,"
                "asplit=2[speech][detector_raw]"
            )
            filter_parts.append(detector_filter)
            filter_parts.append(
                f"{bed_label}[speech_detector]sidechaincompress="
                f"threshold={ducking_threshold}:"
                f"ratio={ducking_ratio}:"
                "attack=10:release=500[ducked]"
            )
            final_bgm_label = "[ducked]"
        else:
            filter_parts.append(
                f"[0:a]loudnorm=I={float(speech_target_lufs)}:TP=-1.5:LRA=11[speech]"
            )
            final_bgm_label = bed_label
        # 원본 오디오와 더킹된 BGM 을 합치고 loudnorm 으로 최종 라우드니스 정규화
        filter_parts.append(
            f"[speech]{final_bgm_label}amix=inputs=2:duration=first:normalize=0,"
            "alimiter=limit=0.95[mix]"
        )

        audio_filter = ";".join(filter_parts)

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
        measured_lufs, final_correction_db = _apply_limited_final_correction(
            output,
            target_lufs=lufs_target,
            tolerance_lu=float(final_tolerance_lu),
            max_correction_db=float(max_correction_db),
        )
        mix_verified, verification_message = _mix_verification(output, measured_lufs)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "bgm_source_found": True,
                "bgm_mixed": True,
                "mix_verified": mix_verified,
                "verification_message": verification_message,
                "segments_applied": len(valid),
                "measured_lufs": measured_lufs,
                "target_lufs": lufs_target,
                "speech_target_lufs": float(speech_target_lufs),
                "bgm_target_lufs": resolved_bgm_target,
                "bgm_offset_lu": float(bgm_offset_lu),
                "final_correction_db": final_correction_db,
                "volume": volume,
                "ducking_applied": ducking,
                "ducking_mode": ducking_mode,
                "speech_interval_count": speech_interval_count,
                "ducking_threshold": ducking_threshold if ducking else None,
                "ducking_ratio": ducking_ratio if ducking else None,
                "crossfade": crossfade,
                "warnings": warnings,
                "report": (
                    f"output: {output}, segments_applied: {len(valid)}, "
                    f"measured_lufs: {measured_lufs}, target_lufs: {lufs_target}, "
                    f"bgm_mixed: true, mix_verified: {str(mix_verified).lower()}, "
                    f"speech_target_lufs: {speech_target_lufs}, "
                    f"bgm_target_lufs: {resolved_bgm_target}, "
                    f"final_correction_db: {final_correction_db}, "
                    f"volume: {volume}, ducking_applied: {str(ducking).lower()}, "
                    f"crossfade: {crossfade}, warnings: {len(warnings)}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [add_bgm, add_bgm_progression]
