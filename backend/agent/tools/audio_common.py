"""Shared FFmpeg helpers for audio_expert tools."""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Sequence

from agent import config
from agent.tools import media_paths

logger = logging.getLogger(__name__)


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
    copy_cue_document(source, output)


def copy_cue_document(source: Path, output: Path) -> None:
    """자막 큐 문서를 새 결과물 stem 으로 승계한다.

    큐 문서는 stem 으로만 조회된다 (subtitle_cues._cues_doc_path). 영상을 새로
    쓰는 단계마다 stem 이 바뀌는데 문서를 물려주지 않으면 최종본 stem 의 문서가
    없어 조회가 통째로 실패한다. 그 결과가 실제로 관찰된 세 증상이다:
    프론트가 자막을 못 올리고, 자막 스타일 카드가 안 뜨고, export 가 no_cues 로
    떨어져 자막 없는 영상을 내려받는다.

    source_video 는 일부러 그대로 둔다. 그 값은 "자막을 굽기 전 원본"을 가리키는
    재렌더 기준점이라, 새 결과물로 덮어쓰면 이미 구워진 영상 위에 다시 굽는다.
    """
    source_stem = Path(source).stem
    output_stem = Path(output).stem
    if not source_stem or source_stem == output_stem:
        return

    cues_dir = config.VIDEOS_DIR / "subtitles"
    source_doc = cues_dir / f"{source_stem}.cues.json"
    target_doc = cues_dir / f"{output_stem}.cues.json"
    # 이미 있는 문서는 덮어쓰지 않는다 — 사용자가 편집한 큐가 날아간다.
    if not source_doc.exists() or target_doc.exists():
        return

    try:
        doc = json.loads(source_doc.read_text(encoding="utf-8"))
        doc["video_stem"] = output_stem
        cues_dir.mkdir(parents=True, exist_ok=True)
        target_doc.write_text(
            json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        logger.info("cue 문서 승계: %s -> %s", source_stem, output_stem)
    except (OSError, ValueError):
        logger.warning(
            "cue 문서 승계 실패: %s -> %s", source_stem, output_stem, exc_info=True
        )


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
