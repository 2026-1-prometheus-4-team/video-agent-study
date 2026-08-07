"""Shared FFmpeg helpers for audio_expert tools."""

from __future__ import annotations

import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Sequence

from agent import config
from agent.tools import media_paths


def resolve_input_path(path: str) -> Path:
    # 편집 산출물은 outputs/ 에 있고 업로드 원본은 videos/ 에 있다. PROJECT_ROOT
    # 만 보면 edit_expert 가 넘긴 "merge_video_5.mp4" 를 못 찾는다 (공용 규칙은
    # media_paths 참고).
    candidate = media_paths.resolve_media(path).resolve()
    if not candidate.exists():
        raise FileNotFoundError(f"file not found: {candidate}")
    return candidate


def resolve_output_path(path: str, suffix: str, extension: str) -> Path:
    if path:
        # bare 파일명은 outputs/ 로 — PROJECT_ROOT 에 두면 정적 마운트 밖이라
        # 프론트가 결과물을 재생할 수 없다 (media_paths 참고).
        return media_paths.resolve_output(path).resolve()
    output_dir = config.PROJECT_ROOT / "videos" / "audio"
    return output_dir / f"{suffix}_{time.time_ns()}{extension}"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def copy_video_sidecars(source: Path, output: Path) -> None:
    """Preserve edit timeline metadata across audio-only video transforms."""
    for suffix in (".origin.json", ".pad.json"):
        source_sidecar = Path(f"{source}{suffix}")
        if source_sidecar.exists():
            shutil.copy2(source_sidecar, Path(f"{output}{suffix}"))


def _run(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="ignore")


def run_ffmpeg(*args: str) -> None:
    result = _run(["ffmpeg", "-hide_banner", *args])
    if result.returncode:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-200:]}")


def probe_duration(path: Path) -> float | None:
    try:
        result = _run([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ])
    except FileNotFoundError:
        return None
    if result.returncode:
        return None
    return round(float(result.stdout.strip()), 3)


def measure_lufs(path: Path) -> float | None:
    result = _run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", "ebur128=framelog=verbose", "-f", "null", "-",
    ])
    matches = re.findall(r"I:\s*(-?\d+(?:\.\d+)?) LUFS", result.stderr)
    return float(matches[-1]) if matches else None


def measure_lufs_intervals(
    path: Path,
    intervals: list[tuple[float, float]],
) -> float | None:
    """Measure integrated loudness after concatenating selected time ranges."""
    valid = [(max(0.0, float(start)), float(end)) for start, end in intervals if end > start]
    if not valid:
        return None
    parts: list[str] = []
    labels: list[str] = []
    for index, (start, end) in enumerate(valid):
        parts.append(
            f"[0:a]atrim=start={start:.3f}:end={end:.3f},"
            f"asetpts=PTS-STARTPTS[i{index}]"
        )
        labels.append(f"[i{index}]")
    if len(labels) == 1:
        meter_input = labels[0]
    else:
        parts.append(
            f"{''.join(labels)}concat=n={len(labels)}:v=0:a=1[selected]"
        )
        meter_input = "[selected]"
    parts.append(f"{meter_input}ebur128=framelog=verbose[meter]")
    result = _run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-filter_complex", ";".join(parts), "-map", "[meter]",
        "-f", "null", "-",
    ])
    matches = re.findall(r"I:\s*(-?\d+(?:\.\d+)?) LUFS", result.stderr)
    return float(matches[-1]) if matches else None


def detect_voice_activity(path: Path) -> list[tuple[float, float]]:
    """Return voice-band activity intervals using FFmpeg only.

    This is a dependency-free fallback when Whisper/OpenAI is unavailable.
    The 120-4000 Hz band suppresses much low-frequency ambience before
    silencedetect determines active ranges.
    """
    duration = probe_duration(path)
    if not duration or duration <= 0:
        return []
    result = _run([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", (
            "highpass=f=120,lowpass=f=4000,"
            "silencedetect=noise=-32dB:d=0.25"
        ),
        "-f", "null", "-",
    ])
    if result.returncode:
        return []
    events = re.findall(
        r"silence_(start|end):\s*(-?\d+(?:\.\d+)?)",
        result.stderr,
    )
    silence_ranges: list[tuple[float, float]] = []
    silence_start: float | None = None
    for kind, raw_value in events:
        value = max(0.0, min(duration, float(raw_value)))
        if kind == "start":
            silence_start = value
        elif silence_start is not None:
            silence_ranges.append((silence_start, value))
            silence_start = None
    if silence_start is not None:
        silence_ranges.append((silence_start, duration))

    active: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in silence_ranges:
        if start - cursor >= 0.15:
            active.append((max(0.0, cursor - 0.08), min(duration, start + 0.12)))
        cursor = max(cursor, end)
    if duration - cursor >= 0.15:
        active.append((max(0.0, cursor - 0.08), duration))
    return active
