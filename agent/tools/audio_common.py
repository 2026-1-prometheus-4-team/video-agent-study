"""Shared FFmpeg helpers for audio_expert tools."""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path
from typing import Sequence

from agent import config


def resolve_input_path(path: str) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = config.PROJECT_ROOT / candidate
    candidate = candidate.resolve()
    if not candidate.exists():
        raise FileNotFoundError(f"file not found: {candidate}")
    return candidate


def resolve_output_path(path: str, suffix: str, extension: str) -> Path:
    if path:
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = config.PROJECT_ROOT / candidate
        return candidate.resolve()
    output_dir = config.PROJECT_ROOT / "videos" / "audio"
    return output_dir / f"{suffix}_{time.time_ns()}{extension}"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


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
