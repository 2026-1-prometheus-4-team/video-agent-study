"""미디어 파일 경로 해석 규칙 (모든 expert 공통).

경로 해석기가 모듈마다 따로 자라면서 탐색 범위가 서로 달라졌다:

- edit.py         : PROJECT_ROOT · outputs · output · videos  (가장 넓음)
- audio_common.py : PROJECT_ROOT 만
- subtitle.py     : PROJECT_ROOT · videos

편집 툴은 디렉토리 없는 output_path("merge_video_5.mp4")를 outputs/ 아래
저장한다. 그런데 supervisor 가 그 파일명을 그대로 다음 step 에 넘기면,
audio/text expert 는 outputs/ 를 보지 않으므로 실제로 존재하는 파일을 두고
"file not found: <project_root>/merge_video_5.mp4" 로 실패했다.

여기서 탐색 순서를 한 곳에 정의해 세 모듈이 같은 규칙을 쓰게 한다.
"""

from __future__ import annotations

import os
from pathlib import Path

from agent import config

# 탐색 순서. PROJECT_ROOT 를 먼저 두어 "outputs/x.mp4" 같은 명시적 상대경로가
# 의도한 위치에서 그대로 잡히게 하고, 그 다음 산출물 · 업로드 순으로 넓힌다.
OUTPUTS_DIR = config.PROJECT_ROOT / "outputs"
LEGACY_OUTPUT_DIR = config.PROJECT_ROOT / "output"


def search_dirs() -> list[Path]:
    return [
        config.PROJECT_ROOT,
        OUTPUTS_DIR,
        LEGACY_OUTPUT_DIR,
        config.VIDEOS_DIR,
    ]


def find_media(
    path: str | os.PathLike[str],
    *,
    dirs: list[Path] | None = None,
) -> Path | None:
    """존재하는 첫 후보를 반환. 절대경로는 그대로 확인. 없으면 None.

    dirs 를 넘기면 그 목록만 탐색한다. 호출부가 자기 디렉토리 상수를 그대로
    쓰게 해서, 그 상수를 patch 하는 테스트가 계속 유효하도록 남겨둔 통로다.
    """
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate if candidate.exists() else None

    for base in dirs if dirs is not None else search_dirs():
        resolved = Path(base) / candidate
        if resolved.exists():
            return resolved
    return None


def resolve_output(
    path: str | os.PathLike[str],
    *,
    default_dir: Path | None = None,
) -> Path:
    """산출물 저장 경로 해석.

    디렉토리 없는 이름("add_captions_batch_18.mp4")은 반드시 서빙 디렉토리
    안으로 보낸다. 이전에는 모듈마다 PROJECT_ROOT / videos 의 부모 등으로
    흩어져서 결과물이 backend/ 루트에 떨어졌고, server.py 의 정적 마운트
    (/files/outputs · /files/videos · ...) 밖이라 _to_file_url 이 None 을
    돌려줬다. 편집은 성공했는데 화면에서는 원본만 보이던 원인.
    """
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    if candidate.parent != Path("."):
        # 위치를 명시한 상대경로는 그 의도를 존중한다.
        return config.PROJECT_ROOT / candidate
    return (default_dir if default_dir is not None else OUTPUTS_DIR) / candidate


def resolve_media(
    path: str | os.PathLike[str],
    *,
    dirs: list[Path] | None = None,
    fallback_dir: Path | None = None,
) -> Path:
    """경로 해석. 못 찾으면 fallback_dir 기준 경로를 반환한다.

    fallback_dir 은 "파일이 없을 때 어느 위치를 가리켜 에러를 낼지"만 정한다.
    호출부마다 기존 에러 메시지 위치를 유지하기 위한 장치다.
    """
    found = find_media(path, dirs=dirs)
    if found is not None:
        return found

    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    base = fallback_dir if fallback_dir is not None else config.PROJECT_ROOT
    return Path(base) / candidate
