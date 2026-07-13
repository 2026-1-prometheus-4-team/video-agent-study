"""
edit_expert 시연용 스크립트.

analyze_video, cut_video, merge_video, search_video_segments,
cut_by_description 툴을 직접 호출해서 테스트.

실행:
    cd backend
    python -m scripts.tools_demo
"""

import logging
import sys
from pathlib import Path

# backend/ 를 sys.path 에 추가
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)

from agent.tools.video_analysis import analyze_video
from agent.tools.edit import cut_video, merge_video, search_video_segments, cut_by_description

TOOLS = {
    "1": ("analyze_video",          "영상 분석 (JSON 생성)"),
    "2": ("cut_video",              "타임스탬프로 자르기"),
    "3": ("search_video_segments",  "내용 기반 검색"),
    "4": ("cut_by_description",     "내용 기반 자동 컷"),
    "5": ("cut_by_description",     "내용 기반 자동 컷 + 합치기"),
    "6": ("merge_video",            "클립 합치기"),
}


def run():
    print("\n=== edit_expert 시연 ===")
    print("사용 가능한 툴:")
    for k, (name, desc) in TOOLS.items():
        print(f"  {k}. {name} — {desc}")
    print("  q. 종료\n")

    while True:
        choice = input("선택: ").strip()
        if choice == "q":
            break

        if choice == "1":
            video = input("영상 파일명 (예: london.mp4): ").strip()
            interval = input("샘플링 간격 초 (예: 0.5): ").strip()
            result = analyze_video.invoke({
                "video_path": video,
                "interval_sec": float(interval),
            })
            print("\n결과:", result[:300], "...\n")

        elif choice == "2":
            video = input("영상 파일명: ").strip()
            start = input("시작 ms (예: 2496): ").strip()
            end = input("끝 ms (예: 7489): ").strip()
            result = cut_video.invoke({
                "video_path": video,
                "start_ms": int(start),
                "end_ms": int(end),
            })
            print("\n결과:", result, "\n")

        elif choice == "3":
            video = input("영상 파일명: ").strip()
            query = input("검색어 (예: 타워 브리지): ").strip()
            result = search_video_segments.invoke({
                "video_path": video,
                "query": query,
            })
            print("\n결과:", result[:500], "...\n")

        elif choice == "4":
            video = input("영상 파일명: ").strip()
            query = input("검색어 (예: 스테이크): ").strip()
            result = cut_by_description.invoke({
                "video_path": video,
                "query": query,
            })
            print("\n결과:", result[:300], "...\n")

        elif choice == "5":
            video = input("영상 파일명: ").strip()
            query = input("검색어 (예: 사람이 걷는 장면): ").strip()
            result = cut_by_description.invoke({
                "video_path": video,
                "query": query,
                "merge": True,
            })
            print("\n결과:", result[:300], "...\n")

        elif choice == "6":
            paths = input("클립 경로들 (쉼표로 구분): ").strip().split(",")
            result = merge_video.invoke({
                "clip_paths": [p.strip() for p in paths],
            })
            print("\n결과:", result, "\n")

        else:
            print("잘못된 선택\n")


if __name__ == "__main__":
    run()
