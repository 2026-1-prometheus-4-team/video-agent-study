"""
영상 편집 Tool - edit_expert 전용.

담당 범위:
- cut_video: 타임스탬프(ms) 기준 구간 추출
- merge_video: FFmpeg concat demuxer 방식으로 클립 병합
- search_video_segments: 분석 JSON에서 내용 기반 구간 검색
- cut_by_description: 내용 기반 검색 후 해당 구간 자동 추출
- remove_video_segments: 지정한 불필요 구간을 제거하고 나머지를 연결
- remove_by_description: 내용 기반 검색 후 해당 구간을 제거
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
from collections import Counter
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


# =============================================================
# origin 사이드카 — 클립이 원본의 어느 구간인지 추적
#
# cut/merge 결과물 옆에 <파일>.origin.json 을 남긴다. 자막 생성 시
# 재전사 대신 원본 분석 JSON 의 transcript 를 시간축 보정해 재사용하기 위함.
# =============================================================

def _origin_path(video_path: str) -> str:
    return f"{video_path}.origin.json"


def _write_origin(output_path: str, clips: list[dict]) -> None:
    """clips: [{source, start_ms, end_ms, offset_ms}] — offset_ms 는 결과물 내 시작 위치."""
    try:
        with open(_origin_path(output_path), "w", encoding="utf-8") as f:
            json.dump({"clips": clips}, f, ensure_ascii=False, indent=2)
    except OSError:
        logger.warning("origin 사이드카 저장 실패: %s", output_path, exc_info=True)


def _read_origin(video_path: str) -> Optional[list[dict]]:
    path = _origin_path(video_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("clips")
    except (OSError, json.JSONDecodeError):
        return None


def _probe_duration_ms(path: str) -> int:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, encoding="utf-8", errors="ignore",
        )
        return int(float(result.stdout.strip()) * 1000) if result.returncode == 0 else 0
    except Exception:
        return 0


# 발화 경계 스냅 시 한쪽으로 늘릴 수 있는 최대 시간.
# 이보다 긴 발화 한가운데를 자르는 경우는 의도적 컷으로 보고 그대로 둔다.
_SNAP_MAX_EXTEND_MS = 4000


def _snap_to_speech(source: str, start_ms: int, end_ms: int) -> tuple[int, int]:
    """컷 지점이 발화 도중이면 그 발화의 시작/끝까지 구간을 넓힌다.

    "집이 너무 더러워서" 하는 도중에 잘리면 말이 뚝 끊겨 어색하므로,
    Whisper 원본 전사(videos/subtitles/<원본>.json)를 보고 경계를 맞춘다.
    전사가 없으면 원래 값 그대로 반환.
    """
    try:
        from agent.tools.subtitle import _source_speech
        speech = _source_speech(source)
    except Exception:
        return start_ms, end_ms

    if not speech:
        return start_ms, end_ms

    new_start, new_end = start_ms, end_ms

    for seg in speech:
        s, e = seg["start_ms"], seg["end_ms"]
        # 시작점이 발화 한가운데 -> 발화 시작으로 당김
        if s < start_ms < e and (start_ms - s) <= _SNAP_MAX_EXTEND_MS:
            new_start = min(new_start, s)
        # 끝점이 발화 한가운데 -> 발화 끝까지 밀어줌
        if s < end_ms < e and (e - end_ms) <= _SNAP_MAX_EXTEND_MS:
            new_end = max(new_end, e)

    return max(0, new_start), new_end


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


def _scoped_analysis_stem(video_path: str) -> Optional[str]:
    """video_analysis 의 분석 JSON 명명 규칙을 그대로 사용 (규칙 이중화 방지).

    video_analysis 는 cv2 / google-genai 를 module import 하므로 지연 임포트.
    실패해도 아래 videos/ 기준 후보로 폴백하면 되니 조용히 None.
    """
    try:
        from agent.tools.video_analysis import analysis_stem

        return analysis_stem(video_path, VIDEOS_DIR)
    except Exception:
        return None


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
    candidates: list[str] = []

    # videos/ 밖(편집 결과물 등) 영상의 분석은 basename 충돌을 피하려고
    # <stem>_<경로해시>_analysis.json 으로 저장된다 (video_analysis.analysis_stem).
    # 그 파일이 이 영상의 정확한 분석이므로 원본 basename 후보보다 먼저 확인.
    scoped = _scoped_analysis_stem(video_path)
    if scoped and scoped != base:
        candidates.append(os.path.join(VIDEOS_DIR, f"{scoped}_analysis.json"))

    candidates += [
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


def _orientation_args(video_path: str) -> tuple[list[str], list[str]]:
    """신뢰 가능한 시각 방향 판정이 있으면 FFmpeg 입력/필터 인자를 반환."""
    loaded = _load_analysis(video_path)
    if not loaded:
        return [], []
    orientation = loaded[1].get("orientation")
    if not isinstance(orientation, dict):
        return [], []
    try:
        degrees = int(orientation.get("clockwise_degrees"))
        confidence = float(orientation.get("confidence", 0.0))
    except (TypeError, ValueError):
        return [], []
    if degrees not in (0, 90, 180, 270) or confidence < 0.7:
        return [], []

    filters = {
        0: [],
        90: ["transpose=clock"],
        180: ["hflip,vflip"],
        270: ["transpose=cclock"],
    }
    # -noautorotate는 입력 옵션이므로 -i보다 앞에 와야 한다.
    return ["-noautorotate"], filters[degrees]


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
        segment.get("transcript"),
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


# =============================================================
# 임베딩 기반 시맨틱 검색
#
# Gemini embedding API (generateContent 와 쿼터 버킷 분리) 로
# 세그먼트 설명 <-> 쿼리를 벡터화해 코사인 유사도로 매칭.
# 세그먼트 임베딩은 {analysis}.emb.json 에 캐싱 -> 영상당 1회만 계산.
# 임베딩 실패 시 키워드 스코어링으로 자동 폴백.
# =============================================================

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001")
EMBEDDING_DIM = 768
SEMANTIC_MIN_SCORE = float(os.getenv("SEMANTIC_MIN_SCORE", "0.5"))
SEMANTIC_SCORE_WINDOW = float(os.getenv("SEMANTIC_SCORE_WINDOW", "0.05"))
SEMANTIC_CANDIDATE_MULTIPLIER = int(
    os.getenv("SEMANTIC_CANDIDATE_MULTIPLIER", "4")
)


EMBEDDING_BATCH = 100  # Gemini embed API 는 요청당 최대 100개


def _embed_texts(texts: list[str], task_type: str) -> Optional[list[list[float]]]:
    """Gemini embedding 호출 (100개씩 배치 분할). 실패 시 None (폴백 유도)."""
    try:
        from google import genai
        from google.genai import types

        client = genai.Client()
        vectors: list[list[float]] = []
        for i in range(0, len(texts), EMBEDDING_BATCH):
            batch = texts[i:i + EMBEDDING_BATCH]
            result = client.models.embed_content(
                model=EMBEDDING_MODEL,
                contents=batch,
                config=types.EmbedContentConfig(
                    task_type=task_type,
                    output_dimensionality=EMBEDDING_DIM,
                ),
            )
            vectors.extend(list(e.values) for e in result.embeddings)
        return vectors
    except Exception:
        logger.warning("임베딩 호출 실패 -> 키워드 검색 폴백", exc_info=True)
        return None


def _cosine_matrix(query_vec: list[float], corpus: list[list[float]]) -> list[float]:
    import numpy as np

    q = np.asarray(query_vec, dtype=np.float32)
    m = np.asarray(corpus, dtype=np.float32)
    q = q / (np.linalg.norm(q) + 1e-8)
    m = m / (np.linalg.norm(m, axis=1, keepdims=True) + 1e-8)
    return (m @ q).tolist()


def _corpus_embeddings(analysis_path: str, segments: list[dict]) -> Optional[list[list[float]]]:
    """세그먼트 임베딩 로드/생성. {analysis}.emb.json 캐시 사용."""
    import hashlib

    blobs = [s.get("_search_blob", "") for s in segments]
    digest = hashlib.md5("\n".join(blobs).encode("utf-8")).hexdigest()
    cache_path = f"{analysis_path}.emb.json"

    if os.path.exists(cache_path):
        try:
            with open(cache_path, encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("hash") == digest and len(cached.get("vectors", [])) == len(blobs):
                return cached["vectors"]
        except Exception:
            pass

    vectors = _embed_texts(blobs, task_type="RETRIEVAL_DOCUMENT")
    if vectors is None:
        return None

    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"hash": digest, "model": EMBEDDING_MODEL, "vectors": vectors}, f)
        logger.info("세그먼트 임베딩 캐시 저장: %s (%d개)", cache_path, len(vectors))
    except OSError:
        pass
    return vectors


def _semantic_scores(analysis_path: str, segments: list[dict], query: str) -> Optional[list[float]]:
    corpus = _corpus_embeddings(analysis_path, segments)
    if corpus is None:
        return None
    query_vecs = _embed_texts([query], task_type="RETRIEVAL_QUERY")
    if not query_vecs:
        return None
    return _cosine_matrix(query_vecs[0], corpus)


DEFAULT_MERGE_GAP_MS = int(os.getenv("EDIT_MERGE_GAP_MS", "500"))


def _merge_adjacent_matches(matches: list[dict], gap_ms: int) -> list[dict]:
    """인접/중첩 매칭을 하나의 구간으로 union.

    분석 세그먼트는 고정 3초 창이라 연속 장면이 조각 매칭으로 흩어진다
    ("가족 장면" 30초 = 10 조각). gap_ms 이내로 붙어 있으면 병합.
    """
    if not matches or gap_ms < 0:
        return matches
    items = sorted((dict(m) for m in matches), key=lambda m: m["start_ms"])
    merged: list[dict] = [items[0]]
    merged[0]["merged_from"] = 1
    for m in items[1:]:
        cur = merged[-1]
        if m["start_ms"] - cur["end_ms"] <= gap_ms:
            cur["end_ms"] = max(cur["end_ms"], m["end_ms"])
            cur["duration_ms"] = cur["end_ms"] - cur["start_ms"]
            desc = m.get("description") or ""
            if desc and desc not in (cur.get("description") or ""):
                cur["description"] = f"{cur.get('description', '')} / {desc}"[:300]
            cur["score"] = max(cur.get("score", 0), m.get("score", 0))
            cur["merged_from"] = cur.get("merged_from", 1) + 1
        else:
            m["merged_from"] = 1
            merged.append(m)
    return merged


def _public_segment(segment: dict, score: float, match_type: str) -> dict:
    public = {k: v for k, v in segment.items() if not k.startswith("_")}
    public["score"] = round(float(score), 3) if match_type == "semantic" else score
    public["match_type"] = match_type
    return public


def _search_segments(
    video_path: str,
    query: str,
    analysis_path: Optional[str],
    max_results: int,
    queries: Optional[list[str]] = None,
    merge_gap_ms: Optional[int] = None,
) -> dict:
    """검색 코어. 신뢰도 메타 + 인접 병합 + near_misses 포함 결과 반환.

    Returns:
        {analysis_path: str|None, matches: [...], stats: {...}, near_misses: [...]}
        analysis_path 가 None 이면 분석 JSON 자체가 없음.
    """
    gap_ms = DEFAULT_MERGE_GAP_MS if merge_gap_ms is None else max(0, int(merge_gap_ms))
    all_queries = [q for q in ([query] + list(queries or [])) if q and q.strip()]
    if not all_queries:
        all_queries = [query]
    near_misses: list[dict] = []

    loaded = _load_analysis(video_path, analysis_path)
    if not loaded:
        return {"analysis_path": None, "matches": [], "stats": {}, "near_misses": []}

    resolved_analysis_path, analysis = loaded
    segments = _analysis_segments(analysis)
    stats: dict = {"segments_total": len(segments), "queries": all_queries}

    # 사용 가능한 세그먼트가 없으면 (빈/깨진 분석 JSON) 임베딩 경로가 빈 행렬로
    # numpy AxisError 를 낸다 — 검색 자체가 무의미하므로 즉시 no_match.
    if not segments:
        return {
            "analysis_path": resolved_analysis_path,
            "matches": [],
            "stats": stats,
            "near_misses": [],
        }

    # 1차: 임베딩 시맨틱 검색 (EDIT_SEMANTIC_SEARCH=0 이면 비활성).
    # 쿼리 확장: 각 쿼리로 코사인 계산 후 세그먼트별 max.
    if os.getenv("EDIT_SEMANTIC_SEARCH", "1") != "0":
        best_sims: Optional[list[float]] = None
        for q in all_queries:
            sims = _semantic_scores(resolved_analysis_path, segments, q)
            if sims is None:
                best_sims = None
                break
            if best_sims is None:
                best_sims = list(sims)
            else:
                best_sims = [max(a, b) for a, b in zip(best_sims, sims)]

        if best_sims is not None:
            ranked = sorted(
                zip(segments, best_sims), key=lambda t: (-t[1], t[0]["start_ms"])
            )
            top_score = ranked[0][1] if ranked else 0.0
            # embedding 모델/언어에 따라 무관한 문장도 0.5 이상으로 몰리는
            # 경우가 있다. 고정 임계값만 쓰면 모든 1초 창이 이어져 영상 전체가
            # 하나의 match가 된다. 최고점 근처 후보만 남겨 상대적 관련도를 보존한다.
            effective_threshold = max(
                SEMANTIC_MIN_SCORE,
                top_score - max(0.0, SEMANTIC_SCORE_WINDOW),
            )
            candidate_limit = max(
                max_results,
                max_results * max(1, SEMANTIC_CANDIDATE_MULTIPLIER),
            )
            above = [
                _public_segment(seg, sim, "semantic")
                for seg, sim in ranked
                if sim >= effective_threshold
            ][:candidate_limit]
            stats.update({
                "match_type": "semantic",
                "threshold": SEMANTIC_MIN_SCORE,
                "effective_threshold": round(effective_threshold, 3),
                "candidate_limit": candidate_limit,
                "total_above_threshold": len(above),
                "top_score": round(top_score, 3),
                "second_score": round(ranked[1][1], 3) if len(ranked) > 1 else 0.0,
            })
            stats["margin"] = round(stats["top_score"] - stats["second_score"], 3)
            if above:
                merged = _merge_adjacent_matches(above, gap_ms)
                merged.sort(key=lambda s: (-s["score"], s["start_ms"]))
                return {
                    "analysis_path": resolved_analysis_path,
                    "matches": merged[:max_results],
                    "stats": stats,
                    "near_misses": [],
                }
            # 임계 미달 — 상위 후보를 near_misses 로 챙겨두되 *키워드 폴백은
            # 계속 진행*한다. 고유명사/로마자처럼 임베딩이 약한 쿼리는 literal
            # 매칭이 정답인 경우가 많아, 여기서 끊으면 되던 검색이 죽는다.
            near_misses = [
                _public_segment(seg, sim, "semantic")
                for seg, sim in ranked[:3]
                if sim > 0.25
            ]

    # 2차: 키워드 스코어링 (폴백). 쿼리 확장: max 점수.
    scored = []
    for segment in segments:
        score = max(_score_segment(q, segment) for q in all_queries)
        if score > 0:
            scored.append(_public_segment(segment, score, "keyword"))

    scored.sort(key=lambda s: (-s["score"], s["start_ms"]))
    if scored:
        top_keyword_score = scored[0]["score"]
        # 완전 구문 매치(20점+) 또는 복수 핵심어 매치(8점+)가 있으면
        # 단어 하나만 우연히 겹친 4점 후보를 제거한다. remove_by_description에서
        # 약한 후보까지 실제 삭제되는 것을 막기 위한 정밀도 우선 정책이다.
        if top_keyword_score >= 20:
            keyword_floor = 20
        elif top_keyword_score >= 8:
            keyword_floor = 8
        else:
            keyword_floor = 1
        scored = [item for item in scored if item["score"] >= keyword_floor]
        # 키워드가 잡았으면 그 통계로 덮어쓴다 (semantic stats 는 참고용 유지).
        stats.update({
            "match_type": "keyword",
            "keyword_floor": keyword_floor,
            "total_above_threshold": len(scored),
            "top_score": scored[0]["score"],
            "second_score": scored[1]["score"] if len(scored) > 1 else 0,
        })
        stats["margin"] = stats["top_score"] - stats["second_score"]
    merged = _merge_adjacent_matches(scored, gap_ms) if scored else []
    merged.sort(key=lambda s: (-s["score"], s["start_ms"]))
    return {
        "analysis_path": resolved_analysis_path,
        "matches": merged[:max_results],
        "stats": stats,
        "near_misses": [] if merged else near_misses,
    }


@tool
def cut_video(
    video_path: str,
    start_ms: int,
    end_ms: int,
    output_path: Optional[str] = None,
    snap_to_speech: bool = True,
) -> str:
    """영상 파일에서 지정 구간(start_ms ~ end_ms)을 잘라내 새 파일로 저장.

    Args:
        video_path: 원본 영상 경로. 절대경로, 프로젝트 루트 상대경로, 또는 videos/ 기준 파일명.
        start_ms: 시작 시각(ms). 예: 11분 15초 = 675000.
        end_ms: 종료 시각(ms). start_ms보다 커야 함.
        output_path: 저장 경로. 생략 시 outputs/cut_<id>.mp4.
        snap_to_speech: 컷 지점이 말하는 도중이면 그 발화의 시작/끝까지 자동으로
            구간을 넓혀 말이 잘리지 않게 한다. 기본 True.
            정확한 프레임 단위 컷이 필요하면 False.

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

        if snap_to_speech:
            snapped = _snap_to_speech(resolved, start_ms, end_ms)
            if snapped != (start_ms, end_ms):
                logger.info(
                    "발화 경계 스냅: %dms~%dms -> %dms~%dms",
                    start_ms, end_ms, snapped[0], snapped[1],
                )
                start_ms, end_ms = snapped

        output_path = _resolve_output_path(output_path, "cut", resolved)

        start_sec = start_ms / 1000.0
        duration_sec = (end_ms - start_ms) / 1000.0
        # 프레임 정확도 컷: -c copy 는 키프레임 단위로 밀려서 (수 초 오차 + concat 시
        # 재생 깨짐) 재인코딩으로 자름. 인코딩 설정을 통일해 merge concat 도 안전.
        orientation_input, orientation_filters = _orientation_args(resolved)
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start_sec:.3f}",
            *orientation_input,
            "-i", resolved,
            "-t", f"{duration_sec:.3f}",
            *(
                ["-vf", ",".join(orientation_filters)]
                if orientation_filters
                else []
            ),
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
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

        # 이 클립이 원본의 어느 구간인지 기록 (자막 재사용용)
        _write_origin(output_path, [{
            "source": resolved,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "offset_ms": 0,
        }])

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
    aspect_ratio: Optional[str] = None,
    mode: str = "pad",
) -> str:
    """여러 클립을 순서대로 이어 붙여 하나의 영상으로 저장.

    Args:
        clip_paths: 병합할 클립 경로 목록. 순서 그대로 concat.
        output_path: 저장 경로. 생략 시 outputs/merged_<id>.mp4.
        aspect_ratio: 혼합 해상도 클립의 목표 비율. "9:16", "16:9", "1:1", "4:5".
            생략하면 가장 흔한 클립 해상도를 사용한다.
        mode: aspect_ratio 지정 시 "crop"은 화면을 꽉 채우고 "pad"는 전체를 보존한다.

    Returns:
        성공 시 출력 파일 절대경로. 실패 시 "ERROR: ..." 문자열.
    """
    try:
        if not clip_paths:
            return "ERROR: clip_paths 가 비어 있습니다."
        if aspect_ratio is not None and aspect_ratio not in _TARGET_RESOLUTIONS:
            return f"ERROR: 지원하지 않는 비율: {aspect_ratio}"
        if mode not in {"crop", "pad"}:
            return f"ERROR: mode 는 crop 또는 pad 만 가능: {mode}"
        if len(clip_paths) == 1:
            if aspect_ratio:
                resolved = _resolve_video_path(clip_paths[0])
                output = _resolve_output_path(output_path, "merged", resolved)
                return resize_video.invoke({
                    "video_path": resolved,
                    "aspect_ratio": aspect_ratio,
                    "mode": mode,
                    "output_path": output,
                })
            return _resolve_video_path(clip_paths[0])

        resolved_clips = [_resolve_video_path(p) for p in clip_paths]
        for path in resolved_clips:
            if not os.path.exists(path):
                return f"ERROR: 클립 파일을 찾을 수 없음: {path}"

        output_path = _resolve_output_path(output_path, "merged", resolved_clips[0])
        metas = [_ffprobe_video_meta(path) for path in resolved_clips]
        compatible = _streams_compatible(metas) and aspect_ratio is None

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
            dimensions = [
                (int(meta["width"]), int(meta["height"]))
                for meta in metas
                if meta and meta.get("width") and meta.get("height")
            ]
            # 혼합 가로/세로 소스에서 첫 클립만 기준으로 삼으면 나머지 다수
            # 클립이 작은 letterbox로 축소된다. 가장 흔한 해상도를 기준으로
            # 정규화하고, 빈 메타데이터일 때만 일반 가로 규격을 쓴다.
            if aspect_ratio:
                width, height = _TARGET_RESOLUTIONS[aspect_ratio]
            else:
                width, height = (
                    Counter(dimensions).most_common(1)[0][0]
                    if dimensions
                    else (1280, 720)
                )
            all_have_audio = all(_ffprobe_has_audio(path) for path in resolved_clips)
            target_fps = max(1, min(60, int(os.getenv("EDIT_OUTPUT_FPS", "30"))))
            inputs = []
            filter_parts = []
            concat_inputs = []
            for idx, path in enumerate(resolved_clips):
                inputs.extend(["-i", path])
                if aspect_ratio and mode == "crop":
                    video_filter = (
                        f"[{idx}:v]scale={width}:{height}:"
                        "force_original_aspect_ratio=increase,"
                        f"crop={width}:{height},fps={target_fps},setsar=1[v{idx}]"
                    )
                else:
                    video_filter = (
                        f"[{idx}:v]scale={width}:{height}:"
                        "force_original_aspect_ratio=decrease,"
                        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
                        f"fps={target_fps},setsar=1[v{idx}]"
                    )
                filter_parts.append(video_filter)
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

        # 각 클립의 원본 구간을 누적 오프셋과 함께 이어붙여 기록
        merged_clips: list[dict] = []
        offset = 0
        for clip in resolved_clips:
            clip_ms = _probe_duration_ms(clip)
            origin = _read_origin(clip)
            if origin:
                for seg in origin:
                    merged_clips.append({
                        "source": seg.get("source"),
                        "start_ms": seg.get("start_ms", 0),
                        "end_ms": seg.get("end_ms", 0),
                        "offset_ms": offset + seg.get("offset_ms", 0),
                    })
            else:
                # origin 없는 클립(외부 파일 등)은 자기 자신을 원본으로
                merged_clips.append({
                    "source": clip,
                    "start_ms": 0,
                    "end_ms": clip_ms,
                    "offset_ms": offset,
                })
            offset += clip_ms
        _write_origin(output_path, merged_clips)

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
    queries: Optional[list[str]] = None,
    merge_gap_ms: Optional[int] = None,
) -> str:
    """분석 JSON에서 자연어 query와 일치하는 영상 구간을 찾는다.

    모호한 요청("가족", "지루한 부분")은 queries 로 동의어/구체 표현을 함께
    넘기면 재현율이 올라간다 (예: ["가족", "여러 사람", "아이와 부모"]).
    인접한 매칭(기본 0.5초 이내)은 하나의 구간으로 병합돼 돌아온다.

    Args:
        video_path: 원본 영상 경로 또는 파일명.
        query: 찾을 장면 설명. 예: "타워 브리지", "공중전화", "노란 상자".
        analysis_path: 분석 JSON 경로. 생략 시 videos/<영상명>_analysis.json 자동 탐색.
        max_results: 최대 반환 개수.
        queries: 추가 검색 표현 목록 (동의어 확장). 각 세그먼트는 최고 점수 채택.
        merge_gap_ms: 이 간격(ms) 이하로 붙은 매칭을 병합. 기본 500.

    Returns:
        JSON 문자열:
        - 매칭 있음: {status:"success", matches:[{start_ms,end_ms,description,score,
          match_type,merged_from}], stats:{top_score,margin,total_above_threshold,...}}
        - 매칭 없음: {status:"no_match", near_misses:[임계 미달 상위 후보], stats}
          -> 임의로 자르지 말고 near_misses 를 사용자에게 후보로 제시할 것.
        stats.margin 이 작으면 (동점 후보 다수) 사용자 확인을 권장.
    """
    try:
        max_results = max(1, int(max_results))
        result = _search_segments(
            video_path, query, analysis_path, max_results,
            queries=queries, merge_gap_ms=merge_gap_ms,
        )
        if not result["analysis_path"]:
            return json.dumps({
                "status": "error",
                "error": "analysis_not_found",
                "message": "분석 JSON이 없습니다. analyze_video 후 다시 호출하세요.",
            }, ensure_ascii=False)

        if not result["matches"]:
            return json.dumps({
                "status": "no_match",
                "query": query,
                "analysis_path": result["analysis_path"],
                "near_misses": result["near_misses"],
                "stats": result["stats"],
                "message": (
                    "임계값 이상 매칭 없음. near_misses 가 있으면 사용자에게 "
                    "후보로 확인받고, 없으면 쿼리를 바꿔 재시도하거나 사용자에게 물어볼 것."
                ),
            }, ensure_ascii=False)

        return json.dumps({
            "status": "success",
            "query": query,
            "analysis_path": result["analysis_path"],
            "matches": result["matches"],
            "stats": result["stats"],
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
        search = _search_segments(video_path, query, analysis_path, max_segments)
        resolved_analysis_path = search["analysis_path"]
        matches = search["matches"]
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
                "near_misses": search["near_misses"],
                "stats": search["stats"],
            }, ensure_ascii=False)

        matches = sorted(matches, key=lambda item: item["start_ms"])
        padding_ms = max(0, int(padding_ms))

        # padding 적용 후 중첩 구간 union — 겹치는 클립을 각각 잘라 병합하면
        # 같은 프레임이 반복 재생된다.
        padded: list[dict] = []
        for match in matches:
            start_ms = max(0, int(match["start_ms"]) - padding_ms)
            end_ms = int(match["end_ms"]) + padding_ms
            if padded and start_ms <= padded[-1]["end_ms"]:
                padded[-1]["end_ms"] = max(padded[-1]["end_ms"], end_ms)
                padded[-1]["sources"].append(match)
            else:
                padded.append({"start_ms": start_ms, "end_ms": end_ms, "sources": [match]})

        clips = []
        for i, rng in enumerate(padded):
            start_ms = rng["start_ms"]
            end_ms = rng["end_ms"]
            match = rng["sources"][0]
            # 구간이 하나면 merge 여부와 무관하게 요청 경로로 바로 쓴다.
            # merge_video 는 클립 1개면 입력 경로를 그대로 반환해서 output_path 를
            # 무시하므로, 여기서 안 쓰면 결과가 요청한 경로에 안 생긴다.
            per_clip_output = output_path if output_path and len(padded) == 1 else None
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
                "source_segments": rng["sources"],
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


