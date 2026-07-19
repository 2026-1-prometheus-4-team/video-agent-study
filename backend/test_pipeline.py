"""전체 파이프라인 시연 스크립트

실행: python test_pipeline.py
프롬프트 입력 -> plan 확인 -> 승인(엔터) 또는 수정 요청 -> 최종 영상 산출
"""

import json
import logging

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)
# 노이즈 로그 끄기
for noisy in ["httpx", "google_genai", "google.genai"]:
    logging.getLogger(noisy).setLevel(logging.WARNING)

from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from agent.graph import build_graph
from agent.state import AgentState

THREAD_ID = "demo-1"
CONFIG = {"configurable": {"thread_id": THREAD_ID}, "recursion_limit": 60}


def _fmt_ms(ms) -> str:
    try:
        s = int(ms) // 1000
    except (TypeError, ValueError):
        return "?"
    return f"{s // 60:02d}:{s % 60:02d}"


def print_plan(plan: dict) -> None:
    print("\n" + "=" * 60)

    brief = plan.get("creative_brief") or {}
    if brief:
        print("[기획안]")
        if brief.get("concept"):
            print(f"  컨셉 : {brief['concept']}")
        if brief.get("hook"):
            print(f"  훅   : {brief['hook']}")
        if brief.get("bgm_flow"):
            print(f"  BGM  : {brief['bgm_flow']}")

        board = brief.get("storyboard") or []
        if board:
            print("\n[스토리보드]")
            for sc in board:
                src = str(sc.get("source", "")).split("/")[-1]
                span = f"{_fmt_ms(sc.get('source_start_ms'))}~{_fmt_ms(sc.get('source_end_ms'))}"
                print(f"  {sc.get('idx', '?')}. [{sc.get('role', '')}] {src} {span}")
                if sc.get("visual"):
                    print(f"      영상 : {sc['visual']}")
                if sc.get("narration"):
                    print(f"      나레 : {sc['narration']}")
                if sc.get("on_screen_text"):
                    print(f"      자막 : {sc['on_screen_text']}")
        print()

    print("[실행 계획]")
    print(f"  포맷: {plan.get('target_format')} / 비율: {plan.get('target_aspect_ratio')}")
    for s in plan.get("steps", []):
        params = json.dumps(s.get("params", {}), ensure_ascii=False)
        print(f"  step {s.get('step_id')}: {s.get('expert')} / {s.get('action')}")
        print(f"          {params[:120]}")
    for q in plan.get("questions", []):
        print(f"  [질문] {q}")
    print("=" * 60)


def print_chunk(chunk: dict) -> None:
    for node_name, state in chunk.items():
        if node_name == "__interrupt__" or not isinstance(state, dict):
            continue
        print(f"\n>> [{node_name}]")
        plan = state.get("script_plan")
        if plan:
            print_plan(plan)
        trace = state.get("execution_trace")
        if trace:
            for t in trace:
                print(f"   실행: {t.get('expert')}.{t.get('action')} -> {t.get('status')}")
                for p in t.get("output_paths", []):
                    print(f"         {p}")
        if state.get("final_output_path"):
            print(f"\n   *** 최종 결과물: {state['final_output_path']} ***")
        verdict = state.get("critic_verdict")
        if verdict:
            print(f"   critic: {verdict.get('verdict')} - {verdict.get('message_to_user', '')[:100]}")


DEFAULT_VIDEOS = ["videos/worldcup.mp4"]


def main() -> None:
    # 사용법 1 (대화형): python test_pipeline.py
    # 사용법 2 (인자):   python test_pipeline.py "프롬프트" [--auto] [--videos a.mp4,b.mp4]
    #   --auto            plan 을 자동 승인 (비대화형 테스트용)
    #   --videos x,y,z    입력 영상 여러 개 지정 (쉼표 구분, videos/ 접두어 생략 가능)
    import sys
    argv = sys.argv[1:]
    auto_approve = "--auto" in argv

    video_paths = list(DEFAULT_VIDEOS)
    if "--videos" in argv:
        i = argv.index("--videos")
        raw = argv[i + 1] if i + 1 < len(argv) else ""
        video_paths = [
            v if v.startswith("videos/") else f"videos/{v}"
            for v in (p.strip() for p in raw.split(",")) if v
        ]
        argv = argv[:i] + argv[i + 2:]

    args = [a for a in argv if a != "--auto"]

    if args:
        user_request = args[0].strip()
        print(f"명령어(인자): {user_request}")
    else:
        user_request = input("명령어 입력: ").strip()
    if not user_request:
        print("프롬프트가 비어 있습니다.")
        return

    print(f"입력 영상: {video_paths}")

    checkpointer = MemorySaver()
    app = build_graph(checkpointer=checkpointer)

    initial: AgentState = {
        "user_request": user_request,
        "video_paths": video_paths,
        "video_context": None,
        "execution_trace": [],
        "script_revision": 0,
        "spawn_depth": 0,
        "session_id": THREAD_ID,
    }

    print("\n=== 파이프라인 시작 ===")

    stream_input = initial
    while True:
        interrupted = False
        for chunk in app.stream(stream_input, config=CONFIG, stream_mode="updates"):
            print_chunk(chunk)
            if "__interrupt__" in chunk:
                interrupted = True
        if not interrupted:
            break

        if auto_approve:
            print("\n[--auto] 계획 자동 승인")
            answer = ""
        else:
            answer = input("\n이 계획으로 진행할까요? (엔터=승인 / 수정할 내용 입력): ").strip()
        if answer:
            stream_input = Command(resume={"approved": False, "feedback": answer})
        else:
            stream_input = Command(resume={"approved": True})

    print("\n=== 파이프라인 종료 ===")


if __name__ == "__main__":
    main()
