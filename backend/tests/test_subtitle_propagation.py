"""자막 큐가 편집 단계를 건너 살아남아야 한다.

큐 문서는 stem 으로만 조회된다. 영상을 새로 쓰는 단계마다 stem 이 바뀌는데
문서를 물려주지 않으면 최종본 stem 의 문서가 없어 조회가 통째로 실패한다.

실제로 관찰된 세 증상이 전부 이 하나에서 나왔다:
  - 미리보기에 자막이 안 올라옴 (state.ts 의 hasCues 조건)
  - 자막 스타일 카드가 안 뜸
  - export 가 no_cues 로 떨어져 자막 없는 영상을 내려받음
"""

from __future__ import annotations

import json

import pytest

from agent import config
from agent.tools import media_paths
from agent.tools.audio_common import copy_cue_document, copy_video_sidecars


@pytest.fixture
def project(tmp_path, monkeypatch):
    for name in ("outputs", "videos", "videos/subtitles"):
        (tmp_path / name).mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(config, "VIDEOS_DIR", tmp_path / "videos")
    monkeypatch.setattr(media_paths, "OUTPUTS_DIR", tmp_path / "outputs")
    monkeypatch.setattr(media_paths, "LEGACY_OUTPUT_DIR", tmp_path / "output")
    return tmp_path


def _write_doc(project, stem: str, *, source_video: str, cues: int = 3) -> None:
    (project / "videos" / "subtitles" / f"{stem}.cues.json").write_text(
        json.dumps({
            "version": 1,
            "video_stem": stem,
            "source_video": source_video,
            "id_seq": cues,
            "style_defaults": {"font": "Black Han Sans", "size": 36},
            "cues": [
                {"id": f"c{i}", "start": i, "end": i + 1, "text": f"자막 {i}"}
                for i in range(cues)
            ],
        }, ensure_ascii=False),
        encoding="utf-8",
    )


def _read_doc(project, stem: str) -> dict:
    return json.loads(
        (project / "videos" / "subtitles" / f"{stem}.cues.json").read_text(
            encoding="utf-8"
        )
    )


def test_cues_survive_a_new_stage(project):
    """자막 뒤에 BGM·캡션 단계가 붙어도 최종본에서 자막을 찾을 수 있어야 한다."""
    source = project / "outputs" / "with_subtitles.mp4"
    output = project / "outputs" / "with_bgm.mp4"
    source.write_bytes(b"video")
    _write_doc(project, "with_subtitles", source_video=str(source))

    copy_cue_document(source, output)

    carried = _read_doc(project, "with_bgm")
    assert len(carried["cues"]) == 3
    assert carried["video_stem"] == "with_bgm", "새 stem 으로 조회되어야 한다"


def test_source_video_is_not_rewritten(project):
    """source_video 는 굽기 전 원본이라 유지해야 한다 — 이중 burn 방지."""
    source = project / "outputs" / "burned.mp4"
    output = project / "outputs" / "next_stage.mp4"
    source.write_bytes(b"video")
    pre_burn = str(project / "outputs" / "clean_original.mp4")
    _write_doc(project, "burned", source_video=pre_burn)

    copy_cue_document(source, output)

    assert _read_doc(project, "next_stage")["source_video"] == pre_burn


def test_existing_document_is_never_overwritten(project):
    """사용자가 편집한 큐가 뒤 단계 승계로 날아가면 안 된다."""
    source = project / "outputs" / "a.mp4"
    output = project / "outputs" / "b.mp4"
    source.write_bytes(b"video")
    _write_doc(project, "a", source_video=str(source), cues=3)
    _write_doc(project, "b", source_video=str(output), cues=7)

    copy_cue_document(source, output)

    assert len(_read_doc(project, "b")["cues"]) == 7, "기존 문서가 보존돼야 한다"


def test_same_stem_is_a_noop(project):
    source = project / "outputs" / "same.mp4"
    source.write_bytes(b"video")
    _write_doc(project, "same", source_video=str(source))

    copy_cue_document(source, source)  # 예외 없이 통과해야 한다

    assert len(_read_doc(project, "same")["cues"]) == 3


def test_missing_source_document_is_silent(project):
    """자막이 없는 영상을 처리할 때 조용히 넘어가야 한다."""
    source = project / "outputs" / "no_subs.mp4"
    output = project / "outputs" / "still_none.mp4"
    source.write_bytes(b"video")

    copy_cue_document(source, output)

    assert not (project / "videos" / "subtitles" / "still_none.cues.json").exists()


def test_sidecars_and_cues_travel_together(project):
    """copy_video_sidecars 한 번으로 origin·pad·cue 가 모두 넘어간다."""
    source = project / "outputs" / "src.mp4"
    output = project / "outputs" / "dst.mp4"
    source.write_bytes(b"video")
    (project / "outputs" / "src.mp4.origin.json").write_text("[]", encoding="utf-8")
    (project / "outputs" / "src.mp4.pad.json").write_text("{}", encoding="utf-8")
    _write_doc(project, "src", source_video=str(source))

    copy_video_sidecars(source, output)

    assert (project / "outputs" / "dst.mp4.origin.json").exists()
    assert (project / "outputs" / "dst.mp4.pad.json").exists()
    assert (project / "videos" / "subtitles" / "dst.cues.json").exists()


# =============================================================
# 조회 — 서버는 확장자 없는 stem 을 넘기고, 산출물은 outputs/ 에 있다
# =============================================================

def test_resolver_finds_outputs_and_bare_stems(project):
    """큐 레이어 해석기만 outputs/ 를 못 봐서 존재하지 않는 경로를 기록해왔다."""
    from agent.tools import subtitle_cues

    target = project / "outputs" / "final_video.mp4"
    target.write_bytes(b"video")

    assert subtitle_cues._resolve_video_path("final_video.mp4") == str(target)
    assert subtitle_cues._resolve_video_path("final_video") == str(target), (
        "서버 엔드포인트는 확장자 없는 stem 을 넘긴다"
    )


def test_resolver_falls_back_when_nothing_matches(project):
    """못 찾아도 예외 없이 기존 위치를 돌려준다."""
    from agent.tools import subtitle_cues

    resolved = subtitle_cues._resolve_video_path("ghost.mp4")

    assert resolved.endswith("ghost.mp4")
