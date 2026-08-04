"""업로드된 원본 영상의 라이브러리.

기존 업로드는 같은 파일을 다시 올릴 때마다 `name_1.mp4`, `name_2.mp4` 를
새로 만들었다. 실행이 중간에 실패하면 사용자는 같은 파일을 또 올려야 했고,
videos/ 에는 내용이 동일한 사본이 계속 쌓였다.

여기서는 내용 해시로 같은 영상을 식별해 이미 있는 파일을 재사용하고,
프론트가 라이브러리를 그릴 수 있도록 메타데이터(길이 · 해상도 · 썸네일)를
인덱스에 캐싱한다.

인덱스에 등록된 항목만 라이브러리에 노출된다. videos/ 에는 편집 산출물과
분석 사이드카가 섞여 있어서 디렉토리 스캔은 목록의 근거가 될 수 없다.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

INDEX_FILENAME = ".media_index.json"
THUMBNAIL_DIRNAME = "thumbnails"
SCHEMA_VERSION = 1

# 썸네일은 목록 카드에만 쓰이므로 가로 400px 이면 2x 디스플레이에서도 충분하다.
THUMBNAIL_WIDTH = 400
_FFMPEG_TIMEOUT_SEC = 30


def _index_path(videos_dir: Path) -> Path:
    return videos_dir / INDEX_FILENAME


def _thumbnail_dir(videos_dir: Path) -> Path:
    return videos_dir / THUMBNAIL_DIRNAME


def load_index(videos_dir: Path) -> dict[str, Any]:
    """인덱스 로드. 손상/부재 시 빈 인덱스 (업로드 자체를 막지 않는다)."""
    path = _index_path(videos_dir)
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "items": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("media index 로드 실패, 빈 인덱스로 시작: %s", path, exc_info=True)
        return {"schema_version": SCHEMA_VERSION, "items": {}}
    if not isinstance(data.get("items"), dict):
        return {"schema_version": SCHEMA_VERSION, "items": {}}
    return data


def save_index(videos_dir: Path, index: dict[str, Any]) -> None:
    path = _index_path(videos_dir)
    try:
        path.write_text(
            json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        logger.warning("media index 저장 실패: %s", path, exc_info=True)


def hash_file(path: Path) -> str:
    """파일 내용의 sha256. 2GB 업로드도 상수 메모리로 처리."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_metadata(path: Path) -> dict[str, Any]:
    """길이 · 해상도 조회. 실패해도 업로드를 막지 않도록 빈 값을 돌려준다."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-show_entries", "format=duration",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=_FFMPEG_TIMEOUT_SEC,
        )
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout or "{}")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        logger.warning("ffprobe 실패: %s", path, exc_info=True)
        return {}

    streams = data.get("streams") or [{}]
    stream = streams[0] if streams else {}
    meta: dict[str, Any] = {}
    try:
        meta["duration"] = round(float(data.get("format", {}).get("duration", 0)), 3)
    except (TypeError, ValueError):
        meta["duration"] = 0.0
    if stream.get("width"):
        meta["width"] = int(stream["width"])
    if stream.get("height"):
        meta["height"] = int(stream["height"])
    return meta


def generate_thumbnail(videos_dir: Path, video_path: Path) -> Optional[str]:
    """첫 장면 썸네일을 만들고 videos/ 기준 상대 경로를 반환.

    검은 리드인을 피하려고 1초 지점을 먼저 시도하고, 그보다 짧은 영상이면
    0초로 폴백한다. 실패는 None — 라이브러리는 썸네일 없이도 동작한다.
    """
    out_dir = _thumbnail_dir(videos_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{video_path.stem}.jpg"

    for seek in ("1", "0"):
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-ss", seek,
                    "-i", str(video_path),
                    "-frames:v", "1",
                    "-vf", f"scale={THUMBNAIL_WIDTH}:-2",
                    str(out_path),
                ],
                capture_output=True,
                text=True,
                timeout=_FFMPEG_TIMEOUT_SEC,
            )
        except (OSError, subprocess.SubprocessError):
            logger.warning("썸네일 생성 실패: %s", video_path, exc_info=True)
            return None
        if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
            return f"{THUMBNAIL_DIRNAME}/{out_path.name}"

    logger.warning("썸네일 생성 실패 (모든 seek 지점): %s", video_path)
    return None


def find_by_hash(videos_dir: Path, sha256: str) -> Optional[dict[str, Any]]:
    """같은 내용의 영상이 이미 있으면 그 항목. 파일이 지워졌으면 None."""
    index = load_index(videos_dir)
    for name, item in index.get("items", {}).items():
        if item.get("sha256") != sha256:
            continue
        if not (videos_dir / name).exists():
            # 인덱스만 남고 실제 파일이 사라진 경우 — 재업로드가 정답이다.
            continue
        return to_public(name, item)
    return None


def register(
    videos_dir: Path,
    filename: str,
    *,
    sha256: str,
    size: int,
    original_name: str,
) -> dict[str, Any]:
    """업로드된 파일을 라이브러리에 등록하고 공개 형식으로 반환."""
    video_path = videos_dir / filename
    item: dict[str, Any] = {
        "sha256": sha256,
        "size": size,
        "original_name": original_name,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    item.update(probe_metadata(video_path))
    thumbnail = generate_thumbnail(videos_dir, video_path)
    if thumbnail:
        item["thumbnail"] = thumbnail

    index = load_index(videos_dir)
    index.setdefault("items", {})[filename] = item
    index["schema_version"] = SCHEMA_VERSION
    save_index(videos_dir, index)
    return to_public(filename, item)


def to_public(filename: str, item: dict[str, Any]) -> dict[str, Any]:
    """인덱스 항목 → API 응답 형식 (프론트가 그대로 렌더 가능)."""
    public: dict[str, Any] = {
        "name": filename,
        "original_name": item.get("original_name") or filename,
        "path": f"videos/{filename}",
        "url": f"/files/videos/{filename}",
        "size": item.get("size", 0),
        "duration": item.get("duration", 0.0),
        "created_at": item.get("created_at", ""),
    }
    if item.get("width"):
        public["width"] = item["width"]
    if item.get("height"):
        public["height"] = item["height"]
    if item.get("thumbnail"):
        public["thumbnail_url"] = f"/files/videos/{item['thumbnail']}"
    return public


def list_media(videos_dir: Path) -> list[dict[str, Any]]:
    """최신 업로드 순 목록. 인덱스에만 남은 유령 항목은 조용히 제외."""
    index = load_index(videos_dir)
    items = index.get("items", {})
    alive = {
        name: item
        for name, item in items.items()
        if (videos_dir / name).exists()
    }
    if len(alive) != len(items):
        index["items"] = alive
        save_index(videos_dir, index)

    return sorted(
        (to_public(name, item) for name, item in alive.items()),
        key=lambda entry: entry.get("created_at", ""),
        reverse=True,
    )


def remove(videos_dir: Path, filename: str) -> bool:
    """라이브러리에서 삭제 (원본 · 썸네일 · 인덱스 항목).

    분석 사이드카(_analysis.json, subtitles/)는 남긴다 — 같은 영상을 다시
    올리면 재분석 없이 재사용되어 대기 시간이 사라진다.
    """
    index = load_index(videos_dir)
    item = index.get("items", {}).pop(filename, None)
    if item is None:
        return False

    (videos_dir / filename).unlink(missing_ok=True)
    if item.get("thumbnail"):
        (videos_dir / item["thumbnail"]).unlink(missing_ok=True)
    save_index(videos_dir, index)
    return True
