"""
CLI 진입점 - 에이전트 단독 실행 테스트용
"""

import logging

from agent import run_agent_stream

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)


if __name__ == "__main__":
    run_agent_stream("sample.mp4 영상 정보 조회하고 10 + 25 계산해줘")
