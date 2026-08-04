"""expert 사이에 파일을 넘길 때 경로 해석이 일치해야 한다.

실제 실패 사례: merge_video 가 output_path="merge_video_5.mp4" 를 outputs/ 에
저장했는데, 다음 step 의 add_bgm 은 PROJECT_ROOT 만 뒤져서
"file not found: <root>/merge_video_5.mp4" 로 죽었다. 파일은 있었다.
"""

from __future__ import annotations

import pytest

from agent import config
from agent.tools import media_paths


@pytest.fixture
def project(tmp_path, monkeypatch):
    """PROJECT_ROOT · outputs · output · videos 를 임시 디렉토리로 격리."""
    for name in ("outputs", "output", "videos"):
        (tmp_path / name).mkdir()
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(config, "VIDEOS_DIR", tmp_path / "videos")
    monkeypatch.setattr(media_paths, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(media_paths, "LEGACY_OUTPUT_DIR", tmp_path / "output")
    return tmp_path


def test_edit_output_is_found_by_other_experts(project):
    """편집 산출물의 bare 파일명을 audio/text expert 도 찾아야 한다."""
    from agent.tools.audio_common import resolve_input_path

    produced = project / "outputs" / "merge_video_5.mp4"
    produced.write_bytes(b"merged")

    assert resolve_input_path("merge_video_5.mp4") == produced.resolve()


def test_uploaded_source_still_resolves_from_videos(project):
    from agent.tools.audio_common import resolve_input_path

    source = project / "videos" / "clip.mp4"
    source.write_bytes(b"source")

    assert resolve_input_path("clip.mp4") == source.resolve()


def test_explicit_relative_path_wins_over_search(project):
    """"outputs/x.mp4" 처럼 위치를 명시하면 그 위치가 그대로 쓰여야 한다."""
    target = project / "outputs" / "x.mp4"
    target.write_bytes(b"explicit")
    decoy = project / "videos" / "x.mp4"
    decoy.write_bytes(b"decoy")

    assert media_paths.find_media("outputs/x.mp4") == target


def test_project_root_precedes_outputs_on_name_collision(project):
    """같은 이름이 여러 곳에 있으면 탐색 순서가 결정한다 (루트 우선)."""
    root_file = project / "dup.mp4"
    root_file.write_bytes(b"root")
    (project / "outputs" / "dup.mp4").write_bytes(b"outputs")

    assert media_paths.find_media("dup.mp4") == root_file


def test_missing_file_reports_fallback_location(project):
    """못 찾으면 호출부가 지정한 위치를 가리켜 에러 메시지를 유지한다."""
    resolved = media_paths.resolve_media(
        "nope.mp4", fallback_dir=project / "videos"
    )

    assert resolved == project / "videos" / "nope.mp4"
    assert media_paths.find_media("nope.mp4") is None


def test_absolute_path_is_not_searched(project):
    missing = project / "elsewhere" / "clip.mp4"

    assert media_paths.find_media(str(missing)) is None
    assert media_paths.resolve_media(str(missing)) == missing


def test_caller_supplied_dirs_are_respected(project):
    """edit.py 처럼 자기 상수를 넘기는 호출부는 그 목록만 본다."""
    only_here = project / "output" / "legacy.mp4"
    only_here.write_bytes(b"legacy")

    assert media_paths.find_media("legacy.mp4", dirs=[project / "videos"]) is None
    assert media_paths.find_media("legacy.mp4", dirs=[project / "output"]) == only_here
