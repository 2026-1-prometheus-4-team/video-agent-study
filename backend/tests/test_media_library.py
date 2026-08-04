"""미디어 라이브러리 — 중복 업로드 재사용 · 목록 · 삭제.

같은 파일을 다시 올릴 때마다 name_1, name_2 사본이 쌓이고 사용자가 실패
후 재업로드를 강요당하던 동작에 대한 회귀 테스트.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import media_library
import server
from agent import config as agent_config


@pytest.fixture
def videos_dir(tmp_path, monkeypatch):
    """videos/ 를 임시 디렉토리로 격리 — 실제 프로젝트 영상을 건드리지 않는다."""
    target = tmp_path / "videos"
    target.mkdir()
    monkeypatch.setattr(agent_config, "VIDEOS_DIR", target)
    return target


@pytest.fixture
def client(videos_dir):
    with TestClient(server.app) as test_client:
        yield test_client


def _upload(client: TestClient, name: str, payload: bytes):
    return client.post(
        "/upload",
        files={"file": (name, payload, "video/mp4")},
    )


def test_same_content_reuses_existing_file(client, videos_dir):
    payload = b"same-bytes-over-and-over"

    first = _upload(client, "move_1.mp4", payload)
    second = _upload(client, "move_1.mp4", payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["reused"] is False
    assert second.json()["reused"] is True
    assert second.json()["path"] == first.json()["path"]

    stored = [p.name for p in videos_dir.glob("*.mp4")]
    assert stored == ["move_1.mp4"], f"사본이 생기면 안 된다: {stored}"


def test_same_name_different_content_keeps_both(client, videos_dir):
    first = _upload(client, "move_1.mp4", b"first-clip")
    second = _upload(client, "move_1.mp4", b"second-clip")

    assert second.json()["reused"] is False
    assert first.json()["path"] != second.json()["path"]
    assert len(list(videos_dir.glob("*.mp4"))) == 2


def test_upload_leaves_no_staging_file(client, videos_dir):
    _upload(client, "move_1.mp4", b"payload")

    leftovers = [p.name for p in videos_dir.iterdir() if p.name.startswith(".upload_")]
    assert leftovers == []


def test_rejected_extension_does_not_write(client, videos_dir):
    response = _upload(client, "notes.txt", b"nope")

    assert response.status_code == 415
    assert list(videos_dir.glob("*")) == []


def test_media_lists_uploads_newest_first(client):
    _upload(client, "a.mp4", b"clip-a")
    _upload(client, "b.mp4", b"clip-b")

    listed = client.get("/media").json()

    assert {item["name"] for item in listed} == {"a.mp4", "b.mp4"}
    assert all(item["url"].startswith("/files/videos/") for item in listed)


def test_delete_removes_from_library(client, videos_dir):
    uploaded = _upload(client, "gone.mp4", b"bye").json()

    deleted = client.delete(f"/media/{uploaded['name']}")

    assert deleted.status_code == 200
    assert client.get("/media").json() == []
    assert not (videos_dir / uploaded["name"]).exists()


def test_delete_rejects_path_traversal(client):
    response = client.delete("/media/..%2F..%2Fetc%2Fpasswd")

    assert response.status_code in {400, 404}


def test_delete_unknown_name_is_404(client):
    assert client.delete("/media/never-existed.mp4").status_code == 404


def test_listing_drops_entries_whose_file_vanished(client, videos_dir):
    uploaded = _upload(client, "ghost.mp4", b"boo").json()
    (videos_dir / uploaded["name"]).unlink()

    assert client.get("/media").json() == []


def test_reupload_after_manual_delete_creates_fresh_entry(client, videos_dir):
    payload = b"recoverable"
    first = _upload(client, "clip.mp4", payload).json()
    (videos_dir / first["name"]).unlink()

    again = _upload(client, "clip.mp4", payload).json()

    assert again["reused"] is False, "파일이 사라졌으면 재사용이 아니라 재저장이다"
    assert (videos_dir / again["name"]).exists()


def test_index_corruption_does_not_break_upload(client, videos_dir):
    (videos_dir / media_library.INDEX_FILENAME).write_text("{ broken", encoding="utf-8")

    response = _upload(client, "resilient.mp4", b"data")

    assert response.status_code == 200
    assert Path(videos_dir / response.json()["name"]).exists()
