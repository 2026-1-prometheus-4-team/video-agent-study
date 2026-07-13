"""세션·메시지·아티팩트·인터럽트 로그 DB.

로컬 Docker postgres (docker-compose.yml) 를 default 로 쓰고, `DATABASE_URL`
env 로 언제든 override. Supabase 로 이관 시 URL 만 바꾸면 스키마 그대로.

핵심 원칙:
- **비블로킹**: DB write 실패해도 WS 스트리밍은 계속 (`repo.log_*` 는 예외를
  잡아 로깅만 하고 삼킨다).
- **로그 vs 상태**: 이 DB 는 "무슨 일이 있었나" 를 남기는 append-only 로그.
  실시간 state 는 여전히 in-memory `Session` 이 소유. 재시작·재접속 후 이력
  복원 필요할 때 이 DB 를 쓴다.
"""

from .engine import get_session, init_db, dispose_db
from .repo import SessionRepo

__all__ = ["get_session", "init_db", "dispose_db", "SessionRepo"]