def _normalize_removal_ranges(
    ranges: list[dict],
    duration_ms: int,
) -> list[dict]:
    normalized: list[dict] = []
    for item in ranges:
        if not isinstance(item, dict):
            continue
        try:
            start_ms = max(0, int(round(float(item.get("start_ms", 0)))))
            end_ms = min(
                duration_ms,
                int(round(float(item.get("end_ms", duration_ms)))),
            )
        except (TypeError, ValueError):
            continue
        if end_ms <= start_ms:
            continue
        if normalized and start_ms <= normalized[-1]["end_ms"]:
            normalized[-1]["end_ms"] = max(normalized[-1]["end_ms"], end_ms)
        else:
            normalized.append({"start_ms": start_ms, "end_ms": end_ms})
    return normalized


@tool
def remove_video_segments(
    video_path: str,
    ranges: list[dict],
    output_path: Optional[str] = None,
    snap_to_speech: bool = True,
) -> str:
    """지정한 불필요 구간들을 제거하고 나머지 구간을 순서대로 이어 붙인다.

    `cut_video`가 지정 구간을 뽑는 keep 방식이라면, 이 도구는 지정 구간을
    버리는 remove 방식이다. 여러 제거 구간이 겹치면 자동으로 합친다.

    Args:
        video_path: 원본 영상 경로 또는 파일명.
        ranges: 제거할 구간 목록. 예:
            [{"start_ms": 5000, "end_ms": 8000}, ...]
        output_path: 최종 저장 경로. 생략 시 outputs/removed_<id>.mp4.
        snap_to_speech: 제거 경계가 발화 중간이면 해당 발화 전체를 제거하도록
            경계를 넓힌다. 보존 구간 자체에는 추가 스냅을 적용하지 않는다.

    Returns:
        성공 시 최종 파일 절대경로. 실패 시 "ERROR: ..." 문자열.
    """
    try:
        resolved = _resolve_video_path(video_path)
        if not os.path.exists(resolved):
            return f"ERROR: 파일을 찾을 수 없음: {resolved}"

        duration_ms = _probe_duration_ms(resolved)
        if duration_ms <= 0:
            return f"ERROR: 영상 길이를 확인할 수 없음: {resolved}"

        prepared: list[dict] = []
        for item in ranges or []:
            if not isinstance(item, dict):
                continue
            try:
                start_ms = int(round(float(item.get("start_ms", 0))))
                end_ms = int(round(float(item.get("end_ms", 0))))
            except (TypeError, ValueError):
                continue
            if snap_to_speech and end_ms > start_ms:
                start_ms, end_ms = _snap_to_speech(
                    resolved,
                    max(0, start_ms),
                    min(duration_ms, end_ms),
                )
            prepared.append({"start_ms": start_ms, "end_ms": end_ms})

        removals = _normalize_removal_ranges(
            sorted(prepared, key=lambda item: item.get("start_ms", 0)),
            duration_ms,
        )
        if not removals:
            return "ERROR: 유효한 제거 구간이 없습니다."

        kept: list[dict] = []
        cursor = 0
        for removal in removals:
            if removal["start_ms"] > cursor:
                kept.append({"start_ms": cursor, "end_ms": removal["start_ms"]})
            cursor = max(cursor, removal["end_ms"])
        if cursor < duration_ms:
            kept.append({"start_ms": cursor, "end_ms": duration_ms})
        kept = [item for item in kept if item["end_ms"] > item["start_ms"]]
        if not kept:
            return "ERROR: 제거 구간이 영상 전체를 덮습니다."

        output_path = _resolve_output_path(output_path, "removed", resolved)
        if len(kept) == 1:
            return cut_video.invoke({
                "video_path": resolved,
                "start_ms": kept[0]["start_ms"],
                "end_ms": kept[0]["end_ms"],
                "output_path": output_path,
                "snap_to_speech": False,
            })

        with tempfile.TemporaryDirectory(prefix="vibeedit_remove_") as temp_dir:
            clips: list[str] = []
            for index, item in enumerate(kept):
                clip_path = os.path.join(temp_dir, f"keep_{index:03d}.mp4")
                result = cut_video.invoke({
                    "video_path": resolved,
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "output_path": clip_path,
                    "snap_to_speech": False,
                })
                if isinstance(result, str) and result.startswith("ERROR"):
                    return result
                clips.append(result)
            return merge_video.invoke({
                "clip_paths": clips,
                "output_path": output_path,
            })
    except Exception as e:
        logger.exception("remove_video_segments 예외")
        return f"ERROR: {e}"


