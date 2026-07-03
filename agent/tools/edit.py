"""
영상 편집 Tool - edit_expert 전용.

담당 범위:
- cut_video: 타임스탬프(ms) 기준 구간 추출
- merge_video: FFmpeg concat demuxer 방식으로 클립 병합
- search_video_segments: 분석 JSON에서 내용 기반 구간 검색
- cut_by_description: 내용 기반 검색 후 해당 구간 자동 추출
- cut_scene: 기존 scene 이름/번호 기반 호출 호환
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
import time
import uuid
from typing import Any, Optional

from langchain_core.tools import tool

logger = logging.getLogger(__name__)

_PROJECT_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
VIDEOS_DIR = os.path.join(_PROJECT_ROOT, "videos")
OUTPUTS_DIR = os.path.join(_PROJECT_ROOT, "outputs")


def _ensure_outputs() -> None:
    os.makedirs(OUTPUTS_DIR, exist_ok=True)


def _run_ffmpeg(cmd: list[str]) -> tuple[int, str]:
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    return result.returncode, result.stderr


def _ffprobe_video_meta(path: str) -> dict | None:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,r_frame_rate",
            "-of", "json",
            path,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout)
        stream = (data.get("streams") or [{}])[0]
        return {
            "codec_name": stream.get("codec_name"),
            "width": int(stream.get("width") or 0),
            "height": int(stream.get("height") or 0),
            "fps": stream.get("r_frame_rate") or "",
        }
    except Exception:
        return None


def _ffprobe_has_audio(path: str) -> bool:
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_name",
            "-of", "json",
            path,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
        )
        if result.returncode != 0:
            return False
        data = json.loads(result.stdout)
        return bool(data.get("streams"))
    except Exception:
        return False


def _streams_compatible(metas: list[dict | None]) -> bool:
    if not metas or any(meta is None for meta in metas):
        return True
    first = metas[0]
    return all(
        meta.get("codec_name") == first.get("codec_name")
        and meta.get("width") == first.get("width")
        and meta.get("height") == first.get("height")
        and meta.get("fps") == first.get("fps")
        for meta in metas[1:]
    )


def _resolve_video_path(video_path: str) -> str:
    if os.path.isabs(video_path):
        return os.path.normpath(video_path)

    direct = os.path.join(_PROJECT_ROOT, video_path)
    if os.path.exists(direct):
        return os.path.normpath(direct)

    return os.path.normpath(os.path.join(VIDEOS_DIR, video_path))


def _resolve_output_path(output_path: Optional[str], prefix: str, source_path: str) -> str:
    if output_path:
        if os.path.isabs(output_path):
            resolved = output_path
        elif os.path.dirname(output_path):
            resolved = os.path.join(_PROJECT_ROOT, output_path)
        else:
            resolved = os.path.join(OUTPUTS_DIR, output_path)
        parent = os.path.dirname(os.path.abspath(resolved))
        if parent:
            os.makedirs(parent, exist_ok=True)
        return os.path.normpath(resolved)

    _ensure_outputs()
    _, ext = os.path.splitext(source_path)
    return os.path.join(OUTPUTS_DIR, f"{prefix}_{uuid.uuid4().hex[:8]}{ext or '.mp4'}")


def _time_to_ms(value: Any, *, already_ms: bool = False) -> int:
    if value is None:
        return 0
    number = float(value)
    if already_ms:
        return int(round(number))
    return int(round(number * 1000))


def _json_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(_json_text(v) for v in value)
    if isinstance(value, dict):
        return " ".join(_json_text(v) for v in value.values())
    return str(value)


def _find_analysis_path(video_path: str, analysis_path: Optional[str] = None) -> Optional[str]:
    if analysis_path:
        if os.path.isabs(analysis_path):
            return analysis_path if os.path.exists(analysis_path) else None
        direct = os.path.join(_PROJECT_ROOT, analysis_path)
        if os.path.exists(direct):
            return direct
        in_videos = os.path.join(VIDEOS_DIR, analysis_path)
        return in_videos if os.path.exists(in_videos) else None

    base = os.path.splitext(os.path.basename(video_path))[0]
    candidates = [
        os.path.join(VIDEOS_DIR, f"{base}_analysis.json"),
        os.path.join(VIDEOS_DIR, f"{base}_analysis_v2.json"),
        os.path.join(VIDEOS_DIR, f"{base}_analysis_gemini-only.json"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _load_analysis(video_path: str, analysis_path: Optional[str] = None) -> tuple[str, dict] | None:
    resolved = _find_analysis_path(video_path, analysis_path)
    if not resolved:
        return None
    with open(resolved, encoding="utf-8") as f:
        return resolved, json.load(f)


def _extract_raw_segments(analysis: dict) -> list[tuple[str, dict]]:
    raw: list[tuple[str, dict]] = []
    for key in ("segments", "scenes", "transcript"):
        items = analysis.get(key)
        if isinstance(items, list):
            raw.extend((key, item) for item in items if isinstance(item, dict))
    return raw


def _normalize_segment(source: str, segment: dict, index: int) -> dict:
    has_start_ms = "start_ms" in segment
    has_end_ms = "end_ms" in segment
    start_ms = _time_to_ms(segment.get("start_ms", segment.get("start", 0)), already_ms=has_start_ms)
    end_ms = _time_to_ms(segment.get("end_ms", segment.get("end", 0)), already_ms=has_end_ms)

    fields = [
        segment.get("description"),
        segment.get("summary"),
        segment.get("text"),
        segment.get("objects"),
        segment.get("visual_tags"),
        segment.get("people"),
        segment.get("actions"),
        segment.get("mood"),
        segment.get("content_type"),
        segment.get("edit_notes"),
        segment.get("claude_detail"),
    ]
    search_blob = " ".join(_json_text(v) for v in fields if v is not None).strip()
    display = segment.get("description") or segment.get("summary") or segment.get("text") or search_blob[:160]

    return {
        "index": index,
        "source": source,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "duration_ms": max(0, end_ms - start_ms),
        "description": display,
        "objects": segment.get("objects", []),
        "mood": segment.get("mood"),
        "_search_blob": search_blob,
    }


def _analysis_segments(analysis: dict) -> list[dict]:
    segments = []
    for index, (source, raw) in enumerate(_extract_raw_segments(analysis)):
        normalized = _normalize_segment(source, raw, index)
        if normalized["end_ms"] > normalized["start_ms"]:
            segments.append(normalized)
    return segments


def _score_segment(query: str, segment: dict) -> int:
    query_norm = query.casefold().strip()
    blob = segment.get("_search_blob", "").casefold()
    if not query_norm or not blob:
        return 0

    score = 0
    if query_norm in blob:
        score += 20

    terms = [t for t in re.split(r"[\s,./|+]+", query_norm) if t]
    for term in terms:
        if len(term) >= 2 and term in blob:
            score += 4

    return score


def _search_segments(video_path: str, query: str, analysis_path: Optional[str], max_results: int) -> tuple[str, list[dict]] | tuple[None, list]:
    loaded = _load_analysis(video_path, analysis_path)
    if not loaded:
        return None, []

    resolved_analysis_path, analysis = loaded
    scored = []
    for segment in _analysis_segments(analysis):
        score = _score_segment(query, segment)
        if score > 0:
            public_segment = {k: v for k, v in segment.items() if not k.startswith("_")}
            public_segment["score"] = score
            scored.append(public_segment)

    scored.sort(key=lambda s: (-s["score"], s["start_ms"]))
    return resolved_analysis_path, scored[:max_results]


@tool
def cut_video(
    video_path: str,
    start_ms: int,
    end_ms: int,
    output_path: Optional[str] = None,
) -> str:
    """영상 파일에서 지정 구간(start_ms ~ end_ms)을 잘라내 새 파일로 저장.

    Args:
        video_path: 원본 영상 경로. 절대경로, 프로젝트 루트 상대경로, 또는 videos/ 기준 파일명.
        start_ms: 시작 시각(ms). 예: 11분 15초 = 675000.
        end_ms: 종료 시각(ms). start_ms보다 커야 함.
        output_path: 저장 경로. 생략 시 outputs/cut_<id>.mp4.

    Returns:
        성공 시 출력 파일 절대경로. 실패 시 "ERROR: ..." 문자열.
    """
    try:
        resolved = _resolve_video_path(video_path)
        if not os.path.exists(resolved):
            return f"ERROR: 파일을 찾을 수 없음: {resolved}"

        start_ms = int(round(float(start_ms)))
        end_ms = int(round(float(end_ms)))
        if start_ms < 0 or end_ms <= start_ms:
            return f"ERROR: 잘못된 타임스탬프: start_ms={start_ms}, end_ms={end_ms}"

        output_path = _resolve_output_path(output_path, "cut", resolved)

        start_sec = start_ms / 1000.0
        duration_sec = (end_ms - start_ms) / 1000.0
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start_sec:.3f}",
            "-i", resolved,
            "-t", f"{duration_sec:.3f}",
            "-c", "copy",
            output_path,
        ]

        logger.info("cut_video: %s [%dms~%dms] -> %s", resolved, start_ms, end_ms, output_path)
        t0 = time.monotonic()
        code, stderr = _run_ffmpeg(cmd)
        elapsed = time.monotonic() - t0

        if code != 0:
            return f"ERROR: FFmpeg 실패 (rc={code}): {stderr[-300:]}"
        if not os.path.exists(output_path):
            return f"ERROR: 출력 파일 생성 실패: {output_path}"

        logger.info("cut_video 완료 %.2fs -> %s", elapsed, output_path)
        return output_path

    except FileNotFoundError:
        return "ERROR: ffmpeg 바이너리를 찾을 수 없습니다."
    except Exception as e:
        logger.exception("cut_video 예외")
        return f"ERROR: {e}"


@tool
def merge_video(
    clip_paths: list[str],
    output_path: Optional[str] = None,
) -> str:
    """여러 클립을 순서대로 이어 붙여 하나의 영상으로 저장.

    Args:
        clip_paths: 병합할 클립 경로 목록. 순서 그대로 concat.
        output_path: 저장 경로. 생략 시 outputs/merged_<id>.mp4.

    Returns:
        성공 시 출력 파일 절대경로. 실패 시 "ERROR: ..." 문자열.
    """
    try:
        if not clip_paths:
            return "ERROR: clip_paths 가 비어 있습니다."
        if len(clip_paths) == 1:
            return _resolve_video_path(clip_paths[0])

        resolved_clips = [_resolve_video_path(p) for p in clip_paths]
        for path in resolved_clips:
            if not os.path.exists(path):
                return f"ERROR: 클립 파일을 찾을 수 없음: {path}"

        output_path = _resolve_output_path(output_path, "merged", resolved_clips[0])
        metas = [_ffprobe_video_meta(path) for path in resolved_clips]
        compatible = _streams_compatible(metas)

        if compatible:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False, encoding="utf-8"
            ) as fh:
                filelist_path = fh.name
                for path in resolved_clips:
                    safe = os.path.abspath(path).replace("\\", "/").replace("'", "\\'")
                    fh.write(f"file '{safe}'\n")

            try:
                cmd = [
                    "ffmpeg", "-y",
                    "-f", "concat",
                    "-safe", "0",
                    "-i", filelist_path,
                    "-c", "copy",
                    output_path,
                ]
                logger.info("merge_video copy: %d clips -> %s", len(resolved_clips), output_path)
                t0 = time.monotonic()
                code, stderr = _run_ffmpeg(cmd)
                elapsed = time.monotonic() - t0
            finally:
                try:
                    os.unlink(filelist_path)
                except OSError:
                    pass
        else:
            first_meta = next(meta for meta in metas if meta)
            width = first_meta["width"] or 1280
            height = first_meta["height"] or 720
            all_have_audio = all(_ffprobe_has_audio(path) for path in resolved_clips)
            inputs = []
            filter_parts = []
            concat_inputs = []
            for idx, path in enumerate(resolved_clips):
                inputs.extend(["-i", path])
                filter_parts.append(
                    f"[{idx}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{idx}]"
                )
                if all_have_audio:
                    filter_parts.append(
                        f"[{idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a{idx}]"
                    )
                    concat_inputs.append(f"[v{idx}][a{idx}]")
                else:
                    concat_inputs.append(f"[v{idx}]")

            if all_have_audio:
                filter_complex = ";".join(filter_parts) + ";" + "".join(concat_inputs) + (
                    f"concat=n={len(resolved_clips)}:v=1:a=1[v][a]"
                )
                maps = ["-map", "[v]", "-map", "[a]"]
                audio_args = ["-c:a", "aac", "-b:a", "192k"]
            else:
                filter_complex = ";".join(filter_parts) + ";" + "".join(concat_inputs) + (
                    f"concat=n={len(resolved_clips)}:v=1:a=0[v]"
                )
                maps = ["-map", "[v]"]
                audio_args = []

            cmd = [
                "ffmpeg", "-y",
                *inputs,
                "-filter_complex", filter_complex,
                *maps,
                "-c:v", "libx264",
                "-pix_fmt", "yuv420p",
                "-preset", "veryfast",
                *audio_args,
                output_path,
            ]
            logger.info("merge_video reencode: %d clips -> %s", len(resolved_clips), output_path)
            t0 = time.monotonic()
            code, stderr = _run_ffmpeg(cmd)
            elapsed = time.monotonic() - t0

        if code != 0:
            return f"ERROR: FFmpeg concat 실패 (rc={code}): {stderr[-300:]}"
        if not os.path.exists(output_path):
            return f"ERROR: 출력 파일 생성 실패: {output_path}"

        logger.info("merge_video 완료 %.2fs -> %s", elapsed, output_path)
        return output_path

    except FileNotFoundError:
        return "ERROR: ffmpeg 바이너리를 찾을 수 없습니다."
    except Exception as e:
        logger.exception("merge_video 예외")
        return f"ERROR: {e}"


@tool
def search_video_segments(
    video_path: str,
    query: str,
    analysis_path: Optional[str] = None,
    max_results: int = 5,
) -> str:
    """분석 JSON에서 자연어 query와 일치하는 영상 구간을 찾는다.

    Args:
        video_path: 원본 영상 경로 또는 파일명.
        query: 찾을 장면 설명. 예: "타워 브리지", "공중전화", "노란 상자".
        analysis_path: 분석 JSON 경로. 생략 시 videos/<영상명>_analysis.json 자동 탐색.
        max_results: 최대 반환 개수.

    Returns:
        JSON 문자열: status, analysis_path, matches[{start_ms,end_ms,description,score}].
    """
    try:
        max_results = max(1, int(max_results))
        resolved_analysis_path, matches = _search_segments(video_path, query, analysis_path, max_results)
        if not resolved_analysis_path:
            return json.dumps({
                "status": "error",
                "error": "analysis_not_found",
                "message": "분석 JSON이 없습니다. analyze_video 후 다시 호출하세요.",
            }, ensure_ascii=False)

        return json.dumps({
            "status": "success",
            "query": query,
            "analysis_path": resolved_analysis_path,
            "matches": matches,
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("search_video_segments 예외")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


@tool
def cut_by_description(
    video_path: str,
    query: str,
    analysis_path: Optional[str] = None,
    merge: bool = False,
    padding_ms: int = 0,
    max_segments: int = 5,
    output_path: Optional[str] = None,
) -> str:
    """분석 JSON에서 장면을 검색한 뒤 매칭된 구간을 자동으로 잘라낸다.

    Args:
        video_path: 원본 영상 경로 또는 파일명.
        query: 찾을 장면 설명.
        analysis_path: 분석 JSON 경로. 생략 시 자동 탐색.
        merge: True면 여러 매칭 클립을 하나로 병합.
        padding_ms: 각 구간 앞뒤로 추가할 여유 시간(ms).
        max_segments: 최대 컷 개수.
        output_path: merge=True 또는 매칭 1개일 때 사용할 출력 경로.

    Returns:
        JSON 문자열: status, clips, merged_output.
    """
    try:
        resolved_analysis_path, matches = _search_segments(video_path, query, analysis_path, max_segments)
        if not resolved_analysis_path:
            return json.dumps({
                "status": "error",
                "error": "analysis_not_found",
                "message": "분석 JSON이 없습니다. analyze_video 후 다시 호출하세요.",
            }, ensure_ascii=False)
        if not matches:
            return json.dumps({
                "status": "error",
                "error": "no_match",
                "query": query,
                "analysis_path": resolved_analysis_path,
            }, ensure_ascii=False)

        matches = sorted(matches, key=lambda item: item["start_ms"])
        padding_ms = max(0, int(padding_ms))
        clips = []
        for i, match in enumerate(matches):
            start_ms = max(0, int(match["start_ms"]) - padding_ms)
            end_ms = int(match["end_ms"]) + padding_ms
            per_clip_output = output_path if output_path and len(matches) == 1 and not merge else None
            cut_result = cut_video.invoke({
                "video_path": video_path,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "output_path": per_clip_output,
            })
            if isinstance(cut_result, str) and cut_result.startswith("ERROR"):
                clips.append({"match": match, "status": "error", "error": cut_result})
                continue
            clips.append({
                "match_index": i,
                "source_segment": match,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "output": cut_result,
                "status": "success",
            })

        successful_paths = [c["output"] for c in clips if c.get("status") == "success"]
        if not successful_paths:
            return json.dumps({
                "status": "error",
                "error": "all_cuts_failed",
                "clips": clips,
            }, ensure_ascii=False)

        merged_output = None
        if merge:
            merged_output = merge_video.invoke({
                "clip_paths": successful_paths,
                "output_path": output_path,
            })
            if isinstance(merged_output, str) and merged_output.startswith("ERROR"):
                return json.dumps({
                    "status": "error",
                    "error": "merge_failed",
                    "merge_error": merged_output,
                    "clips": clips,
                }, ensure_ascii=False)

        return json.dumps({
            "status": "success",
            "query": query,
            "analysis_path": resolved_analysis_path,
            "clips": clips,
            "merged_output": merged_output,
        }, ensure_ascii=False)

    except Exception as e:
        logger.exception("cut_by_description 예외")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


TOOLS = [
    cut_video,
    merge_video,
    search_video_segments,
    cut_by_description,
]
