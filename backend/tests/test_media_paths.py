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


def test_newest_file_wins_on_name_collision(project):
    """같은 generic 이름이 여러 곳에 있으면 가장 최근 파일이 이긴다.

    video_with_bgm.mp4 / final_video.mp4 같은 출력 이름은 세션·run 간 재사용돼서,
    옛 세션의 stale 파일이 검색 순서상 먼저 잡히면 편집 결과에 엉뚱한 영상(예:
    이전 move 세션 내용)이 섞였다. 방금 쓴 최신 파일이 이겨야 한다.
    """
    import os
    import time

    old_file = project / "dup.mp4"
    old_file.write_bytes(b"old")
    new_file = project / "outputs" / "dup.mp4"
    new_file.write_bytes(b"new")
    now = time.time()
    os.utime(old_file, (now - 100, now - 100))
    os.utime(new_file, (now, now))

    assert media_paths.find_media("dup.mp4") == new_file


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


# =============================================================
# 산출물 위치 — 서빙 디렉토리 밖으로 나가면 화면에서 사라진다
# =============================================================

def test_bare_output_name_goes_to_outputs(project):
    """실제 증상: add_captions_batch_18.mp4 가 backend/ 루트에 저장돼
    /files/* 로 서빙되지 않았고, 편집은 성공했는데 화면엔 원본만 남았다."""
    resolved = media_paths.resolve_output("add_captions_batch_18.mp4")

    assert resolved.parent == project / "outputs"


def test_explicit_relative_output_keeps_its_location(project):
    resolved = media_paths.resolve_output("videos/clips/take_1.mp4")

    assert resolved == project / "videos" / "clips" / "take_1.mp4"


def test_absolute_output_is_untouched(project):
    target = project / "elsewhere" / "final.mp4"

    assert media_paths.resolve_output(str(target)) == target


def test_audio_tool_output_lands_in_served_directory(project):
    from agent.tools.audio_common import resolve_output_path

    resolved = resolve_output_path("add_bgm_16.mp4", "bgm", ".mp4")

    assert resolved.parent == (project / "outputs").resolve()


def test_final_output_in_outputs_maps_to_a_url(project, monkeypatch):
    """경로가 URL 로 변환돼야 프론트가 편집본을 재생할 수 있다."""
    import server

    produced = project / "outputs" / "add_captions_batch_18.mp4"
    produced.write_bytes(b"final")
    monkeypatch.setattr(
        server, "_FILE_URL_BASES", [(project / "outputs", "/files/outputs")]
    )

    assert server._to_file_url(str(produced)) == "/files/outputs/add_captions_batch_18.mp4"


def test_final_output_outside_served_dirs_has_no_url(project, monkeypatch):
    """루트에 떨어진 산출물은 URL 이 안 나온다 — 위 수정이 필요한 이유."""
    import server

    stray = project / "add_captions_batch_18.mp4"
    stray.write_bytes(b"final")
    monkeypatch.setattr(
        server, "_FILE_URL_BASES", [(project / "outputs", "/files/outputs")]
    )

    assert server._to_file_url(str(stray)) is None