@tool
def remove_by_description(
    video_path: str,
    query: str,
    analysis_path: Optional[str] = None,
    padding_ms: int = 0,
    max_segments: int = 5,
    output_path: Optional[str] = None,
    snap_to_speech: bool = True,
) -> str:
    """분석 JSON에서 불필요한 장면을 찾아 제거하고 나머지를 이어 붙인다.

    `"침묵과 반복 장면을 빼줘"`처럼 검색된 장면을 결과에서 제외해야 할 때
    사용한다. 필요한 장면만 추출하려면 `cut_by_description`을 사용한다.
    """
    try:
        search = _search_segments(
            video_path,
            query,
            analysis_path,
            max_segments,
        )
        if not search["analysis_path"]:
            return json.dumps({
                "status": "error",
                "error": "analysis_not_found",
                "message": "분석 JSON이 없습니다. analyze_video 후 다시 호출하세요.",
            }, ensure_ascii=False)
        if not search["matches"]:
            return json.dumps({
                "status": "error",
                "error": "no_match",
                "query": query,
                "analysis_path": search["analysis_path"],
                "near_misses": search["near_misses"],
                "stats": search["stats"],
            }, ensure_ascii=False)

        padding_ms = max(0, int(padding_ms))
        ranges = [
            {
                "start_ms": max(0, int(match["start_ms"]) - padding_ms),
                "end_ms": int(match["end_ms"]) + padding_ms,
            }
            for match in search["matches"]
        ]
        output = remove_video_segments.invoke({
            "video_path": video_path,
            "ranges": ranges,
            "output_path": output_path,
            "snap_to_speech": snap_to_speech,
        })
        if isinstance(output, str) and output.startswith("ERROR"):
            return json.dumps({
                "status": "error",
                "error": "remove_failed",
                "detail": output,
                "matches": search["matches"],
            }, ensure_ascii=False)
        return json.dumps({
            "status": "success",
            "query": query,
            "analysis_path": search["analysis_path"],
            "removed_ranges": ranges,
            "matches": search["matches"],
            "output": output,
        }, ensure_ascii=False)
    except Exception as e:
        logger.exception("remove_by_description 예외")
        return json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False)


