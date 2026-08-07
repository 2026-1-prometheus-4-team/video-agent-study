"""세션 상태 헬퍼 회귀 테스트 — 자막 큐 반영 / 재분석 컨텍스트 우선순위.

적대적 리뷰에서 확정된 결함들의 고정 테스트:
- 큐 문서(<stem>.cues.json) 편집이 프론트 transcript 에 반영되는가
- GET /session 이 재분석 결과(session.video_context) 를 체크포인트보다 우선하는가
"""

import json
import time
import types

import pytest


@pytest.fixture(scope="module")
def server_mod():
    import server
    return server


def _fake_session(server_mod, tmp_path, video_paths):
    """DB / 그래프 없이 _load_transcript_sidecar 만 돌리기 위한 최소 스텁."""
    return types.SimpleNamespace(
        session_id="t1",
        video_paths=video_paths,
        created_at=time.time() - 3600,
        video_context=None,
    )


class TestTranscriptSidecar:
    def test_final_stem_wins_over_input_sidecar(
        self, server_mod, tmp_path, monkeypatch
    ):
        """최종 타임라인 요청에서 원본 입력 자막을 잘못 반환하면 안 된다."""
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        outputs = tmp_path / "outputs"
        subs.mkdir(parents=True)
        outputs.mkdir()
        (subs / "input.json").write_text(json.dumps({
            "segments": [{"start": 0, "end": 10, "text": "원본 전체"}],
        }), encoding="utf-8")
        (subs / "final_subtitled.cues.json").write_text(json.dumps({
            "cues": [{"id": "c001", "start": 1, "end": 2, "text": "최종 컷"}],
        }), encoding="utf-8")
        final = outputs / "final_subtitled.mp4"
        final.write_bytes(b"video")
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)
        monkeypatch.setattr(server_mod.agent_config, "PROJECT_ROOT", tmp_path)

        session = _fake_session(server_mod, tmp_path, ["videos/input.mp4"])
        out = server_mod._load_transcript_sidecar(session, str(final))
        assert out == [{"start": 1.0, "end": 2.0, "text": "최종 컷", "id": "c001"}]

    def test_final_without_matching_sidecar_does_not_use_input(
        self, server_mod, tmp_path, monkeypatch
    ):
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        outputs = tmp_path / "outputs"
        subs.mkdir(parents=True)
        outputs.mkdir()
        (subs / "input.json").write_text(json.dumps({
            "segments": [{"start": 0, "end": 10, "text": "틀린 타임라인"}],
        }), encoding="utf-8")
        final = outputs / "different_final.mp4"
        final.write_bytes(b"video")
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)
        monkeypatch.setattr(server_mod.agent_config, "PROJECT_ROOT", tmp_path)

        session = _fake_session(server_mod, tmp_path, ["videos/input.mp4"])
        out = server_mod._load_transcript_sidecar(session, str(final))
        assert out == []

    def test_cues_doc_wins_over_stale_transcript_sidecar(
        self, server_mod, tmp_path, monkeypatch
    ):
        """오타 수정은 큐 문서에만 반영된다 — 전사 사이드카를 쓰면 옛 텍스트가 남는다."""
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        subs.mkdir(parents=True)
        # 오래된 전사 사이드카 (오타 포함)
        (subs / "clip.json").write_text(
            json.dumps({"segments": [{"start": 0, "end": 1, "text": "갔따"}]}),
            encoding="utf-8",
        )
        time.sleep(0.01)
        # 최신 큐 문서 (수정본)
        (subs / "clip.cues.json").write_text(
            json.dumps({
                "version": 1,
                "video_stem": "clip",
                "cues": [{"id": "c001", "start": 0, "end": 1, "text": "갔다"}],
            }),
            encoding="utf-8",
        )
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)

        session = _fake_session(server_mod, tmp_path, ["videos/clip.mp4"])
        out = server_mod._load_transcript_sidecar(session)
        assert out == [{"start": 0.0, "end": 1.0, "text": "갔다", "id": "c001"}]

    def test_cues_stem_matches_session_input(self, server_mod, tmp_path, monkeypatch):
        """<stem>.cues.json 의 Path.stem 은 '<stem>.cues' — 접미 제거 후 매칭돼야 함."""
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        subs.mkdir(parents=True)
        (subs / "clip.cues.json").write_text(
            json.dumps({"cues": [{"id": "c001", "start": 2, "end": 3, "text": "안녕"}]}),
            encoding="utf-8",
        )
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)

        session = _fake_session(server_mod, tmp_path, ["videos/clip.mp4"])
        # created_at 을 미래로 둬서 mtime 규칙이 아닌 stem 규칙으로만 잡히게
        session.created_at = time.time() + 3600
        out = server_mod._load_transcript_sidecar(session)
        assert out == [{"start": 2.0, "end": 3.0, "text": "안녕", "id": "c001"}]

    def test_falls_back_to_segments_when_no_cues(self, server_mod, tmp_path, monkeypatch):
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        subs.mkdir(parents=True)
        (subs / "clip.json").write_text(
            json.dumps({"segments": [{"start": 0, "end": 1, "text": "원본"}]}),
            encoding="utf-8",
        )
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)

        session = _fake_session(server_mod, tmp_path, ["videos/clip.mp4"])
        out = server_mod._load_transcript_sidecar(session)
        assert out == [{"start": 0.0, "end": 1.0, "text": "원본"}]

    def test_empty_cues_list_ignored(self, server_mod, tmp_path, monkeypatch):
        """빈 cues 문서가 전사 사이드카를 가리면 안 됨."""
        videos = tmp_path / "videos"
        subs = videos / "subtitles"
        subs.mkdir(parents=True)
        (subs / "clip.json").write_text(
            json.dumps({"segments": [{"start": 0, "end": 1, "text": "원본"}]}),
            encoding="utf-8",
        )
        time.sleep(0.01)
        (subs / "clip.cues.json").write_text(
            json.dumps({"cues": []}), encoding="utf-8"
        )
        monkeypatch.setattr(server_mod.agent_config, "VIDEOS_DIR", videos)

        session = _fake_session(server_mod, tmp_path, ["videos/clip.mp4"])
        out = server_mod._load_transcript_sidecar(session)
        assert out == [{"start": 0.0, "end": 1.0, "text": "원본"}]
