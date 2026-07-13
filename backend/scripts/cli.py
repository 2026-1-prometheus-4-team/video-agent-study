"""
CLI 진입점 — 에이전트 단독 실행 테스트용.

실행:
    cd backend
    python -m scripts.cli
"""

import logging
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가 (`from agent import ...` 해석)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import run_agent_stream

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)


if __name__ == "__main__":
    user_input = input("명령어 입력: ")
    run_agent_stream(user_input)
