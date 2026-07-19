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

# add_bgm_progression 이 재사용하는 기본값 (add_bgm 의 기본값과 동일하게 맞춤)
_PROGRESSION_BGM_VOLUME = 0.22
_PROGRESSION_DUCK_THRESHOLD = 0.015
_PROGRESSION_DUCK_RATIO = 12.0
_DEFAULT_TARGET_LUFS = -14.0


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


@tool
def add_bgm_progression(
    video_path: str,
    segments: list[dict],
    output_path: str = "",
    target_lufs: float | None = None,
    crossfade: float = 0.5,
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
                f"[{input_index}:a]volume={_PROGRESSION_BGM_VOLUME},"
                f"atrim=0:{length:.3f},asetpts=PTS-STARTPTS"
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
        filter_parts.append(
            f"{bed_label}[0:a]sidechaincompress="
            f"threshold={_PROGRESSION_DUCK_THRESHOLD}:"
            f"ratio={_PROGRESSION_DUCK_RATIO}:"
            "attack=10:release=500[ducked]"
        )
        # 원본 오디오와 더킹된 BGM 을 합치고 loudnorm 으로 최종 라우드니스 정규화
        filter_parts.append(
            f"[0:a][ducked]amix=inputs=2:duration=first:normalize=0,"
            f"loudnorm=I={lufs_target}:TP=-1.5:LRA=11[mix]"
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
        measured_lufs = measure_lufs(output)
        return json.dumps(
            {
                "status": "success",
                "output": str(output),
                "segments_applied": len(valid),
                "measured_lufs": measured_lufs,
                "target_lufs": lufs_target,
                "crossfade": crossfade,
                "warnings": warnings,
                "report": (
                    f"output: {output}, segments_applied: {len(valid)}, "
                    f"measured_lufs: {measured_lufs}, target_lufs: {lufs_target}, "
                    f"crossfade: {crossfade}, warnings: {len(warnings)}"
                ),
            },
            ensure_ascii=False,
        )
    except Exception as error:
        return json.dumps({"status": "error", "error": str(error)}, ensure_ascii=False)


TOOLS = [add_bgm, add_bgm_progression]