_ASPECT_RATIOS = {
    "9:16": (9, 16),    # 쇼츠 / 릴스 / 틱톡 (세로)
    "16:9": (16, 9),    # 유튜브 (가로)
    "1:1": (1, 1),      # 인스타 피드 (정사각)
    "4:5": (4, 5),      # 인스타 세로
}

_TARGET_RESOLUTIONS = {
    "9:16": (720, 1280),
    "16:9": (1280, 720),
    "1:1": (1080, 1080),
    "4:5": (1080, 1350),
}


@tool
def resize_video(
    video_path: str,
    aspect_ratio: str = "9:16",
    mode: str = "crop",
    output_path: Optional[str] = None,
) -> str:
    """영상의 화면 비율(가로세로)을 변환한다. 쇼츠/릴스용 세로 변환 등.

    cut_video 가 '시간'을 자른다면 이 도구는 '화면 영역'을 바꾼다.
    쇼츠를 만들 때는 cut/merge 로 편집을 끝낸 뒤 마지막에 이 도구를 호출한다.

    Args:
        video_path: 원본 영상 경로. 절대경로, 프로젝트 루트 상대경로, 또는 videos/ 기준 파일명.
        aspect_ratio: 목표 비율. "9:16"(쇼츠·세로) | "16:9"(유튜브) | "1:1" | "4:5".
        mode: "crop" 은 화면 가장자리를 잘라 꽉 채움(권장, 여백 없음).
              "pad" 는 원본 전체를 유지하고 남는 곳을 검은 여백으로 채움.
        output_path: 저장 경로. 생략 시 outputs/resized_<id>.mp4.

    Returns:
        성공 시 출력 파일 절대경로. 실패 시 "ERROR: ..." 문자열.
    """
    try:
        resolved = _resolve_video_path(video_path)
        if not os.path.exists(resolved):
            return f"ERROR: 파일을 찾을 수 없음: {resolved}"

        if aspect_ratio not in _ASPECT_RATIOS:
            return (
                f"ERROR: 지원하지 않는 비율: {aspect_ratio}. "
                f"사용 가능: {list(_ASPECT_RATIOS)}"
            )
        if mode not in ("crop", "pad"):
            return f"ERROR: mode 는 crop 또는 pad 만 가능: {mode}"

        # 플랫폼별 실용 표준 해상도를 사용한다. 원본 높이만 기준으로 계산하면
        # 1280x720 가로 영상을 9:16으로 바꿀 때 404x720까지 축소된다.
        meta = _ffprobe_video_meta(resolved)
        src_w = (meta or {}).get("width") or 1920
        src_h = (meta or {}).get("height") or 1080
        out_w, out_h = _TARGET_RESOLUTIONS[aspect_ratio]

        if mode == "crop":
            # 중앙 기준으로 꽉 채우고 넘치는 부분 잘라냄
            vf = (
                f"scale={out_w}:{out_h}:force_original_aspect_ratio=increase,"
                f"crop={out_w}:{out_h}"
            )
        else:
            # 전체를 담고 남는 영역은 검은 여백
            vf = (
                f"scale={out_w}:{out_h}:force_original_aspect_ratio=decrease,"
                f"pad={out_w}:{out_h}:(ow-iw)/2:(oh-ih)/2:black"
            )

        output_path = _resolve_output_path(output_path, "resized", resolved)

        cmd = [
            "ffmpeg", "-y",
            "-i", resolved,
            "-vf", f"{vf},setsar=1",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            output_path,
        ]

        logger.info(
            "resize_video: %s -> %s (%s, %dx%d)",
            os.path.basename(resolved), aspect_ratio, mode, out_w, out_h,
        )
        t0 = time.monotonic()
        code, stderr = _run_ffmpeg(cmd)
        elapsed = time.monotonic() - t0

        if code != 0:
            return f"ERROR: FFmpeg 실패 (rc={code}): {stderr[-300:]}"
        if not os.path.exists(output_path):
            return f"ERROR: 출력 파일 생성 실패: {output_path}"

        # pad 모드: 콘텐츠 영역을 수학적으로 계산해 사이드카 저장
        # subtitle_cues 가 cropdetect 대신 이 값을 읽어 자막을 콘텐츠 안에 배치
        if mode == "pad":
            import json as _json
            scale = min(out_w / src_w, out_h / src_h)
            content_w = round(src_w * scale)
            content_h = round(src_h * scale)
            content_x = (out_w - content_w) // 2
            content_y = (out_h - content_h) // 2
            pad_info = {"x": content_x, "y": content_y, "w": content_w, "h": content_h}
            with open(output_path + ".pad.json", "w", encoding="utf-8") as _f:
                _json.dump(pad_info, _f)
            logger.info("pad 사이드카 저장: %s", pad_info)

        # 화면비만 바뀌고 시간축은 그대로 -> origin 승계
        origin = _read_origin(resolved)
        if origin:
            _write_origin(output_path, origin)

        logger.info("resize_video 완료 %.2fs -> %s", elapsed, output_path)
        return output_path

    except FileNotFoundError:
        return "ERROR: ffmpeg 바이너리를 찾을 수 없습니다."
    except Exception as e:
        logger.exception("resize_video 예외")
        return f"ERROR: {e}"


TOOLS = [
    cut_video,
    merge_video,
    search_video_segments,
    cut_by_description,
    remove_video_segments,
    remove_by_description,
    resize_video,
]
