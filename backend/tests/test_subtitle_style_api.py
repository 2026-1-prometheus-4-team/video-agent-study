"""SubtitleStyleCard REST 엔드포인트 계약 테스트.

GET/PATCH /api/subtitles/{stem}/style, POST /api/subtitles/{stem}/render.
FFmpeg 없이 오프라인 동작 — 디렉터리 상수는 tmp_path 로 patch.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import server
from agent.tools import subtitle_cues


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.fixture
def cue_env(tmp_path):
    subs = tmp_path / "subtitles"
    fonts = tmp_path / "fonts"
    subs.mkdir()
    fonts.mkdir()
    (fonts / "NotoSansKR-Regular.ttf").write_bytes(b"fake_font")
    video = tmp_path / "sample.mp4"
    video.write_bytes(b"fake_video")

    with patch.object(subtitle_cues, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle_cues, "FONTS_DIR", str(fonts)), \
         patch.object(subtitle_cues, "VIDEOS_DIR", str(tmp_path)):
        subtitle_cues.create_cues_doc(
            stem="sample",
            source_video=str(video),
            segments=[{"start": 0.0, "end": 2.0, "text": "첫 자막"}],
        )
        yield {"tmp": tmp_path, "video": video}


class TestGetStyle:
    def test_no_doc_returns_backend_defaults(self, client, tmp_path):
        with patch.object(subtitle_cues, "SUBTITLES_DIR", str(tmp_path)), \
             patch.object(subtitle_cues, "VIDEOS_DIR", str(tmp_path)):
            res = client.get("/api/subtitles/ghost/style")
        assert res.status_code == 200
        data = res.json()
        assert data["font"] == "Noto Sans KR"
        assert data["size"] == 24
        assert data["bold"] is False
        assert data["fade"] is False

    def test_doc_style_defaults_win(self, client, cue_env):
        res = client.get("/api/subtitles/sample/style")
        assert res.status_code == 200
        assert res.json()["size"] == 24


class TestPatchStyle:
    def test_patch_merges_into_defaults(self, client, cue_env):
        res = client.patch(
            "/api/subtitles/sample/style",
            json={"size": 30, "bold": True, "color": "#FFE600"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["size"] == 30
        assert data["bold"] is True
        assert data["color"] == "#FFE600"

        again = client.get("/api/subtitles/sample/style").json()
        assert again["size"] == 30

    def test_unknown_font_is_400(self, client, cue_env):
        res = client.patch(
            "/api/subtitles/sample/style", json={"font": "ComicSans"}
        )
        assert res.status_code == 400
        assert "ComicSans" in res.json()["detail"]

    def test_no_doc_is_404(self, client, tmp_path):
        with patch.object(subtitle_cues, "SUBTITLES_DIR", str(tmp_path)), \
             patch.object(subtitle_cues, "VIDEOS_DIR", str(tmp_path)):
            res = client.patch("/api/subtitles/ghost/style", json={"size": 30})
        assert res.status_code == 404


class TestRender:
    def test_no_doc_is_404(self, client, tmp_path):
        with patch.object(subtitle_cues, "SUBTITLES_DIR", str(tmp_path)), \
             patch.object(subtitle_cues, "VIDEOS_DIR", str(tmp_path)):
            res = client.post("/api/subtitles/ghost/render", json={})
        assert res.status_code == 404


class TestPatchCues:
    def test_update_text_by_index(self, client, cue_env):
        res = client.patch(
            "/api/subtitles/sample/cues",
            json={"updates": [{"index": 0, "text": "고친 자막"}]},
        )
        assert res.status_code == 200
        assert res.json()["updated"] == ["c001"]

    def test_update_cue_style(self, client, cue_env):
        res = client.patch(
            "/api/subtitles/sample/cues",
            json={"updates": [
                {"index": 0, "style": {"size": 30, "bold": True, "position": "top"}}
            ]},
        )
        assert res.status_code == 200
        assert res.json()["updated"] == ["c001"]

    def test_no_doc_is_404(self, client, tmp_path):
        with patch.object(subtitle_cues, "SUBTITLES_DIR", str(tmp_path)), \
             patch.object(subtitle_cues, "VIDEOS_DIR", str(tmp_path)):
            res = client.patch(
                "/api/subtitles/ghost/cues",
                json={"updates": [{"index": 0, "text": "x"}]},
            )
        assert res.status_code == 404

    def test_empty_updates_is_400(self, client, cue_env):
        res = client.patch("/api/subtitles/sample/cues", json={"updates": []})
        assert res.status_code == 400
