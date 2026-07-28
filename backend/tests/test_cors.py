"""로컬 프론트 주소별 CORS 회귀 테스트."""

from fastapi.testclient import TestClient

from server import app


def test_health_allows_loopback_frontend_origin():
    with TestClient(app) as client:
        response = client.get(
            "/health",
            headers={"Origin": "http://127.0.0.1:3001"},
        )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3001"
